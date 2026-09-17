// `UNITY_WEBGL`, deliberately WITHOUT `&& !UNITY_EDITOR`, unlike every other platform file here.
//
// This is the one type in this assembly that has to be attached to a GameObject in a saved
// scene, because SendMessage addresses by GameObject name (see GameObjectName below). Scenes are
// authored and serialized by the EDITOR. A MonoBehaviour compiled out under UNITY_EDITOR does
// not exist while the Editor is running, so it can never be added to a scene in the first place
// — unity/SETUP.md's own step 6 ("add a GameObject named exactly LMAuthBridgeReceiver with an
// LMAuthBridgeReceiver component") was literally impossible to carry out, and the WebGL refresh
// path would have shipped dead with nothing to notice it: LM_RequestFreshAccessToken would call
// out to the page, the page would SendMessage back to a GameObject that does not exist, and the
// awaiting Task would simply never complete.
//
// The `__Internal` P/Invoke it needs is what genuinely cannot exist in the Editor, so that — and
// only that — is what the inner guard covers.
#if UNITY_WEBGL
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using UnityEngine;

namespace LethalMagotchi.Auth
{
    /// <summary>
    /// The WebGL half of §14.4's contract: "the page shell owns authentication... on a 401 it
    /// asks the page for a fresh token." <c>SendMessage</c> (the standard, documented way a
    /// Unity WebGL page calls back into the player) can only target a named GameObject and
    /// method, not an arbitrary C# object — so this receiver is that fixed target, and every
    /// other class talks to <see cref="BridgeAuthGateway"/> instead of knowing that.
    ///
    /// <b>Must exist in the scene under exactly this GameObject name</b> — see
    /// <see cref="GameObjectName"/>, which the page-side bridge code (outside this repo's
    /// Unity project; it lives in the React shell) must reference verbatim. There is
    /// deliberately no way to share that constant across the TS/C# boundary, so
    /// <c>unity/SETUP.md</c>'s WebGL section states it as the single source of truth in
    /// prose, and this comment is the other end of that same contract.
    /// </summary>
    public sealed class LMAuthBridgeReceiver : MonoBehaviour
    {
        public const string GameObjectName = "LMAuthBridgeReceiver";

        private static readonly ConcurrentDictionary<string, TaskCompletionSource<string>> Pending = new();

#if !UNITY_EDITOR
        [DllImport("__Internal")]
        private static extern void LM_RequestFreshAccessToken(string requestId);
#else
        /// <summary>
        /// Editor stand-in for the real jslib export. `__Internal` resolves to symbols linked
        /// into the player binary, which does not exist under the Editor — calling the real
        /// extern there throws <c>EntryPointNotFoundException</c>. Failing the request the same
        /// way a page with no bridge installed would means Play Mode with the WebGL target
        /// selected exercises the real "no page shell" path instead of crashing, which is the
        /// more useful thing to be able to try in the Editor anyway.
        /// </summary>
        private static void LM_RequestFreshAccessToken(string requestId)
        {
            Debug.LogWarning("[LMAuthBridgeReceiver] The page bridge does not exist in the Editor; " +
                             "failing this refresh as 'no page shell', which is what a raw WebGL " +
                             "build opened outside the app shell would also do.");
            if (Pending.TryRemove(requestId, out var tcs))
            {
                tcs.TrySetException(new ApiException(401, "No page shell available to refresh the session."));
            }
        }
#endif

        /// <summary>Called by <see cref="BridgeAuthGateway"/>. Resolves once the page calls
        /// back into <see cref="OnAccessTokenReceived"/> or <see cref="OnAccessTokenBridgeUnavailable"/>
        /// with the same <paramref name="requestId"/> — never any other way; there is no
        /// polling and no timeout coupled to a frame count, only this one round trip.</summary>
        public static Task<string> RequestAccessTokenAsync(string requestId)
        {
            var tcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            Pending[requestId] = tcs;
            LM_RequestFreshAccessToken(requestId);
            return tcs.Task;
        }

        /// <summary>Invoked via <c>unityInstance.SendMessage('LMAuthBridgeReceiver',
        /// 'OnAccessTokenReceived', payload)</c> from the page, where <c>payload</c> is
        /// <c>"{requestId}:{accessToken}"</c> — a single colon-joined string rather than JSON,
        /// deliberately: <c>SendMessage</c> takes one string argument, an access token is a
        /// JWT and therefore base64url (never contains a colon), so this needs no JSON parser
        /// on either side of the bridge for the one shape it ever carries.</summary>
        public void OnAccessTokenReceived(string payload)
        {
            if (string.IsNullOrEmpty(payload))
            {
                Debug.LogError("[LMAuthBridgeReceiver] empty payload — the page called back with nothing.");
                return;
            }

            var separatorIndex = payload.IndexOf(':');
            if (separatorIndex < 0)
            {
                Debug.LogError($"[LMAuthBridgeReceiver] malformed payload: {payload}");
                return;
            }
            var requestId = payload[..separatorIndex];
            var accessToken = payload[(separatorIndex + 1)..];
            if (Pending.TryRemove(requestId, out var tcs)) tcs.TrySetResult(accessToken);
        }

        /// <summary>Invoked the same way when no page-side handler exists (a raw WebGL build
        /// opened outside the app shell) or the page's own refresh failed — fails the waiting
        /// caller promptly instead of leaving it hanging forever with no page ever going to
        /// answer it.</summary>
        public void OnAccessTokenBridgeUnavailable(string requestId)
        {
            if (Pending.TryRemove(requestId, out var tcs))
            {
                tcs.TrySetException(new ApiException(401, "No page shell available to refresh the session."));
            }
        }
    }
}
#endif
