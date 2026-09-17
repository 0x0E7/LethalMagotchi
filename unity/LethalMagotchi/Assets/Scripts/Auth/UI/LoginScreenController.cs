using System;
using UnityEngine;
using UnityEngine.UIElements;
using LethalMagotchi.Auth;

namespace LethalMagotchi.Auth.UI
{
    /// <summary>
    /// Binds <see cref="LoginScreen.uxml"/> to <see cref="AuthService"/>. Deliberately thin:
    /// every rule about *what* the screen does lives in <see cref="AuthService"/> (testable
    /// without a UI at all); this class only knows how to read a
    /// <see cref="LoginFormState"/> onto UI Toolkit elements and forward UI events back as
    /// method calls. If a designer wants a value changed here, it's a layout/USS change; if
    /// they want behaviour changed, it's an <see cref="AuthService"/> change — that split is
    /// the point of keeping them separate.
    /// </summary>
    [RequireComponent(typeof(UIDocument))]
    public sealed class LoginScreenController : MonoBehaviour
    {
        [SerializeField] private ServerConfig serverConfig;

        private AuthService _service;
        private LoginFormState _lastRendered;

        private VisualElement _root;
        private Button _segmentLogin;
        private Button _segmentRegister;
        private Label _banner;
        private TextField _usernameInput;
        private Label _usernameHint;
        private VisualElement _usernameSuggestions;
        private TextField _passwordInput;
        private Button _passwordShow;
        private Label _passwordHint;
        private VisualElement _strengthMeter;
        private Button _forgotPassword;
        private VisualElement _recoveryEmailField;
        private TextField _recoveryEmailInput;
        private Button _submitButton;
        // No `_modeSwapFooter` field: `mode-swap-footer` exists in the UXML as a placeholder for
        // §3.1's desktop-only mode-swap line and is hidden by USS. It was previously bound here
        // and then never read, while the UXML and USS comments both claimed this controller
        // showed it on desktop builds — a claim no code backed. Those comments now say what is
        // actually true; when the desktop breakpoint work lands, the binding comes back with it.

        // §3.1's load-bearing interaction: the header band collapses on keyboard-open rather
        // than the card re-laying-out, because a layout change under a focused TextField is
        // exactly what drops focus in UI Toolkit (§6.3). Polled once a frame rather than
        // event-driven — TouchScreenKeyboard exposes no visibility-changed event.
        private VisualElement _headerBand;
        private bool _keyboardWasVisible;

        public event Action<SessionResponseV2> SignedIn;

        /// <summary>
        /// Binding happens here rather than in <c>Awake</c>, and happens again on every enable,
        /// for three reasons that all point the same way:
        /// <list type="number">
        /// <item><c>UIDocument</c> builds <c>rootVisualElement</c> in its own <c>OnEnable</c>.
        /// Unity runs every component's <c>Awake</c> before any component's <c>OnEnable</c>, so a
        /// bind in <c>Awake</c> reads a root that does not exist yet.</item>
        /// <item><c>UIDocument</c> rebuilds that tree from the source asset each time it is
        /// enabled. Elements captured once, on first bind, are orphaned after any
        /// disable/enable cycle — the screen would render to a tree nobody is looking at while
        /// the visible one responded to nothing.</item>
        /// <item>Re-wiring onto freshly built elements is what stops handlers accumulating.
        /// The previous shape wired on every enable but bound only once, so a second enable
        /// left two click handlers on the same button — one tap, two login requests.</item>
        /// </list>
        /// </summary>
        private void OnEnable()
        {
            var document = GetComponent<UIDocument>();
            _root = document != null ? document.rootVisualElement : null;
            if (_root == null)
            {
                Debug.LogError("[LoginScreenController] UIDocument has no rootVisualElement — " +
                               "is a Source Asset assigned? See unity/SETUP.md step 6.");
                return;
            }

            if (serverConfig == null)
            {
                Debug.LogError("[LoginScreenController] No ServerConfig assigned — cannot construct AuthService.");
                return;
            }

            BindElements();

            var api = new ApiClient(serverConfig);
            IAuthGateway gateway = CreateGatewayForPlatform(api);
            _service = new AuthService(api, gateway);
            _service.StateChanged += Render;
            _service.SignedIn += OnServiceSignedIn;

            WireEvents();

            // Reset so the one-shot 401 focus transition in Render is judged against this
            // screen's own history, not against whatever was on screen before it was disabled.
            _lastRendered = null;
            Render(_service.CurrentState);
        }

        private void OnDisable()
        {
            UnwireEvents();

            if (_service == null) return;
            _service.StateChanged -= Render;
            _service.SignedIn -= OnServiceSignedIn;
            _service.Dispose();
            _service = null;
        }

        private void OnServiceSignedIn(SessionResponseV2 session) => SignedIn?.Invoke(session);

        private void Update()
        {
            // Deliberately cheap: a bool compare and, on the rare frame it flips, one style
            // write. TouchScreenKeyboard.visible is only meaningful on device — always false
            // in-Editor and on desktop, so this is a correct no-op there.
            var visible = TouchScreenKeyboard.visible;
            if (visible == _keyboardWasVisible) return;
            _keyboardWasVisible = visible;
            SetKeyboardOpen(visible);
        }

        /// <summary>
        /// §14.4's one compile-time seam: everywhere else in this assembly is written against
        /// <see cref="IAuthGateway"/> only. WebGL additionally needs the page's handed-over
        /// bearer token, which this project's bootstrap (not this screen) is responsible for
        /// supplying — see unity/SETUP.md "WebGL" for exactly where that handoff happens.
        /// </summary>
        private IAuthGateway CreateGatewayForPlatform(ApiClient api)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            return new BridgeAuthGateway();
#elif UNITY_IOS && !UNITY_EDITOR
            return new NativeAuthGateway(api, new IosKeychainStore());
#elif UNITY_ANDROID && !UNITY_EDITOR
            return new NativeAuthGateway(api, new AndroidKeystoreStore());
#else
            // Editor play-mode and any platform without a shipped store yet: correct and safe
            // (never PlayerPrefs — see ISecureStore's docstring), just not persistent across
            // restarts. That is the honest limitation, not a silently wrong one.
            return new NativeAuthGateway(api, new InMemorySecureStore());
#endif
        }

        private void BindElements()
        {
            _headerBand = _root.Q<VisualElement>("header-band");
            _segmentLogin = _root.Q<Button>("segment-login");
            _segmentRegister = _root.Q<Button>("segment-register");
            _banner = _root.Q<Label>("banner");
            _usernameInput = _root.Q<TextField>("username-input");
            _usernameHint = _root.Q<Label>("username-hint");
            _usernameSuggestions = _root.Q<VisualElement>("username-suggestions");
            _passwordInput = _root.Q<TextField>("password-input");
            // Set explicitly rather than relying on the UXML `is-password` attribute name
            // resolving to TextField.isPasswordField across Editor versions — this is the one
            // place that ambiguity actually matters (a mask that silently fails to start
            // masked would show a typed password in plain text).
            _passwordInput.isPasswordField = true;
            _passwordShow = _root.Q<Button>("password-show");
            _passwordHint = _root.Q<Label>("password-hint");
            _strengthMeter = _root.Q<VisualElement>("strength-meter");
            _forgotPassword = _root.Q<Button>("forgot-password");
            _recoveryEmailField = _root.Q<VisualElement>("recovery-email-field");
            _recoveryEmailInput = _root.Q<TextField>("recovery-email-input");
            _submitButton = _root.Q<Button>("submit-button");
        }

        /// <summary>
        /// Every handler here is a named method rather than a lambda, specifically so
        /// <see cref="UnwireEvents"/> can remove the same delegate it added — a lambda produces a
        /// new delegate instance on each call, which <c>-=</c> silently fails to find. That is the
        /// quiet version of the handler-accumulation bug this pairing exists to prevent.
        /// </summary>
        private void WireEvents()
        {
            _segmentLogin.clicked += OnSegmentLoginClicked;
            _segmentRegister.clicked += OnSegmentRegisterClicked;

            _usernameInput.RegisterValueChangedCallback(OnUsernameValueChanged);
            _passwordInput.RegisterValueChangedCallback(OnPasswordValueChanged);
            _recoveryEmailInput.RegisterValueChangedCallback(OnRecoveryEmailValueChanged);

            _passwordShow.clicked += OnPasswordShowClicked;
            _submitButton.clicked += OnSubmitClicked;

            // Enter submits from either field — v1's own rule, carried forward per §7.1.
            _usernameInput.RegisterCallback<KeyDownEvent>(OnFieldKeyDown);
            _passwordInput.RegisterCallback<KeyDownEvent>(OnFieldKeyDown);

            _forgotPassword.clicked += OnForgotPasswordClicked;
        }

        private void UnwireEvents()
        {
            // Null-guarded because OnDisable also runs after an OnEnable that bailed out early
            // (no UIDocument root, or no ServerConfig assigned) and therefore never bound.
            if (_segmentLogin != null) _segmentLogin.clicked -= OnSegmentLoginClicked;
            if (_segmentRegister != null) _segmentRegister.clicked -= OnSegmentRegisterClicked;

            if (_usernameInput != null)
            {
                _usernameInput.UnregisterValueChangedCallback(OnUsernameValueChanged);
                _usernameInput.UnregisterCallback<KeyDownEvent>(OnFieldKeyDown);
            }
            if (_passwordInput != null)
            {
                _passwordInput.UnregisterValueChangedCallback(OnPasswordValueChanged);
                _passwordInput.UnregisterCallback<KeyDownEvent>(OnFieldKeyDown);
            }
            if (_recoveryEmailInput != null) _recoveryEmailInput.UnregisterValueChangedCallback(OnRecoveryEmailValueChanged);

            if (_passwordShow != null) _passwordShow.clicked -= OnPasswordShowClicked;
            if (_submitButton != null) _submitButton.clicked -= OnSubmitClicked;
            if (_forgotPassword != null) _forgotPassword.clicked -= OnForgotPasswordClicked;
        }

        private void OnSegmentLoginClicked() => _service?.SwitchMode(AuthMode.Login);
        private void OnSegmentRegisterClicked() => _service?.SwitchMode(AuthMode.Register);
        private void OnUsernameValueChanged(ChangeEvent<string> evt) => _service?.UsernameChanged(evt.newValue);
        private void OnPasswordValueChanged(ChangeEvent<string> evt) => _service?.PasswordChanged(evt.newValue);
        private void OnRecoveryEmailValueChanged(ChangeEvent<string> evt) => _service?.RecoveryEmailChanged(evt.newValue);

        private void OnPasswordShowClicked()
        {
            _passwordInput.isPasswordField = !_passwordInput.isPasswordField;
            _passwordShow.text = _passwordInput.isPasswordField ? "Show" : "Hide";
        }

        // The `?.` on every one of these is not defensive noise: a UI Toolkit element outlives
        // this component being disabled (the panel is UIDocument's, not ours), so a tap that was
        // already in flight when the screen was disabled would otherwise dereference a service
        // OnDisable has just dropped.
        private void OnSubmitClicked() => _ = _service?.SubmitAsync();

        private void OnFieldKeyDown(KeyDownEvent evt)
        {
            if (evt.keyCode is KeyCode.Return or KeyCode.KeypadEnter)
            {
                _ = _service?.SubmitAsync();
            }
        }

        /// <summary>
        /// Deliberately not implemented past this point — the recovery-email/password-reset
        /// flow (v2-architecture.md §14.6) is its own screen with its own server round trip,
        /// out of scope for this pass. Left as a named, visible seam rather than a silently
        /// dead button, so it is obvious this needs wiring rather than being mistaken for
        /// working.
        /// </summary>
        private void OnForgotPasswordClicked()
        {
            Debug.LogWarning("[LoginScreenController] Forgot-password flow not yet implemented (§14.6).");
        }

        private void SetKeyboardOpen(bool open)
        {
            _headerBand.style.display = open ? DisplayStyle.None : DisplayStyle.Flex;
            // A collapse-not-hide would match §3.1's exact choreography (scale+translate the
            // band's contents rather than removing them) — left as a follow-up once the real
            // mascot asset exists to animate; hiding outright is the correct *functional*
            // behaviour in the meantime (frees the vertical space a TextField needs) without
            // pretending to a polish pass that hasn't happened.
        }

        private void Render(LoginFormState state)
        {
            var isRegister = state.Mode == AuthMode.Register;

            _segmentLogin.EnableInClassList("segment--active", !isRegister);
            _segmentRegister.EnableInClassList("segment--active", isRegister);

            if (_usernameInput.value != state.Username) _usernameInput.SetValueWithoutNotify(state.Username);
            if (_passwordInput.value != state.Password) _passwordInput.SetValueWithoutNotify(state.Password);

            RenderBanner(state);
            RenderUsernameHint(state);
            RenderPasswordArea(state, isRegister);

            _forgotPassword.style.display = isRegister ? DisplayStyle.None : DisplayStyle.Flex;
            _recoveryEmailField.style.display = isRegister ? DisplayStyle.Flex : DisplayStyle.None;

            _submitButton.text = state.Submitting ? "…"
                : state.CooldownSeconds > 0 ? $"Try again in {state.CooldownSeconds}s"
                : isRegister ? "Create account" : "Log in";
            _submitButton.SetEnabled(!state.SubmitDisabled);

            // §3.1: on a 401, focus moves to the password field. Detected as a one-shot
            // transition (this exact banner text appearing where it wasn't a moment ago)
            // rather than every render, so it fires once per failure and not on every
            // unrelated state update while the banner happens to still be showing.
            var justFailedCredentials = state.Banner == "Invalid username or password."
                && _lastRendered?.Banner != state.Banner;
            if (justFailedCredentials) _passwordInput.Focus();

            _lastRendered = state;
        }

        private void RenderBanner(LoginFormState state)
        {
            var hasBanner = !string.IsNullOrEmpty(state.Banner);
            _banner.style.display = hasBanner ? DisplayStyle.Flex : DisplayStyle.None;
            if (hasBanner) _banner.text = state.Banner;
        }

        private void RenderUsernameHint(LoginFormState state)
        {
            if (!string.IsNullOrEmpty(state.UsernameFieldError))
            {
                _usernameHint.style.display = DisplayStyle.Flex;
                _usernameHint.text = state.UsernameFieldError;
                _usernameHint.EnableInClassList("field-hint--error", true);
                _usernameHint.EnableInClassList("field-hint--ok", false);
                _usernameSuggestions.style.display = DisplayStyle.None;
                return;
            }

            switch (state.UsernameCheck)
            {
                case UsernameCheckStatus.Checking:
                    SetHint(_usernameHint, "Checking…", ok: false, error: false);
                    _usernameSuggestions.style.display = DisplayStyle.None;
                    break;
                case UsernameCheckStatus.Available:
                    SetHint(_usernameHint, "✓ Available", ok: true, error: false);
                    _usernameSuggestions.style.display = DisplayStyle.None;
                    break;
                case UsernameCheckStatus.Taken:
                    SetHint(_usernameHint, "Taken. Try", ok: false, error: false);
                    RenderSuggestionChips(state.UsernameSuggestions);
                    break;
                default:
                    _usernameHint.style.display = DisplayStyle.None;
                    _usernameSuggestions.style.display = DisplayStyle.None;
                    break;
            }
        }

        private void RenderSuggestionChips(string[] suggestions)
        {
            _usernameSuggestions.Clear();
            if (suggestions == null || suggestions.Length == 0)
            {
                _usernameSuggestions.style.display = DisplayStyle.None;
                return;
            }

            _usernameSuggestions.style.display = DisplayStyle.Flex;
            foreach (var suggestion in suggestions)
            {
                var chip = new Button(() => _service.PickSuggestion(suggestion)) { text = suggestion };
                chip.AddToClassList("chip");
                _usernameSuggestions.Add(chip);
            }
        }

        private void RenderPasswordArea(LoginFormState state, bool isRegister)
        {
            if (!isRegister)
            {
                _passwordHint.style.display = DisplayStyle.None;
                _strengthMeter.style.display = DisplayStyle.None;
                return;
            }

            if (!string.IsNullOrEmpty(state.PasswordFieldError))
            {
                SetHint(_passwordHint, state.PasswordFieldError, ok: false, error: true);
            }
            else if (state.Password.Length == 0)
            {
                SetHint(_passwordHint, $"At least {AuthValidation.PasswordMin} characters.", ok: false, error: false);
            }
            else if (state.Password.Length < AuthValidation.PasswordMin)
            {
                SetHint(_passwordHint, $"{state.Password.Length}/{AuthValidation.PasswordMin} characters", ok: false, error: false);
            }
            else
            {
                var label = AuthValidation.PasswordStrengthLabels[state.PasswordStrength];
                SetHint(_passwordHint, label, ok: state.PasswordStrength >= 3, error: false);
            }

            _strengthMeter.style.display = DisplayStyle.Flex;
            // Children() + a manual index, rather than an indexer VisualElement does not
            // reliably expose across API surfaces — see the comment this replaced for why
            // that risk wasn't worth taking here.
            var segIndex = 0;
            foreach (var seg in _strengthMeter.Children())
            {
                seg.EnableInClassList("strength-seg--on", segIndex < state.PasswordStrength);
                segIndex++;
            }
        }

        private static void SetHint(Label label, string text, bool ok, bool error)
        {
            label.style.display = DisplayStyle.Flex;
            label.text = text;
            label.EnableInClassList("field-hint--ok", ok);
            label.EnableInClassList("field-hint--error", error);
        }
    }
}
