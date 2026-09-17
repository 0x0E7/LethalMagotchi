using System;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json;
using UnityEngine.Networking;

namespace LethalMagotchi.Auth
{
    /// <summary>
    /// §14.9: "the one place that attaches the bearer and handles exactly one 401 retry."
    /// Every gameplay request (character, actions, chat, duels — whatever lands once those
    /// screens exist) goes through this class rather than building its own
    /// <c>UnityWebRequest</c>, so the retry policy is enforced once instead of being
    /// reimplemented, forgotten, or subtly duplicated per screen.
    ///
    /// The policy itself is exactly what §14.5 warns against re-deriving ad hoc: on a 401,
    /// call <see cref="IAuthGateway.RefreshAsync"/> (which is itself single-flight-safe, so
    /// ten simultaneous 401s from ten simultaneous requests still cost one network refresh),
    /// then retry the original request <b>once</b>. A second 401 after a fresh token is a real
    /// rejection — the session is gone — not something to retry again.
    /// </summary>
    public sealed class AuthenticatedHttp
    {
        private readonly IAuthGateway _gateway;
        private readonly ServerConfig _config;

        public AuthenticatedHttp(IAuthGateway gateway, ServerConfig config)
        {
            _gateway = gateway ?? throw new ArgumentNullException(nameof(gateway));
            _config = config ?? throw new ArgumentNullException(nameof(config));
        }

        public Task<T> GetAsync<T>(string path) => SendAsync<T>(UnityWebRequest.kHttpVerbGET, path, null);

        public Task<T> PostAsync<T>(string path, object body) => SendAsync<T>(UnityWebRequest.kHttpVerbPOST, path, body);

        private async Task<T> SendAsync<T>(string method, string path, object body)
        {
            var first = await SendOnceAsync(method, path, body);
            if (!IsUnauthorized(first))
            {
                return ParseOrThrow<T>(first); // disposes `first`
            }
            first.Dispose(); // not the final response — disposed here since ParseOrThrow won't run on it

            // Exactly one retry, per the class-level contract — RefreshAsync throwing here
            // (session genuinely gone) propagates straight out rather than being caught and
            // retried again.
            await _gateway.RefreshAsync();
            var second = await SendOnceAsync(method, path, body);
            return ParseOrThrow<T>(second);
        }

        private async Task<UnityWebRequest> SendOnceAsync(string method, string path, object body)
        {
            UnityWebRequest request;
            if (body != null)
            {
                var json = JsonConvert.SerializeObject(body);
                request = new UnityWebRequest(_config.BaseUrl + path, method)
                {
                    uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(json)),
                    downloadHandler = new DownloadHandlerBuffer(),
                };
                request.SetRequestHeader("Content-Type", "application/json");
            }
            else
            {
                request = new UnityWebRequest(_config.BaseUrl + path, method)
                {
                    downloadHandler = new DownloadHandlerBuffer(),
                };
            }

            try
            {
                request.timeout = _config.RequestTimeoutSeconds;
                var token = _gateway.CurrentAccessToken;
                if (!string.IsNullOrEmpty(token)) request.SetRequestHeader("Authorization", "Bearer " + token);

                await request.SendWebRequest();
                return request;
            }
            catch
            {
                // The success path hands ownership to the caller (which disposes via
                // ParseOrThrow, or explicitly on the 401 retry path). If we throw before
                // returning, nobody else ever sees this request — and UnityWebRequest holds
                // native memory that the GC does not reclaim for it.
                request.Dispose();
                throw;
            }
        }

        private static bool IsUnauthorized(UnityWebRequest response) => response.responseCode == 401;

        private static T ParseOrThrow<T>(UnityWebRequest response)
        {
            using (response)
            {
                if (response.result != UnityWebRequest.Result.Success)
                {
                    var text = response.downloadHandler?.text;
                    ApiErrorBody body = null;
                    try
                    {
                        if (!string.IsNullOrEmpty(text)) body = JsonConvert.DeserializeObject<ApiErrorBody>(text);
                    }
                    catch (JsonException)
                    {
                        // Falls through to the generic exception below.
                    }

                    if (body?.Error != null) throw new ApiException((int)response.responseCode, body.Error);
                    throw new ApiException((int)response.responseCode, response.error ?? "Request failed.");
                }

                return JsonConvert.DeserializeObject<T>(response.downloadHandler.text);
            }
        }
    }
}
