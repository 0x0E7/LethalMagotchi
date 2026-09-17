using System.Threading.Tasks;

namespace LethalMagotchi.Auth
{
    /// <summary>
    /// Where the refresh token lives on a native client. §14.3 states the one rule every
    /// implementation of this interface exists to satisfy:
    /// <b>never <c>PlayerPrefs</c></b> — it is a plaintext XML file on Android and an
    /// unprotected plist on iOS, so a 30-day refresh token kept there is a 30-day account
    /// takeover for anything that can read the filesystem. That is the single easiest
    /// catastrophic mistake available in this workstream, which is why it is named here
    /// rather than left to code review to catch.
    ///
    /// <see cref="Save"/> and <see cref="Load"/> are synchronous by design — both platform
    /// stores below resolve on the calling thread with no I/O wait worth awaiting, and a
    /// synchronous contract is what lets <see cref="NativeAuthGateway"/>'s single-flight
    /// guard persist the successor token before it releases its semaphore (§14.5) without a
    /// second await point that could interleave with another caller.
    /// </summary>
    public interface ISecureStore
    {
        void Save(string refreshToken);
        string Load();
        void Clear();
    }

    /// <summary>
    /// Used until a platform store is wired in (Editor play-mode, and any platform this
    /// project hasn't shipped a keystore implementation for yet). Deliberately in-memory, not
    /// a <c>PlayerPrefs</c> fallback — an insecure-by-default fallback is exactly the footgun
    /// §14.3 warns about, so the safe failure mode here is "the session doesn't persist across
    /// a restart", never "the token sits in a world-readable file".
    /// </summary>
    public sealed class InMemorySecureStore : ISecureStore
    {
        private string _token;

        public void Save(string refreshToken) => _token = refreshToken;
        public string Load() => _token;
        public void Clear() => _token = null;
    }
}
