// The WebGL half of LMAuthBridgeReceiver.cs / §14.4. This file only calls out to the page —
// it never touches a token itself, which is the point: WebGL never stores a refresh token
// (v2-architecture.md §14.4), so there is nothing here to protect and nothing here that could
// leak one.
//
// Contract with the page shell (implemented in apps/client, outside this Unity project):
// window.LethalMagotchiBridge.requestFreshAccessToken(requestId) must exist before Unity ever
// calls LM_RequestFreshAccessToken, and must eventually call back with exactly one of:
//   unityInstance.SendMessage('LMAuthBridgeReceiver', 'OnAccessTokenReceived', requestId + ':' + accessToken)
//   unityInstance.SendMessage('LMAuthBridgeReceiver', 'OnAccessTokenBridgeUnavailable', requestId)
// See unity/SETUP.md "WebGL" for the page-side half of this and why the GameObject name is a
// magic string that has to match LMAuthBridgeReceiver.GameObjectName exactly.

mergeInto(LibraryManager.library, {
  LM_RequestFreshAccessToken: function (requestIdPtr) {
    var requestId = UTF8ToString(requestIdPtr);

    if (
      typeof window !== 'undefined' &&
      window.LethalMagotchiBridge &&
      typeof window.LethalMagotchiBridge.requestFreshAccessToken === 'function'
    ) {
      window.LethalMagotchiBridge.requestFreshAccessToken(requestId);
      return;
    }

    // No page shell installed the bridge — fail fast rather than leaving the C# caller waiting
    // on a request nothing will ever answer. That "fail fast" is the entire value of this
    // branch, so how SendMessage is resolved matters: the bare global is what the Unity loader
    // has historically exposed, but it is not a documented, guaranteed name inside a .jslib
    // (the public API is unityInstance.SendMessage, and the framework's own scope is subject to
    // minification). Falling back through Module and the global object costs nothing and is the
    // difference between "the refresh fails immediately" and "the C# Task hangs forever with no
    // error anywhere", which is the worst possible failure mode for this path.
    var send =
      (typeof SendMessage === 'function' && SendMessage) ||
      (typeof Module !== 'undefined' && typeof Module.SendMessage === 'function' && Module.SendMessage) ||
      (typeof window !== 'undefined' && typeof window.unityInstance !== 'undefined' &&
        typeof window.unityInstance.SendMessage === 'function' &&
        window.unityInstance.SendMessage.bind(window.unityInstance)) ||
      null;

    if (send) {
      send('LMAuthBridgeReceiver', 'OnAccessTokenBridgeUnavailable', requestId);
    } else {
      // Nothing left to try. Loud rather than silent: a hung refresh with no console output is
      // hours of debugging, and this line is the only warning anyone will get.
      console.error(
        '[lm_auth_bridge] no SendMessage available — the C# side of refresh request ' +
          requestId +
          ' will never be answered. Verify the Unity WebGL loader has booted before this call.'
      );
    }
  },
});
