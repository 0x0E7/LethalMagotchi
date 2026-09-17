#if UNITY_IOS && !UNITY_EDITOR
using System.Runtime.InteropServices;

namespace LethalMagotchi.Auth
{
    /// <summary>
    /// iOS's half of §14.3's "platform keystore" requirement. Unlike Android there is no
    /// JNI-equivalent reflection path to the Keychain from managed code, so this is a real,
    /// small native plugin — see <c>Assets/Plugins/iOS/LMKeychainBridge.mm</c> for the
    /// Objective-C side these externs call into. It stores under
    /// <c>kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly</c>: readable in the background
    /// (a socket reconnect or a push-triggered refresh must not require the device to be
    /// unlocked) but never synced to iCloud Keychain or backed up to another device — a
    /// refresh token is a bearer credential for this device's session, not portable data.
    ///
    /// §14.9 flags the one behavioural trap here worth restating: <b>the Keychain survives an
    /// uninstall.</b> A reinstalled app can find a stale token belonging to a session the
    /// player believes is long gone. <see cref="NativeAuthGateway"/> treats a stored token the
    /// server rejects as a clean logout, never as an error — see the comment on its boot-time
    /// restore path.
    /// </summary>
    public sealed class IosKeychainStore : ISecureStore
    {
        private const string Service = "com.lethalmagotchi.auth";
        private const string Account = "refresh_token";

        [DllImport("__Internal")]
        private static extern void LM_KeychainSave(string service, string account, string value);

        [DllImport("__Internal")]
        private static extern System.IntPtr LM_KeychainLoad(string service, string account);

        [DllImport("__Internal")]
        private static extern void LM_KeychainDelete(string service, string account);

        /// <summary>A null or empty token is a clear, not a store: marshaling null across the
        /// C ABI hands the native side a NULL <c>char*</c>, and "delete the credential" is the
        /// only sane reading of "save nothing" anyway. The native side guards too — see
        /// LMKeychainBridge.mm — because neither end of a C ABI gets to assume the other.</summary>
        public void Save(string refreshToken)
        {
            if (string.IsNullOrEmpty(refreshToken))
            {
                LM_KeychainDelete(Service, Account);
                return;
            }
            LM_KeychainSave(Service, Account, refreshToken);
        }

        public string Load()
        {
            var ptr = LM_KeychainLoad(Service, Account);
            if (ptr == System.IntPtr.Zero) return null;
            try
            {
                // PtrToStringUTF8, not PtrToStringAnsi: the native side encodes with
                // -UTF8String, so decoding it as the platform's "ANSI" encoding is only
                // accidentally correct. A refresh token is ASCII today, which is exactly what
                // makes the mismatch invisible until the day something upstream isn't.
                return Marshal.PtrToStringUTF8(ptr);
            }
            finally
            {
                // The native side hands back a C string it expects us to own from here — see
                // the matching `strdup` in LMKeychainBridge.mm and why FreeCoTaskMem is the
                // wrong free() for memory that wasn't allocated by the CLR. In a finally so a
                // decoding failure leaks nothing.
                Marshal.FreeHGlobal(ptr);
            }
        }

        public void Clear() => LM_KeychainDelete(Service, Account);
    }
}
#endif
