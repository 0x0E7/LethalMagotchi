using System;
using System.Threading.Tasks;

namespace LethalMagotchi.Auth
{
    /// <summary>
    /// The one seam between "how does this build get and keep a session" and everything else.
    /// Two implementations, per §14.4's actual platform split (which is not "web vs. mobile" —
    /// it is "who owns the session"):
    /// <list type="bullet">
    /// <item><see cref="NativeAuthGateway"/> — iOS/Android. Owns the session: calls the v2
    /// endpoints directly, holds the refresh token in <see cref="ISecureStore"/>, runs the
    /// single-flight refresh mutex (§14.5).</item>
    /// <item><see cref="BridgeAuthGateway"/> — Unity WebGL. Owns nothing: the React page
    /// shell signs in and hands this gateway a bearer access token over the JS bridge; on a
    /// 401 it asks the page for a fresh one rather than holding or refreshing anything itself
    /// (§14.4 — WebGL never sees a refresh token, and has nowhere safe to put one if it did).
    /// </item>
    /// </list>
    /// Every screen above this interface — <see cref="AuthService"/> included — is written
    /// against <see cref="IAuthGateway"/> only. <c>#if UNITY_WEBGL</c> should never appear
    /// above this line; it is meant to appear exactly once, in whatever bootstrap code
    /// chooses which implementation to construct.
    /// </summary>
    public interface IAuthGateway
    {
        /// <summary>Null until a session exists. Read by <see cref="AuthenticatedHttp"/> on
        /// every gameplay request; never persisted by the gateway itself — access tokens are
        /// intentionally memory-only on both platforms (§14.3).</summary>
        string CurrentAccessToken { get; }

        bool HasSession { get; }

        /// <summary>Fired whenever the session ends for a reason the caller didn't just ask
        /// for — a rejected stored token on boot, a failed refresh, a server-side revocation.
        /// A deliberate <see cref="LogoutAsync"/> does not fire this; the caller already knows.</summary>
        event Action SessionExpired;

        Task<SessionResponseV2> RegisterAsync(string username, string password);
        Task<SessionResponseV2> LoginAsync(string username, string password);

        /// <summary>Restores a session from whatever this platform persisted, if any. Called
        /// once at boot. Returns null rather than throwing when there is nothing to restore —
        /// "no prior session" is the ordinary first-run case, not a failure.</summary>
        Task<SessionResponseV2> TryRestoreSessionAsync();

        /// <summary>Forces a refresh now rather than waiting for a 401, e.g. on
        /// <c>Application.focusChanged</c> resume (§14.9) — the moment a token is most likely
        /// stale. Safe to call concurrently with itself or with the internal refresh a 401
        /// triggers; both platforms serialize through the same single-flight guard.</summary>
        Task RefreshAsync();

        Task LogoutAsync();
    }
}
