# v2 login — Unity project setup and verification status

This is the Unity/C# side of `v2-architecture.md` §14 (identity) and `v2-ui-ux.md` §2/§3.1
(the login screen), implementing §14.10's **A1 — Unity auth assembly** milestone. The server
side (§14.10's **A0**) is done and tested — `/api/v2/auth/*`, additive, v1's suite unmodified —
see `apps/server/src/routes/auth-v2.ts` and `apps/server/tests/integration/auth-v2.test.ts`.

## Read this first: what "written" means here

This file originally recorded that **no Unity Editor and no .NET SDK existed** where this code was
written — that everything under `unity/LethalMagotchi/Assets/` had been reasoned through line by
line but never compiled and never run. That was true when it was written. A later QA pass
installed a real .NET 8 SDK and built an out-of-Editor verification harness, so the status below
is now split into three honest tiers rather than one blanket warning.

### Tier 1 — verified by a real compiler and a real test run

A harness compiles the **real files in this repo** (not copies) against hand-written stand-ins for
the exact `UnityEngine` / `UnityEngine.Networking` / `UnityEngine.UIElements` API surface this
assembly calls, plus the real Newtonsoft.Json, and runs the real NUnit tests under `Tests/`.

- **Every `.cs` file under `Assets/Scripts/Auth/` and `Assets/Scripts/Auth/UI/` compiles clean**,
  including `LoginScreenController.cs`.
- The four platform-guarded files (`IosKeychainStore`, `AndroidKeystoreStore`,
  `BridgeAuthGateway`, `LMAuthBridgeReceiver`) are compiled **with their platform symbol defined**,
  so their `#if` bodies are actually handed to a compiler — for iOS, Android, WebGL-player and
  WebGL-in-Editor. Before that they had never been seen by any compiler at all.
- `Assets/Scripts/Auth/Tests/` **runs green** (35 tests), including new regression tests for every
  defect that QA pass found.
- The HTTP layer is additionally proved against a **real running dev server** over real sockets
  (register / login / `/me` / logout / rotation / concurrent refresh), and against a scripted
  transport for the failure modes a live server will not produce on demand (502 HTML error pages,
  connection failures, malformed 200 bodies).
- `LoginScreen.uxml`'s element names and types are **cross-checked executably** against the
  controller's `Q<T>("...")` lookups — a tree is built from the real `.uxml` and the real
  controller is bound against it, so a rename on either side fails a test.

### Tier 2 — manually reviewed, could not be executed here

- **Real UI Toolkit behaviour**: layout, focus, event propagation order, USS application,
  `UIDocument`'s real initialisation timing. The stub reproduces the *shape* of these APIs, never
  their implementation. The controller's lifecycle was corrected against documented `UIDocument`
  behaviour, but only the Editor can confirm it.
- **USS rendering.** Two selector bugs were found and fixed by review (a `>` combinator that could
  never match `ScrollView`'s content container, and a `:last-child` pseudo-class USS does not
  support), but nothing here has rendered a single pixel.
- **The iOS Keychain bridge (`LMKeychainBridge.mm`)** — a build-breaking wrong header import and
  several NULL-dereference crashes were found and fixed by review; no Xcode has compiled it.
- **The Android JNI call chain and the Gradle dependency** — a field-accessed-as-a-method bug, JNI
  reference leaks, and an AGP 8 manifest incompatibility were found and fixed by review; no
  Android build has run.
- **The WebGL page bridge** end to end, which additionally depends on an `apps/client` contract
  that does not exist in this repo yet.

**Budget real device/Editor time for everything in Tier 2 before trusting it.** "A careful reviewer
found four bugs in this file" is a reason to expect a fifth, not a reason to relax.

### Tier 3 — genuinely unverifiable without the Editor or a device

Scene/prefab wiring, `.meta`/GUID generation, `PanelSettings`, on-device Keychain and Keystore
behaviour, and the real page-side WebGL handoff. See "Why no `.asset`/`.unity` files are checked
in" below.

None of this is a reason to distrust the *design* — every behavioural decision here traces to
`v2-architecture.md` §14 or `v2-ui-ux.md` §2/§3.1 and is cited at its call site.

## First-time Editor setup

1. Open `unity/LethalMagotchi/` in Unity Hub. It targets Unity 6000.0 LTS
   (`ProjectSettings/ProjectVersion.txt` pins `6000.0.35f1` — bump to whatever 6000.0.x patch is
   current; the exact patch was not something this environment could verify against a live
   release list).
2. Let Unity import and resolve packages (`Packages/manifest.json`) — Newtonsoft.Json in
   particular. Read the Console for any resolution failure before doing anything else.
3. **Watch for compile errors** in the Console. Given the note above, do not be surprised to see
   some. `Assets/Scripts/Auth/` and `Assets/Scripts/Auth/UI/` are two small assemblies
   (`LethalMagotchi.Auth`, `LethalMagotchi.Auth.UI`) specifically so a compile error is easy to
   isolate to one of them.
4. **Run the EditMode tests**: Window → General → Test Runner → EditMode → Run All. Everything
   under `Assets/Scripts/Auth/Tests/` should go green with no real Unity dependency (they use
   `FakeAuthGateway`/`FakeUsernameApi`, no network, no scene). This is the single highest-value
   first check.
5. Create a `ServerConfig` asset: Assets → Create → LethalMagotchi → Server Config. Point
   `Base Url` at a running server — `http://localhost:8080` for `npm run dev` against this same
   repo (see the main repo's own README for that). **This step cannot be done for you in text** —
   see "Why no `.asset`/`.unity` files are checked in" below.
6. Build the login scene (also manual — same reason):
   - New Scene, save as `Assets/Scenes/Auth.unity`.
   - Add a `UIDocument` GameObject. Create a `PanelSettings` asset (Assets → Create → UI
     Toolkit → Panel Settings Asset) and assign it. Assign `Assets/UI/Auth/LoginScreen.uxml` as
     the UIDocument's **Source Asset**.
   - Add `LoginScreenController` (from `LethalMagotchi.Auth.UI`) to the same GameObject. Assign
     the `ServerConfig` asset from step 5 in its inspector field.
   - (WebGL builds only) also add an empty GameObject **named exactly `LMAuthBridgeReceiver`**
     with an `LMAuthBridgeReceiver` component — see "WebGL" below for why the name is load-bearing.
     The component only appears in the Add Component list while the **build target is WebGL**
     (its `#if UNITY_WEBGL` guard deliberately does not exclude the Editor, precisely so this step
     is possible — see the comment at the top of `LMAuthBridgeReceiver.cs`). Switch platform first.
7. Enter Play Mode. You should see the login card. Try registering a throwaway account against a
   locally running server and confirm a 200 flows through to the `SignedIn` C# event (a
   `Debug.Log` in a listener is the fastest way to check, before any screen exists to render past
   this point).

## Why no `.asset`/`.unity` files are checked in

Unity's `.meta` files (one per asset, carrying that asset's GUID) are normally generated by the
Editor on first import and then committed alongside the asset. None exist yet here because
nothing has been imported. A `.unity` scene or a `ServerConfig.asset` instance would need to
reference other assets *by that GUID* — and inventing GUIDs by hand for files Unity has never
seen, then hoping they exactly match what a real import would produce, is a correctness risk with
no test able to catch it (a wrong GUID reference silently becomes a `None` field in the Inspector,
not an error). Scene/prefab wiring is genuinely interactive Editor work even for a human
developer — dragging a UXML onto a UIDocument's field is not meaningfully different work whether
a person or an AI got you to this point. Steps 5–6 above are that work, made as short as possible.

Everything that *is* checked in — every `.cs`, `.uxml`, `.uss`, `.asmdef`, `.jslib`, `.mm`, and the
two Android/Gradle files — needs no GUID and carries zero risk of this class of silent breakage.

## Platform notes

### Android
`AndroidKeystoreStore.cs` calls `androidx.security.crypto.EncryptedSharedPreferences` via
`AndroidJavaObject` reflection (no native plugin needed — these are ordinary AndroidX SDK
classes reachable through JNI). The dependency itself is declared in
`Assets/Plugins/Android/LethalMagotchiAuth.androidlib/build.gradle`, which Unity auto-merges into
the generated Gradle project — no Custom Gradle Template needed. **Verify this resolved** after
the first Android build by checking the build log for `androidx.security:security-crypto`, and
bump the version pin in that file if it's aged out by the time this is built.

### iOS
`IosKeychainStore.cs` calls into `Assets/Plugins/iOS/LMKeychainBridge.mm` via
`[DllImport("__Internal")]`. Unity compiles any `.mm`/`.m`/`.h` under `Assets/Plugins/iOS`
automatically as part of the generated Xcode project, and links `Security.framework`
automatically (Unity always links it). No manual Xcode step should be needed — but this is
genuinely the piece in this PR closest to "looks right, might not build," so budget a real device
build early rather than assuming it from the source alone.

### WebGL
`BridgeAuthGateway` calls `LMAuthBridgeReceiver.RequestAccessTokenAsync`, which calls the JS side
in `Assets/Plugins/WebGL/lm_auth_bridge.jslib`. That JS expects the **page** (the React shell in
`apps/client`, outside this Unity project — not yet written) to install
`window.LethalMagotchiBridge.requestFreshAccessToken(requestId)` and to call back via
`unityInstance.SendMessage('LMAuthBridgeReceiver', 'OnAccessTokenReceived', requestId + ':' + accessToken)`.
**`LMAuthBridgeReceiver` is a magic string** — the GameObject in the scene must be named exactly
that (step 6 above), because `SendMessage` addresses by name and there is no way to share a
constant across the TS/C# boundary. `LMAuthBridgeReceiver.GameObjectName` in C# is the source of
truth for that string; the page-side bridge code, when it's written, must reference it verbatim.
**This whole path is untested even by reasoning alone as thoroughly as the rest** — it depends on
a page-side contract that doesn't exist in this repo yet. Treat it as a sketch of the shape, to be
proven out together with whoever writes the `apps/client` bridge half.

## What's deliberately not here

Per `v2-architecture.md` §14.10's own ordering, this is **A1** only:
- **A2 — WebGL parity**: real end-to-end proof of the jslib bridge above, once the page-side
  `apps/client` contract exists to test it against.
- **A3 — user management**: recovery-email verification, password reset, account deletion
  (§14.7 — a hard App Store blocker before any real store submission), device-session listing.
  None of these block sign-in working; A3 blocks *shipping*.
- **Character creation and the main screen** are the next planned workstream per the product
  owner's own sequencing (design → login → characters) and are untouched here.
- **The forgot-password button exists in the UI and logs a warning when tapped** rather than
  silently doing nothing or being missing — see `LoginScreenController.OnForgotPasswordClicked`.
