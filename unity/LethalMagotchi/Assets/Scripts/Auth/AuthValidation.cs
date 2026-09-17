using System.Text.RegularExpressions;

namespace LethalMagotchi.Auth
{
    /// <summary>
    /// Client-side prediction of the server's own rules
    /// (<c>packages/shared/src/{username,password}.ts</c>), so the login screen can show a
    /// live hint before the player submits — exactly v1's UX (<c>ui-ux.md</c> §4: debounced
    /// availability, a plain-language strength meter, no composition-rule checklist).
    ///
    /// <b>The server remains the only authority.</b> Every value here is a prediction, never
    /// a gate — <see cref="AuthService"/> submits whatever the player typed regardless of what
    /// this class says, and a 422 from the server is still the real, final validation. This
    /// class exists purely so the player isn't told about a problem only after a round trip.
    ///
    /// <b>Three</b> server rules are deliberately not mirrored here. An earlier version of this
    /// docstring claimed one, which made the other two look like oversights rather than
    /// decisions; all three are listed now so the boundary is checkable rather than remembered:
    /// <list type="number">
    /// <item><b>The common-password denylist</b> (~45 entries, <c>password.ts</c>'s
    /// <c>COMMON_PASSWORDS</c>). Duplicating a literal list across two languages with no shared
    /// source is exactly the kind of thing that quietly drifts — a password added server-side
    /// would need a second, easy-to-miss edit here to keep matching. Consequence, pinned by
    /// <c>AuthValidationTests</c>: a password on that list scores one point HIGHER here than the
    /// server reports, because the server clamps such a password's score to 1 and this does not.</item>
    /// <item><b>Reserved usernames</b> (<c>username.ts</c>'s <c>RESERVED_USERNAMES</c>) — small,
    /// server-owned, and changeable by moderation without a client release, so a reserved name
    /// surfaces as a rejection on submit exactly like a taken one. See
    /// <see cref="CheckUsername"/>.</item>
    /// <item><b>"Password cannot contain your username"</b> (<c>checkPassword</c>'s
    /// <c>contains_username</c>). Unlike the other two this one has no drift risk — it is a pure
    /// function of two values the client already holds — so it is a genuine UX gap rather than a
    /// principled omission: the player finds out only after a round trip. Mirroring it is a
    /// small, self-contained follow-up; it is named here rather than left undocumented so it is
    /// a decision someone can take, not a surprise someone discovers.</item>
    /// </list>
    /// In every case the rejection still reaches the player as the server's own
    /// <c>VALIDATION_FAILED</c> field message, which is always accurate by construction because
    /// it *is* the source of truth — these gaps cost a round trip, never correctness.
    /// </summary>
    public static class AuthValidation
    {
        public const int UsernameMin = 3;
        public const int UsernameMax = 20;
        public const int PasswordMin = 10;
        public const int PasswordMax = 128;

        private static readonly Regex UsernamePattern = new("^[a-z0-9_]{3,20}$", RegexOptions.Compiled);

        public enum UsernameProblem
        {
            None,
            Length,
            Charset,
            EdgeUnderscore,
        }

        /// <summary>Mirrors <c>normalizeUsername</c>. NFKC form matters here specifically
        /// because the server folds fullwidth/compatibility characters into ASCII before
        /// comparing — <c>"ＡＬＩＣＥ"</c> and <c>"alice"</c> must be predicted as the same
        /// name, or the availability check would give a false "available" the register call
        /// then rejects.</summary>
        public static string NormalizeUsername(string raw) =>
            raw == null ? "" : raw.Normalize(System.Text.NormalizationForm.FormKC).Trim().ToLowerInvariant();

        /// <summary>Mirrors <c>checkUsername</c>, minus the reserved-word check — that list is
        /// small and server-owned by design (moderation can add to it without a client
        /// release), so it is never predicted client-side; a reserved name simply surfaces as
        /// a 409/422 like a taken one.</summary>
        public static UsernameProblem CheckUsername(string raw)
        {
            var normalized = NormalizeUsername(raw);
            if (normalized.Length < UsernameMin || normalized.Length > UsernameMax) return UsernameProblem.Length;
            if (!UsernamePattern.IsMatch(normalized)) return UsernameProblem.Charset;
            if (normalized.StartsWith("_") || normalized.EndsWith("_")) return UsernameProblem.EdgeUnderscore;
            return UsernameProblem.None;
        }

        public static string UsernameProblemMessage(UsernameProblem problem) => problem switch
        {
            UsernameProblem.Length => $"Username must be {UsernameMin}-{UsernameMax} characters.",
            UsernameProblem.Charset => "Use only lowercase letters, numbers and underscores.",
            UsernameProblem.EdgeUnderscore => "Username cannot start or end with an underscore.",
            _ => null,
        };

        /// <summary>0-4, mirroring <c>passwordStrength</c>'s scoring exactly (length
        /// thresholds and character-class count) — everything except the common-password
        /// override, which needs the denylist this class deliberately does not carry (see the
        /// class docstring). A password on that list therefore scores one point higher here
        /// than the server would report; harmless, since the server's field message is what
        /// actually surfaces the rejection.</summary>
        public static int PasswordStrength(string password)
        {
            if (password == null || password.Length < PasswordMin) return 0;

            var score = 1;
            if (password.Length >= 14) score += 1;
            if (password.Length >= 20) score += 1;

            var classes = 0;
            if (Regex.IsMatch(password, "[a-z]")) classes++;
            if (Regex.IsMatch(password, "[A-Z]")) classes++;
            if (Regex.IsMatch(password, "[0-9]")) classes++;
            if (Regex.IsMatch(password, @"[^a-zA-Z0-9]")) classes++;
            if (classes >= 3) score += 1;

            return score > 4 ? 4 : score;
        }

        public static readonly string[] PasswordStrengthLabels =
        {
            "Too short", "Weak", "Okay", "Strong enough", "Very strong",
        };
    }
}
