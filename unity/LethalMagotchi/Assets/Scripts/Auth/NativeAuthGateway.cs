using System;
using System.Threading.Tasks;

namespace LethalMagotchi.Auth
{
    /// <summary>
    /// iOS/Android's <see cref="IAuthGateway"/>: this build owns the session outright, holding
    /// the refresh token in <see cref="ISecureStore"/> and calling the v2 endpoints directly.
    /// The whole class exists to get one thing right — §14.5's refresh race:
    ///
    /// <para>"A mobile app resuming from background is the worst case for this. The socket
    /// reconnects, the character refetches, and the pet state syncs — three requests firing at
    /// once, all with the same expired access token, all getting 401, all racing to refresh.
    /// Without a mutex, one wins and two get a hard logout with a valid, unexpired session."</para>
    ///
    /// <see cref="RefreshAsync"/> is safe to call concurrently with itself any number of times:
    /// exactly one network round-trip happens, every caller awaits its result, and the
    /// successor token is written to the secure store before any of them see it (so a crash
    /// between "server rotated the token" and "we finished telling the app about it" can never
    /// leave this device holding a token the server has already revoked).
    /// </summary>
    public sealed class NativeAuthGateway : IAuthGateway
    {
        private readonly ApiClient _api;
        private readonly ISecureStore _store;

        // The single-flight guard (§14.5). A short-held semaphore decides who *starts* a
        // refresh and publishes the shared Task; every caller — including the one that
        // started it — then awaits that Task outside the semaphore, so the network call
        // itself never holds the gate. See RefreshAndGetTokenAsync for why it is structured
        // this way rather than holding the semaphore for the call's whole duration.
        private readonly System.Threading.SemaphoreSlim _refreshGate = new(1, 1);
        private volatile Task<string> _inFlightRefresh;

        private string _accessToken;

        public string CurrentAccessToken => _accessToken;
        public bool HasSession => _accessToken != null;
        public event Action SessionExpired;

        public NativeAuthGateway(ApiClient api, ISecureStore store)
        {
            _api = api ?? throw new ArgumentNullException(nameof(api));
            _store = store ?? throw new ArgumentNullException(nameof(store));
        }

        public async Task<SessionResponseV2> RegisterAsync(string username, string password)
        {
            var session = await _api.RegisterAsync(username, password);
            AdoptSession(session);
            return session;
        }

        public async Task<SessionResponseV2> LoginAsync(string username, string password)
        {
            var session = await _api.LoginAsync(username, password);
            AdoptSession(session);
            return session;
        }

        public async Task<SessionResponseV2> TryRestoreSessionAsync()
        {
            var stored = _store.Load();
            if (string.IsNullOrEmpty(stored)) return null;

            string accessToken;
            try
            {
                accessToken = await RefreshAndGetTokenAsync(stored);
            }
            catch (ApiException ex) when (ex.Code == ApiErrorCode.Unauthorized)
            {
                // §14.9's named trap: the Keychain survives an uninstall, so a fresh install
                // can find a token belonging to a session that no longer exists server-side
                // (expired, or already rotated by a device that logged out). That is an
                // ordinary "you are not signed in" outcome, never an error to surface.
                _store.Clear();
                return null;
            }

            var me = await _api.GetMeAsync(accessToken);
            return new SessionResponseV2
            {
                AccessToken = accessToken,
                ExpiresInSeconds = 0, // not re-derived here; the caller already has a fresh token
                Account = me.Account,
                Character = me.Character,
                RefreshToken = _store.Load(),
            };
        }

        public async Task RefreshAsync()
        {
            var stored = _store.Load();
            if (string.IsNullOrEmpty(stored))
            {
                RaiseSessionExpired();
                throw new InvalidOperationException("No session to refresh.");
            }

            try
            {
                await RefreshAndGetTokenAsync(stored);
            }
            catch (ApiException ex) when (ex.Code == ApiErrorCode.Unauthorized)
            {
                SignOutLocally();
                RaiseSessionExpired();
                throw;
            }
        }

        public async Task LogoutAsync()
        {
            var stored = _store.Load();
            SignOutLocally();
            if (!string.IsNullOrEmpty(stored))
            {
                try { await _api.LogoutAsync(stored); }
                catch (ApiException)
                {
                    // Local state is already cleared regardless — matching v1's own logout,
                    // which "succeeds even with no session, so a stuck client can always clear
                    // itself." A server round-trip failing here must not block that.
                }
            }
        }

        /// <summary>The single-flight entry point. Returns the fresh access token, whether
        /// this call actually performed the network refresh or simply awaited someone else's.</summary>
        private Task<string> RefreshAndGetTokenAsync(string presentedToken)
        {
            var existing = _inFlightRefresh;
            if (existing != null) return existing;
            return StartOrJoinRefreshAsync(presentedToken);
        }

        private async Task<string> StartOrJoinRefreshAsync(string presentedToken)
        {
            Task<string> task;
            TaskCompletionSource<string> owned = null;

            await _refreshGate.WaitAsync();
            try
            {
                // Re-checked after acquiring the gate (§14.5): another caller may have raced
                // us between the field read above and acquiring this semaphore, and may have
                // already started — or even finished — a refresh in that window.
                var existing = _inFlightRefresh;
                if (existing != null)
                {
                    task = existing;
                }
                else
                {
                    // A TaskCompletionSource published here, with the actual work started only
                    // AFTER the gate is released, rather than `_inFlightRefresh = PerformRefreshAsync(...)`.
                    // That earlier form had an ordering hazard that is invisible in review: an
                    // `async` method runs synchronously up to its first *incomplete* await, so if
                    // the refresh ever finished without suspending, PerformRefreshAsync's own
                    // `finally` cleared `_inFlightRefresh` BEFORE this assignment wrote to it —
                    // leaving a finished Task cached in the field forever. Every later refresh
                    // then returned that stale Task: no network call, no token rotation, and (if
                    // the cached Task was a faulted one) the same old error rethrown for the rest
                    // of the process's life, with the session quietly dying at expiry. Publishing
                    // a TCS first makes the ordering unconditional: the field is always set before
                    // anything can possibly complete and clear it.
                    owned = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
                    _inFlightRefresh = owned.Task;
                    task = owned.Task;
                }
            }
            finally
            {
                _refreshGate.Release();
            }

            if (owned != null) _ = RunOwnedRefreshAsync(presentedToken, owned);

            return await task;
        }

        private async Task RunOwnedRefreshAsync(string presentedToken, TaskCompletionSource<string> completion)
        {
            try
            {
                var token = await PerformRefreshAsync(presentedToken);
                completion.TrySetResult(token);
            }
            catch (Exception ex)
            {
                // Faults reach every joined caller through the shared Task, exactly as they would
                // have if each had made its own call — one failure, reported N times, not N
                // failures.
                completion.TrySetException(ex);
            }
        }

        private async Task<string> PerformRefreshAsync(string presentedToken)
        {
            try
            {
                var result = await _api.RefreshAsync(presentedToken);

                // Persisted before this method returns — the load-bearing ordering from
                // §14.5: a crash on the next line must never leave the app holding, only in
                // memory, a token the server has already revoked by rotating it.
                _store.Save(result.RefreshToken);
                _accessToken = result.AccessToken;
                return _accessToken;
            }
            finally
            {
                // Cleared so the *next* refresh — a genuinely new one, arriving after this is
                // fully done — starts fresh rather than awaiting an already-completed Task
                // forever. Ordering is now safe unconditionally: this runs strictly before
                // RunOwnedRefreshAsync completes the TaskCompletionSource, which is the only
                // thing any joined caller is waiting on, and the field it clears was published
                // before this method was ever invoked.
                _inFlightRefresh = null;
            }
        }

        private void AdoptSession(SessionResponseV2 session)
        {
            _accessToken = session.AccessToken;
            _store.Save(session.RefreshToken);
        }

        private void SignOutLocally()
        {
            _accessToken = null;
            _store.Clear();
        }

        private void RaiseSessionExpired() => SessionExpired?.Invoke();
    }
}
