using NUnit.Framework;

namespace LethalMagotchi.Auth.Tests
{
    /// <summary>Cross-checked against <c>packages/shared/src/{username,password}.ts</c>'s own
    /// test fixtures where practical — these are meant to keep predicting the same answers the
    /// server gives, not just to be internally consistent.</summary>
    [TestFixture]
    public sealed class AuthValidationTests
    {
        [TestCase("ab", AuthValidation.UsernameProblem.Length)]
        [TestCase("a-very-long-username-well-past-twenty-chars", AuthValidation.UsernameProblem.Length)]
        [TestCase("Has Spaces", AuthValidation.UsernameProblem.Charset)]
        [TestCase("has-dash", AuthValidation.UsernameProblem.Charset)]
        [TestCase("_leading", AuthValidation.UsernameProblem.EdgeUnderscore)]
        [TestCase("trailing_", AuthValidation.UsernameProblem.EdgeUnderscore)]
        [TestCase("valid_name123", AuthValidation.UsernameProblem.None)]
        public void CheckUsername_matches_server_rules(string input, AuthValidation.UsernameProblem expected)
        {
            Assert.That(AuthValidation.CheckUsername(input), Is.EqualTo(expected));
        }

        [Test]
        public void NormalizeUsername_folds_fullwidth_to_ascii()
        {
            // The server's own NFKC-collision test fixture (auth.test.ts, this session's
            // server work): fullwidth "ＡＬＩＣＥ" must normalize identically to "alice", or a
            // client-side availability prediction would say "available" for a name the
            // register call then rejects as taken.
            Assert.That(AuthValidation.NormalizeUsername("ＡＬＩＣＥ"), Is.EqualTo("alice"));
        }

        // Expected values are cross-checked against a Python transcription of the same
        // scoring rule rather than hand-counted — password_strength() is easy to get subtly
        // wrong by miscounting a test string's own length while writing the test, which is
        // exactly the mistake a first draft of this file made before that check caught it.
        [TestCase("short", 0)]                    // 5 chars, below PasswordMin entirely
        [TestCase("tencharsss", 1)]                // 10 chars, one class (lowercase only)
        [TestCase("tenchars12", 1)]                // 10 chars, two classes (lower + digit) — still under 3
        [TestCase("Tenchars12", 2)]                // 10 chars, three classes (lower+upper+digit)
        [TestCase("fourteencharsx", 2)]            // 14 chars, one class — length bonus, no variety bonus
        [TestCase("Fourteenchrs12", 3)]            // 14 chars, three classes — both bonuses
        [TestCase("VeryLongPassword1234!!", 4)]    // 22 chars, four classes — capped at 4
        public void PasswordStrength_scores_length_and_variety(string password, int expected)
        {
            Assert.That(AuthValidation.PasswordStrength(password), Is.EqualTo(expected));
        }

        [Test]
        public void PasswordStrength_never_exceeds_four()
        {
            Assert.That(AuthValidation.PasswordStrength("Extremely-Long-Password-With-1234-Everything!!"), Is.EqualTo(4));
        }

        [Test]
        public void PasswordStrength_is_higher_than_the_servers_for_a_denylisted_password_and_that_is_known()
        {
            // Pins the documented divergence from packages/shared/src/password.ts rather than
            // leaving it as prose. The server clamps a COMMON_PASSWORDS entry's score to 1; this
            // class deliberately carries no denylist (see AuthValidation's docstring for why), so
            // it scores the same password on length and variety alone.
            //
            // The point of asserting it: if someone later mirrors the denylist here, this test
            // fails and forces the docstring to be updated with it — and if someone "fixes" this
            // number without mirroring the list, the failure says plainly that the client and the
            // server now disagree about a password the server will reject outright.
            const string denylisted = "password1234"; // in COMMON_PASSWORDS; 12 chars, 2 classes

            Assert.That(AuthValidation.PasswordStrength(denylisted), Is.EqualTo(1),
                "length+variety score; the server would also report 1 here only by coincidence of the clamp");

            // A longer denylisted entry makes the divergence visible rather than coincidental:
            // 12 chars with three classes scores 2 here, while the server clamps it to 1.
            Assert.That(AuthValidation.PasswordStrength("Password1234"), Is.EqualTo(2));
        }

        [Test]
        public void A_reserved_username_is_not_predicted_client_side()
        {
            // Documented gap #2: RESERVED_USERNAMES is server-owned so moderation can extend it
            // without a client release. "admin" is structurally a perfectly valid username here
            // and is rejected only on submit — asserted so the omission stays deliberate.
            Assert.That(AuthValidation.CheckUsername("admin"), Is.EqualTo(AuthValidation.UsernameProblem.None));
        }

        [Test]
        public void NormalizeUsername_tolerates_a_null_rather_than_throwing()
        {
            // Reached from AuthService.UsernameChanged on every keystroke; a null arriving from a
            // UI binding must not become a NullReferenceException several frames from its cause.
            Assert.That(AuthValidation.NormalizeUsername(null), Is.Empty);
            Assert.That(AuthValidation.CheckUsername(null), Is.EqualTo(AuthValidation.UsernameProblem.Length));
        }
    }
}
