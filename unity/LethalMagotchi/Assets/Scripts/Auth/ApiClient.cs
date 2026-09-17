using System;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json;
using UnityEngine.Networking;

namespace LethalMagotchi.Auth
{
    /// <summary>Every path this assembly calls, named once so a server-side rename is a
    /// one-line fix rather than a grep across every call site. <c>V2</c> paths are new and
    /// additive; <c>UsernameAvailable</c> deliberately still points at the v1 route — that
    /// endpoint touches no cookie and no token, so <c>v2-architecture.md</c> §14.3 explicitly
    /// does not duplicate it (see the note on <c>routes/auth-v2.ts</c>).</summary>
    internal static class ApiRoutes
    {
        public const string Register = "/api/v2/auth/register";
        public const string Login = "/api/v2/auth/login";
        public const string Refresh = "/api/v2/auth/refresh";
        public const string Logout = "/api/v2/auth/logout";
        public const string UsernameAvailable = "/api/v1/auth/username-available";

        /// <summary>Bearer-authenticated, not cookie- or transport-specific — see the note on
        /// <see cref="MeResponse"/> for why this has no v2 duplicate either.</summary>
        public const string Me = "/api/v1/me";
    }

    /// <summary>
    /// The raw HTTP boundary for the v2 auth surface. No token storage, no retry policy, no
    /// mutex — those are <see cref="NativeAuthGateway"/>'s job. This class only knows how to
    /// turn one request into one typed result or one <see cref="ApiException"/>, which keeps
    /// it trivially reusable from both <see cref="NativeAuthGateway"/> and tests.
    /// </summary>
    /// <summary>The one <see cref="ApiClient"/> capability <see cref="AuthService"/> calls
    /// directly rather than through <see cref="IAuthGateway"/> (username availability is not
    /// a session operation — see the note on <see cref="ApiRoutes.UsernameAvailable"/>).
    /// Narrowed to an interface purely so <c>AuthServiceTests</c> can fake it: <see cref="ApiClient"/>
    /// itself stays a concrete, sealed, real-network class with no test seam of its own.</summary>
    public interface IUsernameAvailabilityApi
    {
        Task<UsernameAvailabilityResponse> CheckUsernameAsync(string username);
    }

    public sealed class ApiClient : IUsernameAvailabilityApi
    {
        private readonly ServerConfig _config;

        public ApiClient(ServerConfig config)
        {
            _config = config ?? throw new ArgumentNullException(nameof(config));
        }

        public Task<SessionResponseV2> RegisterAsync(string username, string password) =>
            PostJsonAsync<SessionResponseV2>(ApiRoutes.Register, new { username, password });

        public Task<SessionResponseV2> LoginAsync(string username, string password) =>
            PostJsonAsync<SessionResponseV2>(ApiRoutes.Login, new { username, password });

        public Task<RefreshResponseV2> RefreshAsync(string refreshToken) =>
            PostJsonAsync<RefreshResponseV2>(ApiRoutes.Refresh, new { refreshToken });

        public async Task LogoutAsync(string refreshToken)
        {
            await PostJsonNoContentAsync(ApiRoutes.Logout, new { refreshToken });
        }

        public async Task<UsernameAvailabilityResponse> CheckUsernameAsync(string username)
        {
            var url = _config.BaseUrl + ApiRoutes.UsernameAvailable + "?username=" + UnityWebRequest.EscapeURL(username);
            using var request = UnityWebRequest.Get(url);
            request.timeout = _config.RequestTimeoutSeconds;
            await request.SendWebRequest();
            return ParseResponse<UsernameAvailabilityResponse>(request);
        }

        /// <summary>Used only to complete a boot-time session restore — see the docstring on
        /// <see cref="MeResponse"/>. Ordinary in-game requests go through
        /// <c>AuthenticatedHttp</c>, not this method, because that class also owns the
        /// one-retry-on-401 policy this call deliberately does not need (a restore that gets a
        /// 401 here has already had its token freshly rotated by the caller).</summary>
        public async Task<MeResponse> GetMeAsync(string accessToken)
        {
            using var request = UnityWebRequest.Get(_config.BaseUrl + ApiRoutes.Me);
            request.timeout = _config.RequestTimeoutSeconds;
            request.SetRequestHeader("Authorization", "Bearer " + accessToken);
            await request.SendWebRequest();
            return ParseResponse<MeResponse>(request);
        }

        private async Task<T> PostJsonAsync<T>(string path, object body)
        {
            using var request = BuildJsonPost(path, body);
            await request.SendWebRequest();
            return ParseResponse<T>(request);
        }

        private async Task PostJsonNoContentAsync(string path, object body)
        {
            using var request = BuildJsonPost(path, body);
            await request.SendWebRequest();
            // Same parse-and-throw path as every other call, just discarding the (empty) body
            // on success — 204 routes still return the full ApiErrorBody shape on failure, and
            // that failure has to surface the same way it does everywhere else.
            if (IsError(request)) throw BuildException(request);
        }

        private UnityWebRequest BuildJsonPost(string path, object body)
        {
            var json = JsonConvert.SerializeObject(body);
            var bytes = Encoding.UTF8.GetBytes(json);
            var request = new UnityWebRequest(_config.BaseUrl + path, UnityWebRequest.kHttpVerbPOST)
            {
                uploadHandler = new UploadHandlerRaw(bytes),
                downloadHandler = new DownloadHandlerBuffer(),
                timeout = _config.RequestTimeoutSeconds,
            };
            request.SetRequestHeader("Content-Type", "application/json");
            return request;
        }

        private static bool IsError(UnityWebRequest request) =>
            request.result != UnityWebRequest.Result.Success;

        private T ParseResponse<T>(UnityWebRequest request)
        {
            if (IsError(request)) throw BuildException(request);

            var text = request.downloadHandler.text;
            try
            {
                return JsonConvert.DeserializeObject<T>(text);
            }
            catch (JsonException ex)
            {
                // A 200 with a body that doesn't parse is a contract break, not a user-facing
                // "try again" — surfaced distinctly from a transport error so it is loud in
                // logs rather than read as "the network is flaky today".
                throw new ApiException((int)request.responseCode, $"Malformed success response: {ex.Message}");
            }
        }

        private static ApiException BuildException(UnityWebRequest request)
        {
            var statusCode = (int)request.responseCode;

            // A genuine transport failure (no connection, DNS, TLS) never reaches the server
            // at all, so there is no ApiErrorBody to parse — responseCode is 0 in that case.
            if (request.result is UnityWebRequest.Result.ConnectionError or UnityWebRequest.Result.DataProcessingError)
            {
                return new ApiException(statusCode, request.error ?? "Could not reach the server.");
            }

            var text = request.downloadHandler != null ? request.downloadHandler.text : null;
            try
            {
                var body = string.IsNullOrEmpty(text) ? null : JsonConvert.DeserializeObject<ApiErrorBody>(text);
                if (body?.Error != null) return new ApiException(statusCode, body.Error);
            }
            catch (JsonException)
            {
                // Fall through — an error status whose body isn't the expected shape (a proxy
                // 502 page, say) still has to become an exception, just without a server code.
            }

            return new ApiException(statusCode, request.error ?? $"Request failed with status {statusCode}.");
        }
    }
}
