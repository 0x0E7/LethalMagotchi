#if UNITY_WEBGL && !UNITY_EDITOR
using System;
using System.Threading.Tasks;
using UnityEngine;

namespace LethalMagotchi.Auth
{
    /// <summary>
    /// Unity WebGL's <see cref="IAuthGateway"/> — the build that is "neither platform" per
    /// §14.4. The React page shell owns the session; this class owns none of it. It starts
    /// already authenticated (constructed with the bearer token the page handed over at boot,
    /// via <see cref="AdoptBridgedToken"/>), and every method that would touch a refresh token
    /// on native instead round-trips through <see cref="LMAuthBridgeReceiver"/> and asks the
    /// page.
    ///
    /// <see cref="RegisterAsync"/> and <see cref="LoginAsync"/> deliberately throw —
    /// <c>v2-architecture.md</c> §14.1's own decision is that login stays in React on web, so
    /// there is no "sign in from inside the WebGL canvas" flow to implement; a call here would
    /// be a bug in the calling screen, not a runtime condition to handle gracefully.
    /// </summary>
    public sealed class BridgeAuthGateway : IAuthGateway
    {
        private string _accessToken;

        // The same single-flight guard NativeAuthGateway runs, for the same §14.5 reason.
        // IAuthGateway.RefreshAsync's own contract says "safe to call concurrently with itself...
        // BOTH platforms serialize through the same single-flight guard" — and this
        // implementation did not, which made that sentence false on WebGL. The concrete failure:
        // a page resuming from a background tab fires several requests at once, all 401, all
        // calling RefreshAsync, each sending its own requestId over the bridge. The page then
        // performs N real refreshes against a server whose refresh tokens are single-use, so
        // N-1 of them get a genuine 401 back and the player is signed out mid-session — exactly
        // the outcome §14.5 exists to prevent, arriving on the one platform whose gateway was
        // not guarded.
        private readonly System.Threading.SemaphoreSlim _refreshGate = new(1, 1);
        private Task _inFlightRefresh;

        public string CurrentAccessToken => _accessToken;
        public bool HasSession => _accessToken != null;
        public event Action SessionExpired;

        /// <summary>Called once, at startup, with the bearer token the page passed over the
        /// bridge — the §9/§14.4 contract, unchanged from the pre-mobile design.</summary>
        public void AdoptBridgedToken(string accessToken)
        {
            _accessToken = accessToken;
        }

        public Task<SessionResponseV2> RegisterAsync(string username, string password) =>
            throw new NotSupportedException("WebGL login stays in the page shell — see v2-architecture.md §14.1/§14.4.");

        public Task<SessionResponseV2> LoginAsync(string username, string password) =>
            throw new NotSupportedException("WebGL login stays in the page shell — see v2-architecture.md §14.1/§14.4.");

        /// <summary>There is no "restore" here distinct from ordinary startup — the page
        /// either hands Unity a token via <see cref="AdoptBridgedToken"/> before this build
        /// starts caring, or it doesn't load the canvas at all. Always returns null; the
        /// caller's boot flow branches on the bridge handoff instead of on this method for
        /// this platform. Kept on the interface rather than special-cased by callers, so
        /// <c>Boot.unity</c> can run one code path across all three targets.</summary>
        public Task<SessionResponseV2> TryRestoreSessionAsync() => Task.FromResult<SessionResponseV2>(null);

        public async Task RefreshAsync()
        {
            Task task;
            TaskCompletionSource<bool> owned = null;

            await _refreshGate.WaitAsync();
            try
            {
                if (_inFlightRefresh != null)
                {
                    task = _inFlightRefresh;
                }
                else
                {
                    // Published before the work starts, for the same ordering reason spelled out
                    // in NativeAuthGateway.StartOrJoinRefreshAsync: assigning the result of an
                    // async call to the field can complete-and-clear before the assignment lands.
                    owned = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                    _inFlightRefresh = owned.Task;
                    task = owned.Task;
                }
            }
            finally
            {
                _refreshGate.Release();
            }

            if (owned != null) _ = RunOwnedRefreshAsync(owned);

            await task;
        }

        private async Task RunOwnedRefreshAsync(TaskCompletionSource<bool> completion)
        {
            var requestId = Guid.NewGuid().ToString("N");
            try
            {
                _accessToken = await LMAuthBridgeReceiver.RequestAccessTokenAsync(requestId);
                _inFlightRefresh = null;
                completion.TrySetResult(true);
            }
            catch (Exception ex)
            {
                // The page's own refresh failed, or no page shell answered at all — either
                // way this session is over; the page is the one place that could have fixed
                // it, and it already tried.
                _accessToken = null;
                _inFlightRefresh = null;
                // Fired once per refresh, not once per caller: five requests that all 401 at the
                // same moment are one expiry event, and a listener that navigates to the login
                // screen must not be told about it five times.
                SessionExpired?.Invoke();
                completion.TrySetException(ex);
            }
        }

        /// <summary>Clears this build's copy of the token only. The page shell owns the real
        /// session and its own logout button; this build has no refresh token to revoke and
        /// no server call to make on this platform (§14.4).</summary>
        public Task LogoutAsync()
        {
            _accessToken = null;
            return Task.CompletedTask;
        }
    }
}
#endif
