using System;
using System.Threading;
using System.Threading.Tasks;

namespace LethalMagotchi.Auth
{
    public enum AuthMode { Login, Register }

    public enum UsernameCheckStatus { Idle, Checking, Available, Taken, Invalid }

    /// <summary>
    /// One immutable snapshot the UI renders from — the same shape the login states in
    /// <c>v2-ui-ux.md</c> §2/§3.1 describe, just as data instead of prose. A new instance is
    /// published on every change rather than mutated in place, so the UI layer can bind
    /// without worrying about tearing a read mid-update.
    /// </summary>
    public sealed class LoginFormState
    {
        public AuthMode Mode = AuthMode.Login;
        public string Username = "";
        public string Password = "";
        public string RecoveryEmail = "";

        public UsernameCheckStatus UsernameCheck = UsernameCheckStatus.Idle;
        public string[] UsernameSuggestions = Array.Empty<string>();
        public int PasswordStrength;

        /// <summary>Field-level messages keyed by "username"/"password" — from a 422's
        /// <c>fields</c> map, or from local validation on submit-with-empty-field. Cleared on
        /// every edit to the field they name, and on every mode switch (v1's exact rule).</summary>
        public string UsernameFieldError;
        public string PasswordFieldError;

        /// <summary>Non-field banner — 401's generic message, a 429 countdown, or a network
        /// failure. Never per-field; see the note on <see cref="ApiErrorCode.InvalidCredentials"/>'s
        /// use in <see cref="AuthService"/> for why 401 in particular must never become a
        /// field error.</summary>
        public string Banner;

        public bool Submitting;

        /// <summary>Seconds remaining on a 429 cooldown, ticking to 0. The submit button's
        /// label switches to "Try again in {n}s" while this is nonzero — see §3.1's 429 state.</summary>
        public int CooldownSeconds;

        /// <summary>§2's deliberate change from v1: the primary button is live even for
        /// empty/invalid input; this only gates the brief window a request is actually in
        /// flight or a cooldown is counting down — both states where the button's own label
        /// already explains why nothing happens on tap.</summary>
        public bool SubmitDisabled => Submitting || CooldownSeconds > 0;

        public LoginFormState Clone() => (LoginFormState)MemberwiseClone();
    }

    /// <summary>
    /// Orchestrates the login screen's behaviour against an <see cref="IAuthGateway"/> —
    /// debounced username availability, password-strength prediction, submission, and the
    /// error states §3.1 names explicitly (401 clears the password and focuses it; 429 shows a
    /// ticking countdown; a malformed submit focuses the first empty field rather than
    /// disabling the button — see the note on <see cref="LoginFormState.SubmitDisabled"/>).
    ///
    /// Deliberately holds no <c>MonoBehaviour</c>/<c>UnityEngine.UI</c> reference — every
    /// dependency it touches (<see cref="IAuthGateway"/>, the clock) is injected, so this
    /// class is exercised directly by <c>Assets/Scripts/Auth/Tests/AuthServiceTests.cs</c>
    /// with a fake gateway rather than needing a running UI to test the state machine at all.
    /// <see cref="LethalMagotchi.Auth.UI.LoginScreenController"/> is the thin MonoBehaviour
    /// that binds <see cref="StateChanged"/> to actual UI Toolkit elements.
    /// </summary>
    public sealed class AuthService : IDisposable
    {
        /// <summary>v1 §4's exact debounce; mirrored here so the two clients feel identical.</summary>
        private const int UsernameCheckDebounceMs = 400;

        private readonly IUsernameAvailabilityApi _api;
        private readonly IAuthGateway _gateway;
        private readonly Func<DateTime> _now;

        private LoginFormState _state = new();
        private CancellationTokenSource _usernameCheckCts;
        private CancellationTokenSource _cooldownCts;

        public event Action<LoginFormState> StateChanged;

        /// <summary>Fires once with the established session — the caller (outside this
        /// assembly) branches on <c>Character == null</c> exactly as <c>App.tsx</c> does:
        /// character creation, or the main screen.</summary>
        public event Action<SessionResponseV2> SignedIn;

        public AuthService(IUsernameAvailabilityApi api, IAuthGateway gateway, Func<DateTime> now = null)
        {
            _api = api ?? throw new ArgumentNullException(nameof(api));
            _gateway = gateway ?? throw new ArgumentNullException(nameof(gateway));
            _now = now ?? (() => DateTime.UtcNow);
        }

        public LoginFormState CurrentState => _state;

        public void SwitchMode(AuthMode mode)
        {
            if (_state.Mode == mode) return;

            // Cancelled, not merely cleared. Clearing the availability fields alone left a
            // debounced check that was ALREADY in flight free to come back a moment later and
            // repaint "✓ Available" — or a row of suggestion chips — onto the login form, which
            // is precisely the account-existence signal login deliberately never shows (v1 §4,
            // and the reason the 401 is generic). Covered by
            // AuthServiceTests.Switching_to_login_discards_a_username_check_that_was_already_in_flight.
            _usernameCheckCts?.Cancel();

            // v1's exact rule: switching clears the banner, both field errors, and the
            // password — never carry a stale error or a typed password across modes.
            Publish(s =>
            {
                s.Mode = mode;
                s.Password = "";
                s.Banner = null;
                s.UsernameFieldError = null;
                s.PasswordFieldError = null;
                s.UsernameCheck = UsernameCheckStatus.Idle;
                s.UsernameSuggestions = Array.Empty<string>();
                s.PasswordStrength = 0;
            });
        }

        public void UsernameChanged(string value)
        {
            // Normalised to "" at the boundary: LoginFormState's string fields are non-null by
            // contract (ValidateNotEmpty and NormalizeUsername both dereference them directly),
            // and a null arriving from a caller would otherwise turn into a NullReferenceException
            // several frames away from its cause.
            value ??= "";

            Publish(s =>
            {
                s.Username = value;
                s.UsernameFieldError = null;
                s.UsernameCheck = UsernameCheckStatus.Idle;
                s.UsernameSuggestions = Array.Empty<string>();
            });

            // Live availability is register-only and never runs on login (v1 §4: it would
            // leak account existence and undercut the generic 401).
            if (_state.Mode != AuthMode.Register) return;

            _usernameCheckCts?.Cancel();
            if (AuthValidation.NormalizeUsername(value).Length < 3) return;

            var cts = new CancellationTokenSource();
            _usernameCheckCts = cts;
            _ = RunDebouncedUsernameCheckAsync(value, cts.Token);
        }

        public void PasswordChanged(string value)
        {
            value ??= ""; // see the note in UsernameChanged

            Publish(s =>
            {
                s.Password = value;
                s.PasswordFieldError = null;
                s.PasswordStrength = s.Mode == AuthMode.Register ? AuthValidation.PasswordStrength(value) : 0;
            });
        }

        public void RecoveryEmailChanged(string value) => Publish(s => s.RecoveryEmail = value ?? "");

        /// <summary>Tapping a suggestion chip (§3.1) fills the field and re-runs the check —
        /// exactly what typing the same text would do, so this is just that call by name.</summary>
        public void PickSuggestion(string suggestion) => UsernameChanged(suggestion);

        /// <summary>
        /// Idempotent while a submit is already running or a cooldown is counting down. The
        /// button's <c>SetEnabled</c> is a hint to the player, not an enforcement point — the
        /// Enter-key path in <see cref="LethalMagotchi.Auth.UI.LoginScreenController"/> reaches
        /// this method without ever consulting the button, so the guard has to live here where
        /// every entry point passes through it. Without it, one held Enter key became two
        /// concurrent logins (two server sessions, <see cref="SignedIn"/> twice), and Enter
        /// during a 429 spent another attempt against the limiter the screen was at that moment
        /// displaying a countdown for.
        /// </summary>
        public Task SubmitAsync()
        {
            if (_state.SubmitDisabled) return Task.CompletedTask;
            return _state.Mode == AuthMode.Login ? SubmitLoginAsync() : SubmitRegisterAsync();
        }

        private Task SubmitLoginAsync() =>
            SubmitAsync(() => _gateway.LoginAsync(_state.Username, _state.Password));

        private Task SubmitRegisterAsync() =>
            SubmitAsync(() => _gateway.RegisterAsync(_state.Username, _state.Password));

        private async Task SubmitAsync(Func<Task<SessionResponseV2>> call)
        {
            if (!ValidateNotEmpty()) return;

            Publish(s => { s.Submitting = true; s.Banner = null; });

            SessionResponseV2 session;
            try
            {
                session = await call();
            }
            catch (ApiException ex)
            {
                HandleSubmitFailure(ex);
                return;
            }
            catch (Exception ex)
            {
                HandleUnexpectedSubmitFailure(ex);
                return;
            }

            Publish(s => s.Submitting = false);

            // Raised outside the try on purpose: a listener throwing is that listener's bug, and
            // turning it into "we could not sign you in" would be an outright lie — the sign-in
            // had already succeeded by this line.
            SignedIn?.Invoke(session);
        }

        /// <summary>§2's deliberate change from v1: submitting with an empty field never
        /// disables the button ahead of time — it fails loudly, in the same place every other
        /// submit failure lands, the instant it's tried. A disabled button that does nothing
        /// on tap gives a phone player no way to learn why.</summary>
        private bool ValidateNotEmpty()
        {
            if (_state.Username.Length > 0 && _state.Password.Length > 0) return true;
            Publish(s => s.Banner = "Enter your username and password.");
            return false;
        }

        private void HandleSubmitFailure(ApiException ex)
        {
            switch (ex.Code)
            {
                case ApiErrorCode.InvalidCredentials:
                    // Never a field error — the server's own anti-enumeration discipline
                    // (packages/shared, checked in this same session's server work) depends on
                    // never telling the player which half was wrong.
                    Publish(s => { s.Submitting = false; s.Banner = "Invalid username or password."; s.Password = ""; });
                    break;

                case ApiErrorCode.UsernameTaken:
                    Publish(s => { s.Submitting = false; s.UsernameFieldError = "That username is taken."; });
                    break;

                case ApiErrorCode.RateLimited:
                    StartCooldown(ex.RetryAfterSeconds ?? 30);
                    break;

                case ApiErrorCode.ValidationFailed:
                    Publish(s =>
                    {
                        s.Submitting = false;
                        var appliedToAField = false;
                        if (ex.Fields != null)
                        {
                            if (ex.Fields.TryGetValue("username", out var u)) { s.UsernameFieldError = u; appliedToAField = true; }
                            if (ex.Fields.TryGetValue("password", out var p)) { s.PasswordFieldError = p; appliedToAField = true; }
                        }
                        // Falls back to the banner whenever nothing landed on a known field —
                        // both the "no fields at all" case and "fields named something this
                        // screen doesn't render a slot for" — so a validation error can never
                        // silently show nothing.
                        if (!appliedToAField) s.Banner = ex.Message;
                    });
                    break;

                default:
                    Publish(s => { s.Submitting = false; s.Banner = ex.Message; });
                    break;
            }
        }

        /// <summary>
        /// The catch-all half of submit's error handling. Before this existed, only
        /// <see cref="ApiException"/> was caught — so anything else thrown anywhere under
        /// <see cref="IAuthGateway"/> (a serialization fault, a null deref, or
        /// <c>BridgeAuthGateway</c>'s own deliberate <see cref="NotSupportedException"/> on
        /// WebGL) escaped as an unobserved task exception and left <c>Submitting</c> stuck true
        /// forever: the button permanently disabled, the label stuck on its in-flight state, and
        /// no message anywhere. A dead screen with no way out but force-quitting the app is a
        /// far worse outcome than a generic banner, which is what this produces instead.
        /// The exception itself is still logged rather than swallowed, since by construction it
        /// is a bug rather than a condition anyone designed for.
        /// </summary>
        private void HandleUnexpectedSubmitFailure(Exception ex)
        {
            UnityEngine.Debug.LogException(ex);
            Publish(s =>
            {
                s.Submitting = false;
                s.Banner = "Something went wrong. Please try again.";
            });
        }

        private void StartCooldown(int seconds)
        {
            _cooldownCts?.Cancel();
            var cts = new CancellationTokenSource();
            _cooldownCts = cts;

            Publish(s =>
            {
                s.Submitting = false;
                s.CooldownSeconds = seconds;
                s.Banner = $"Too many attempts. Try again in {seconds}s.";
            });

            _ = RunCooldownAsync(seconds, cts.Token);
        }

        /// <summary>
        /// An async loop rather than <c>System.Threading.Timer</c> — deliberately, not just
        /// for style. A <c>Timer</c> callback always fires on a thread-pool thread with no
        /// regard for whatever <c>SynchronizationContext</c> was active when it was created,
        /// so every <see cref="Publish"/> call inside one would run off Unity's main thread —
        /// exactly the kind of bug that is invisible in review and throws deep inside the
        /// engine the first time it actually runs. <c>await Task.Delay(...)</c>, by contrast,
        /// resumes on the <c>SynchronizationContext</c> captured at the point it was awaited
        /// (Unity installs one on the main thread automatically), so every line after each
        /// <c>await</c> below is already guaranteed to run on the main thread with no manual
        /// marshaling.
        /// </summary>
        private async Task RunCooldownAsync(int secondsRemaining, CancellationToken token)
        {
            while (secondsRemaining > 0)
            {
                try
                {
                    await Task.Delay(1000, token);
                }
                catch (TaskCanceledException)
                {
                    return; // superseded — another submit or cooldown started
                }
                if (token.IsCancellationRequested) return;

                secondsRemaining -= 1;
                if (secondsRemaining <= 0)
                {
                    Publish(s => { s.CooldownSeconds = 0; s.Banner = null; });
                    return;
                }
                var remaining = secondsRemaining;
                Publish(s => { s.CooldownSeconds = remaining; s.Banner = $"Too many attempts. Try again in {remaining}s."; });
            }
        }

        private async Task RunDebouncedUsernameCheckAsync(string username, CancellationToken token)
        {
            try
            {
                await Task.Delay(UsernameCheckDebounceMs, token);
            }
            catch (TaskCanceledException)
            {
                return; // superseded by a later keystroke — never publish a stale result
            }
            if (token.IsCancellationRequested) return;

            Publish(s => s.UsernameCheck = UsernameCheckStatus.Checking);

            UsernameAvailabilityResponse result;
            try
            {
                result = await _api.CheckUsernameAsync(username);
            }
            catch (Exception)
            {
                // Broader than ApiException deliberately: this runs in a fire-and-forget task, so
                // anything that escapes here is an exception nothing will ever observe, and the
                // only symptom the player gets is a hint stuck on "Checking…". Availability is a
                // convenience — submit is the real check — so every failure mode is the same
                // quiet fallback.
                if (token.IsCancellationRequested) return;
                Publish(s => s.UsernameCheck = UsernameCheckStatus.Idle);
                return;
            }
            if (token.IsCancellationRequested) return;
            if (result == null)
            {
                Publish(s => s.UsernameCheck = UsernameCheckStatus.Idle);
                return;
            }

            Publish(s =>
            {
                s.UsernameCheck = result.Available ? UsernameCheckStatus.Available : UsernameCheckStatus.Taken;
                // `suggestions` is optional in the server's own type, so a body without it
                // deserializes to null. Dereferencing it threw inside this fire-and-forget task,
                // where nothing observes the exception — so the only visible symptom was the hint
                // staying on "Checking…" forever, with no error in the log to explain it.
                s.UsernameSuggestions = !result.Available && result.Suggestions != null
                    ? result.Suggestions.ToArray()
                    : Array.Empty<string>();
            });
        }

        private void Publish(Action<LoginFormState> mutate)
        {
            var next = _state.Clone();
            mutate(next);
            _state = next;
            StateChanged?.Invoke(_state);
        }

        public void Dispose()
        {
            _usernameCheckCts?.Cancel();
            _usernameCheckCts?.Dispose();
            _cooldownCts?.Cancel();
            _cooldownCts?.Dispose();
        }
    }
}
