#if UNITY_ANDROID && !UNITY_EDITOR
using UnityEngine;

namespace LethalMagotchi.Auth
{
    /// <summary>
    /// Android's half of §14.3's "platform keystore" requirement: an
    /// <c>androidx.security.crypto.EncryptedSharedPreferences</c> file, keyed by a key stored
    /// in the Android Keystore (hardware-backed where the device supports it) rather than
    /// anything Unity itself holds. Called via <c>AndroidJavaObject</c> reflection — no native
    /// plugin needed, since these are ordinary AndroidX SDK classes reachable through JNI —
    /// but the <c>androidx.security:security-crypto</c> Gradle dependency it calls into does
    /// need to be present in the build; see
    /// <c>Assets/Plugins/Android/LethalMagotchiAuth.androidlib/build.gradle</c> and the
    /// Android section of <c>unity/SETUP.md</c>.
    /// </summary>
    public sealed class AndroidKeystoreStore : ISecureStore
    {
        private const string PrefsFileName = "lm_secure_auth";
        private const string RefreshTokenKey = "refresh_token";

        public void Save(string refreshToken)
        {
            // "Save nothing" is a delete. Beyond being the only sensible reading, passing a
            // managed null through AndroidJavaObject.Call is its own hazard: Unity derives the
            // JNI signature from each argument's runtime type, and a null has none — so a null
            // here is resolved as java.lang.Object and may not match putString(String, String).
            if (string.IsNullOrEmpty(refreshToken))
            {
                Clear();
                return;
            }

            using var prefs = OpenEncryptedPrefs();
            using var editor = prefs.Call<AndroidJavaObject>("edit");
            // putString returns the same Editor for chaining; the returned wrapper is still a
            // distinct JNI reference this side has to release, so it is disposed rather than
            // discarded.
            using (var _ = editor.Call<AndroidJavaObject>("putString", RefreshTokenKey, refreshToken)) { }
            // commit(), not apply(): §14.5 requires the successor persisted before the
            // single-flight guard releases, so this call must actually block until the write
            // has landed rather than merely being scheduled.
            editor.Call<bool>("commit");
        }

        public string Load()
        {
            using var prefs = OpenEncryptedPrefs();
            // An empty-string default rather than null, for the same signature-resolution reason
            // as Save above, then mapped back to null at this boundary — ISecureStore's contract
            // is "null when there is nothing stored", and every caller tests it with
            // string.IsNullOrEmpty anyway.
            var stored = prefs.Call<string>("getString", RefreshTokenKey, "");
            return string.IsNullOrEmpty(stored) ? null : stored;
        }

        public void Clear()
        {
            using var prefs = OpenEncryptedPrefs();
            using var editor = prefs.Call<AndroidJavaObject>("edit");
            using (var _ = editor.Call<AndroidJavaObject>("remove", RefreshTokenKey)) { }
            editor.Call<bool>("commit");
        }

        private static AndroidJavaObject OpenEncryptedPrefs()
        {
            using var unityPlayer = new AndroidJavaClass("com.unity3d.player.UnityPlayer");
            using var activity = unityPlayer.GetStatic<AndroidJavaObject>("currentActivity");
            using var context = activity.Call<AndroidJavaObject>("getApplicationContext");

            using var masterKeysClass = new AndroidJavaClass("androidx.security.crypto.MasterKeys");

            // GetStatic, not CallStatic. `MasterKeys.AES256_GCM_SPEC` is a
            // `public static final KeyGenParameterSpec` FIELD, not a method — and Unity's JNI
            // helpers resolve the two through entirely different paths, so asking for a field by
            // CallStatic does not "fall back", it throws AndroidJavaException (no such method)
            // on the first Save/Load/Clear on a real device. Nothing short of a device build can
            // catch this class of mistake, which is why every member access in this method is
            // annotated below with whether it is a field or a method.
            using var keyGenParameterSpec = masterKeysClass.GetStatic<AndroidJavaObject>("AES256_GCM_SPEC");

            // getOrCreate(KeyGenParameterSpec) -> String : a static METHOD.
            var masterKeyAlias = masterKeysClass.CallStatic<string>("getOrCreate", keyGenParameterSpec);

            using var encryptedPrefsClass =
                new AndroidJavaClass("androidx.security.crypto.EncryptedSharedPreferences");

            // Both schemes are Java enum CONSTANTS, i.e. static fields on the nested enum type.
            // Each AndroidJavaClass/AndroidJavaObject here holds a JNI global reference; they were
            // previously created inline and never disposed, leaking a handful of references on
            // every single Save/Load/Clear — and Load runs on every token refresh for the whole
            // life of the process.
            using var prefKeySchemeClass = new AndroidJavaClass(
                "androidx.security.crypto.EncryptedSharedPreferences$PrefKeyEncryptionScheme");
            using var prefKeyScheme = prefKeySchemeClass.GetStatic<AndroidJavaObject>("AES256_SIV");

            using var prefValueSchemeClass = new AndroidJavaClass(
                "androidx.security.crypto.EncryptedSharedPreferences$PrefValueEncryptionScheme");
            using var prefValueScheme = prefValueSchemeClass.GetStatic<AndroidJavaObject>("AES256_GCM");

            // create(String, String, Context, PrefKeyEncryptionScheme, PrefValueEncryptionScheme)
            // -> SharedPreferences : a static METHOD. Deprecated in security-crypto 1.1.x in
            // favour of the MasterKey overload, but still present and still the only overload
            // whose arguments are all things this call site can produce; see build.gradle's pin.
            return encryptedPrefsClass.CallStatic<AndroidJavaObject>(
                "create",
                PrefsFileName,
                masterKeyAlias,
                context,
                prefKeyScheme,
                prefValueScheme);
        }
    }
}
#endif
