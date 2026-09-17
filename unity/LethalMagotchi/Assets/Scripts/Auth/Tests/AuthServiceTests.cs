using System;
using System.Threading.Tasks;
using NUnit.Framework;

namespace LethalMagotchi.Auth.Tests
{
    [TestFixture]
    public sealed class AuthServiceTests
    {
        private static SessionResponseV2 MakeSession(string username = "otto") => new()
        {
            AccessToken = "access-token",
            RefreshToken = "refresh-token",
            ExpiresInSeconds = 900,
            Account = new AccountDto { Id = "acct-1", Username = username },
            Character = null,
        };

        [Test]
        public async Task SubmitAsync_with_empty_fields_shows_a_banner_and_never_calls_the_gateway()
        {
            // §2's deliberate v2 change: the button is never disabled ahead of time for
            // empty/invalid input — this is the behaviour that change relies on actually
            // existing, not just the button staying clickable.
            var gateway = new FakeAuthGateway();
            var api = new FakeUsernameApi();
            using var service = new AuthService(api, gateway);

            await service.SubmitAsync();

            Assert.That(service.CurrentState.Banner, Is.EqualTo("Enter your username and password."));
            Assert.That(service.CurrentState.Submitting, Is.False);
        }

        [Test]
        public async Task Successful_login_fires_SignedIn_and_clears_submitting()
        {
            var gateway = new FakeAuthGateway { OnLogin = (u, p) => Task.FromResult(MakeSession(u)) };
            var api = new FakeUsernameApi();
            using var service = new AuthService(api, gateway);
            SessionResponseV2 signedInWith = null;
            service.SignedIn += s => signedInWith = s;

            service.UsernameChanged("otto");
            service.PasswordChanged("correct-horse-battery-9");
            await service.SubmitAsync();

            Assert.That(signedInWith, Is.Not.Null);
            Assert.That(signedInWith.Account.Username, Is.EqualTo("otto"));
            Assert.That(service.CurrentState.Submitting, Is.False);
            Assert.That(service.CurrentState.Banner, Is.Null);
        }

        [Test]
        public async Task Invalid_credentials_shows_the_generic_banner_and_clears_the_password_only()
        {
            // Never a field error — packages/shared's own anti-enumeration discipline depends
            // on the server (and therefore the client relaying it) never saying which half of
            // username/password was wrong.
            var gateway = new FakeAuthGateway
            {
                OnLogin = (_, _) => throw new ApiException(401, new ApiErrorDetail
                {
                    Code = ApiErrorCode.InvalidCredentials,
                    Message = "Invalid username or password.",
                }),
            };
            var api = new FakeUsernameApi();
            using var service = new AuthService(api, gateway);

            service.UsernameChanged("otto");
            service.PasswordChanged("whatever-was-typed");
            await service.SubmitAsync();

            Assert.That(service.CurrentState.Banner, Is.EqualTo("Invalid username or password."));
            Assert.That(service.CurrentState.Password, Is.Empty);
            Assert.That(service.CurrentState.UsernameFieldError, Is.Null);
            Assert.That(service.CurrentState.Username, Is.EqualTo("otto")); // username is kept
        }

        [Test]
        public async Task Taken_username_becomes_a_field_error_not_a_banner()
        {
            var gateway = new FakeAuthGateway
            {
                OnRegister = (_, _) => throw new ApiException(409, new ApiErrorDetail
                {
                    Code = ApiErrorCode.UsernameTaken,
                    Message = "That username is taken.",
                    Fields = new() { ["username"] = "That username is taken." },
                }),
            };
            var api = new FakeUsernameApi();
            using var service = new AuthService(api, gateway);
            service.SwitchMode(AuthMode.Register);
            service.UsernameChanged("taken_name");
            service.PasswordChanged("correct-horse-battery-9");

            await service.SubmitAsync();

            Assert.That(service.CurrentState.UsernameFieldError, Is.EqualTo("That username is taken."));
            Assert.That(service.CurrentState.Banner, Is.Null);
        }

        [Test]
        public async Task Rate_limited_starts_a_visible_cooldown_and_disables_submit()
        {
            var gateway = new FakeAuthGateway
            {
                OnLogin = (_, _) => throw new ApiException(429, new ApiErrorDetail
                {
                    Code = ApiErrorCode.RateLimited,
                    Message = "Too many attempts. Try again shortly.",
                    RetryAfterSeconds = 900,
                }),
            };
            var api = new FakeUsernameApi();
            using var service = new AuthService(api, gateway);
            service.UsernameChanged("otto");
            service.PasswordChanged("whatever");

            await service.SubmitAsync();

            Assert.That(service.CurrentState.CooldownSeconds, Is.EqualTo(900));
            Assert.That(service.CurrentState.SubmitDisabled, Is.True);
            Assert.That(service.CurrentState.Banner, Does.Contain("900s"));
        }

        [Test]
        public void SwitchMode_clears_password_banner_and_field_errors()
        {
            var gateway = new FakeAuthGateway();
            var api = new FakeUsernameApi();
            using var service = new AuthService(api, gateway);

            service.PasswordChanged("something-typed");
            service.SwitchMode(AuthMode.Register);
            service.SwitchMode(AuthMode.Login); // back, to exercise the clear on a real transition

            Assert.That(service.CurrentState.Password, Is.Empty);
            Assert.That(service.CurrentState.Banner, Is.Null);
        }

        [Test]
        public void Live_username_availability_never_runs_in_login_mode()
        {
            // v1 §4's rule, carried forward: checking availability on login would leak
            // account existence and undercut the deliberately generic 401.
            var gateway = new FakeAuthGateway();
            var api = new FakeUsernameApi();
            using var service = new AuthService(api, gateway);
            Assert.That(service.CurrentState.Mode, Is.EqualTo(AuthMode.Login));

            service.UsernameChanged("someone");

            Assert.That(api.CallCount, Is.EqualTo(0));
        }

        [Test]
        public async Task Live_username_availability_debounces_and_reports_taken_with_suggestions()
        {
            // The one test in this file that waits on real time — the 400ms debounce
            // (§2/v1 §4) is short enough that a real wait is simpler and more honest than
            // injecting a fake clock purely to avoid it.
            var gateway = new FakeAuthGateway();
            var api = new FakeUsernameApi
            {
                OnCheck = username => Task.FromResult(new UsernameAvailabilityResponse
                {
                    Username = username,
                    Available = false,
                    Suggestions = new() { $"{username}_1", $"{username}_dev" },
                }),
            };
            using var service = new AuthService(api, gateway);
            service.SwitchMode(AuthMode.Register);

            service.UsernameChanged("ot");   // below the 3-char floor — must not trigger a call
            service.UsernameChanged("otto"); // supersedes it

            await Task.Delay(600);

            Assert.That(api.CallCount, Is.EqualTo(1));
            Assert.That(service.CurrentState.UsernameCheck, Is.EqualTo(UsernameCheckStatus.Taken));
            Assert.That(service.CurrentState.UsernameSuggestions, Is.EqualTo(new[] { "otto_1", "otto_dev" }));
        }

        [Test]
        public async Task Retyping_within_the_debounce_window_only_checks_the_final_value()
        {
            var gateway = new FakeAuthGateway();
            var api = new FakeUsernameApi();
            using var service = new AuthService(api, gateway);
            service.SwitchMode(AuthMode.Register);

            service.UsernameChanged("ott");
            await Task.Delay(100);
            service.UsernameChanged("otto"); // arrives before the first debounce fires

            await Task.Delay(600);

            Assert.That(api.CallCount, Is.EqualTo(1));
        }

        // ------------------------------------------------------------------ regressions
        // Everything below is a regression test for a specific defect found in QA against the
        // real compiler/test harness. Each one names the scenario that produced it.

        [Test]
        public async Task Submitting_again_while_a_submit_is_still_in_flight_does_not_send_a_second_request()
        {
            // REGRESSION: the submit button is disabled while Submitting, but the Enter-key path
            // in LoginScreenController never consulted that — so holding Enter, or tapping submit
            // and then pressing Enter, fired two concurrent logins from one intent. Two successful
            // logins means two server sessions and SignedIn firing twice, i.e. the post-login
            // screen being entered twice.
            var release = new TaskCompletionSource<SessionResponseV2>();
            var attempts = 0;
            var gateway = new FakeAuthGateway
            {
                OnLogin = (_, _) => { attempts++; return release.Task; },
            };
            using var service = new AuthService(new FakeUsernameApi(), gateway);
            service.UsernameChanged("otto");
            service.PasswordChanged("correct-horse-battery-9");

            var first = service.SubmitAsync();
            var second = service.SubmitAsync(); // the second intent, while the first is in flight

            // Asserted without awaiting `second` on purpose: if the guard is missing, `second` is
            // a real in-flight request that never completes here, and awaiting it would hang the
            // suite instead of failing it.
            Assert.That(attempts, Is.EqualTo(1));
            Assert.That(second.IsCompleted, Is.True, "a suppressed submit returns immediately");

            release.SetResult(MakeSession());
            await first;
        }

        [Test]
        public async Task Submitting_during_a_429_cooldown_does_not_send_a_request()
        {
            // REGRESSION: same root cause as above, with a worse outcome — the server has just
            // explicitly asked this client to wait, and a keyboard Enter would immediately spend
            // another attempt against the limiter, extending the very cooldown being displayed.
            var attempts = 0;
            var gateway = new FakeAuthGateway
            {
                OnLogin = (_, _) =>
                {
                    attempts++;
                    throw new ApiException(429, new ApiErrorDetail
                    {
                        Code = ApiErrorCode.RateLimited,
                        Message = "Too many attempts.",
                        RetryAfterSeconds = 60,
                    });
                },
            };
            using var service = new AuthService(new FakeUsernameApi(), gateway);
            service.UsernameChanged("otto");
            service.PasswordChanged("correct-horse-battery-9");

            await service.SubmitAsync();
            Assert.That(service.CurrentState.CooldownSeconds, Is.EqualTo(60));

            await service.SubmitAsync();

            Assert.That(attempts, Is.EqualTo(1));
        }

        [Test]
        public async Task Switching_to_login_discards_a_username_check_that_was_already_in_flight()
        {
            // REGRESSION: SwitchMode cleared the availability state but never cancelled the
            // debounced check already running, so a Register-mode result could land a moment
            // later and paint "✓ Available" — or a row of suggestion chips — onto the LOGIN
            // form. That is exactly the account-existence leak the login screen deliberately
            // never shows (v1 §4, and the reason the 401 is generic).
            var api = new FakeUsernameApi
            {
                OnCheck = async username =>
                {
                    await Task.Delay(200);
                    return new UsernameAvailabilityResponse
                    {
                        Username = username,
                        Available = false,
                        Suggestions = new() { $"{username}_1" },
                    };
                },
            };
            using var service = new AuthService(api, new FakeAuthGateway());
            service.SwitchMode(AuthMode.Register);
            service.UsernameChanged("otto");

            await Task.Delay(500);            // past the debounce; the API call is now in flight
            service.SwitchMode(AuthMode.Login);
            await Task.Delay(500);            // long enough for that call to have come back

            Assert.That(service.CurrentState.UsernameCheck, Is.EqualTo(UsernameCheckStatus.Idle));
            Assert.That(service.CurrentState.UsernameSuggestions, Is.Empty);
        }

        [Test]
        public async Task A_gateway_failure_that_is_not_an_ApiException_still_re_enables_the_button()
        {
            // REGRESSION: only ApiException was caught, so anything else — a JSON/serialization
            // fault, a null deref deeper down, or BridgeAuthGateway's own deliberate
            // NotSupportedException on WebGL — left Submitting stuck true forever. The button
            // stays disabled, the spinner label stays up, and there is no message: a dead screen
            // whose only escape is force-quitting the app.
            var gateway = new FakeAuthGateway
            {
                OnLogin = (_, _) => throw new NotSupportedException("gateway does not support login here"),
            };
            using var service = new AuthService(new FakeUsernameApi(), gateway);
            service.UsernameChanged("otto");
            service.PasswordChanged("correct-horse-battery-9");

            await service.SubmitAsync();

            Assert.That(service.CurrentState.Submitting, Is.False);
            Assert.That(service.CurrentState.SubmitDisabled, Is.False, "the player must be able to try again");
            Assert.That(service.CurrentState.Banner, Is.Not.Null.And.Not.Empty);
        }

        [Test]
        public async Task A_taken_username_with_no_suggestions_still_reports_taken()
        {
            // REGRESSION: `result.Suggestions.ToArray()` assumed the field was always present.
            // The server's own type marks it optional, and a JSON body without it deserializes to
            // null — which threw inside a fire-and-forget task, so the exception was never
            // observed anywhere and the hint simply stayed on "Checking…" forever.
            var api = new FakeUsernameApi
            {
                OnCheck = username => Task.FromResult(new UsernameAvailabilityResponse
                {
                    Username = username,
                    Available = false,
                    Suggestions = null,
                }),
            };
            using var service = new AuthService(api, new FakeAuthGateway());
            service.SwitchMode(AuthMode.Register);

            service.UsernameChanged("otto");
            await Task.Delay(600);

            Assert.That(service.CurrentState.UsernameCheck, Is.EqualTo(UsernameCheckStatus.Taken));
            Assert.That(service.CurrentState.UsernameSuggestions, Is.Empty);
        }

        [Test]
        public async Task A_validation_error_naming_an_unknown_field_still_reaches_the_player()
        {
            // The server's `fields` map is open-ended (packages/shared), and this screen renders
            // slots for exactly two of them. A 422 about anything else must not render as silence.
            var gateway = new FakeAuthGateway
            {
                OnRegister = (_, _) => throw new ApiException(422, new ApiErrorDetail
                {
                    Code = ApiErrorCode.ValidationFailed,
                    Message = "Recovery email is not valid.",
                    Fields = new() { ["recoveryEmail"] = "Not a valid email address." },
                }),
            };
            using var service = new AuthService(new FakeUsernameApi(), gateway);
            service.SwitchMode(AuthMode.Register);
            service.UsernameChanged("otto");
            service.PasswordChanged("correct-horse-battery-9");

            await service.SubmitAsync();

            Assert.That(service.CurrentState.Banner, Is.EqualTo("Recovery email is not valid."));
        }

        [Test]
        public void Disposing_the_service_stops_an_already_running_cooldown_from_publishing()
        {
            // The screen being torn down mid-cooldown (player backs out of login) must not leave
            // a loop ticking against a dead listener.
            var gateway = new FakeAuthGateway
            {
                OnLogin = (_, _) => throw new ApiException(429, new ApiErrorDetail
                {
                    Code = ApiErrorCode.RateLimited,
                    Message = "Too many attempts.",
                    RetryAfterSeconds = 5,
                }),
            };
            var service = new AuthService(new FakeUsernameApi(), gateway);
            service.UsernameChanged("otto");
            service.PasswordChanged("correct-horse-battery-9");
            service.SubmitAsync().Wait();

            var publishesAfterDispose = 0;
            service.StateChanged += _ => publishesAfterDispose++;
            service.Dispose();

            Task.Delay(1400).Wait();

            Assert.That(publishesAfterDispose, Is.Zero);
        }
    }
}
