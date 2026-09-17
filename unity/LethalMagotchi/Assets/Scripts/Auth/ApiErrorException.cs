using System;

namespace LethalMagotchi.Auth
{
    /// <summary>
    /// Named error codes the auth flow actually branches on — not an exhaustive mirror of the
    /// server's <c>API_ERROR_CODES</c> (that list is long, general-purpose, and grows with
    /// every unrelated feature; hardcoding all of it here would need updating from a language
    /// this assembly can never see). <see cref="ApiException.Code"/> always carries the raw
    /// server string regardless of whether a constant exists for it, so an unrecognised code
    /// degrades to "show the message", never to a crash.
    /// </summary>
    public static class ApiErrorCode
    {
        public const string ValidationFailed = "VALIDATION_FAILED";
        public const string InvalidCredentials = "INVALID_CREDENTIALS";
        public const string UsernameTaken = "USERNAME_TAKEN";
        public const string Unauthorized = "UNAUTHORIZED";
        public const string RateLimited = "RATE_LIMITED";
    }

    /// <summary>
    /// Thrown by <see cref="ApiClient"/> for any non-2xx response whose body parsed as
    /// <see cref="ApiErrorBody"/>. Carries exactly what the server sent — <see cref="Code"/>
    /// is what UI code should branch on (§3.1's login states are keyed off this), never
    /// <see cref="StatusCode"/> alone, since e.g. 401 covers both "wrong password" and
    /// "session expired" and only <see cref="Code"/> tells them apart.
    /// </summary>
    public sealed class ApiException : Exception
    {
        public int StatusCode { get; }
        public string Code { get; }
        public System.Collections.Generic.Dictionary<string, string> Fields { get; }
        public int? RetryAfterSeconds { get; }

        public ApiException(int statusCode, ApiErrorDetail detail)
            : base(detail?.Message ?? "Request failed.")
        {
            StatusCode = statusCode;
            Code = detail?.Code ?? "UNKNOWN";
            Fields = detail?.Fields;
            RetryAfterSeconds = detail?.RetryAfterSeconds;
        }

        /// <summary>Used when the body could not be parsed at all — a proxy error page, a
        /// dropped connection, a malformed response. Never silently swallowed: the caller
        /// still gets a typed exception, just with no server-authored code to key off.</summary>
        public ApiException(int statusCode, string rawMessage)
            : base(rawMessage)
        {
            StatusCode = statusCode;
            Code = "TRANSPORT_ERROR";
        }
    }
}
