using System.Collections.Generic;
using Newtonsoft.Json;

namespace LethalMagotchi.Auth
{
    /// <summary>
    /// Wire types for the v2 (native mobile / WebGL-bridge) session transport —
    /// <c>v2-architecture.md</c> §14.3. Deliberately a subset of the server's DTOs: this
    /// assembly's job is sign-in, not gameplay, and a field mirrored here that gameplay code
    /// never reads is a field that can silently drift from the server with nothing to catch
    /// it (there is no shared-package import across the TS/C# boundary the way
    /// <c>packages/shared</c> gives the two TypeScript apps). Extend these only when a
    /// specific screen needs a specific field — see <see cref="CharacterSummary"/> below for
    /// the concrete instance of that rule.
    /// </summary>
    [System.Serializable]
    public sealed class AccountDto
    {
        [JsonProperty("id")] public string Id;
        [JsonProperty("username")] public string Username;
        [JsonProperty("createdAt")] public string CreatedAt;
        [JsonProperty("lastLoginAt")] public string LastLoginAt;
        [JsonProperty("ownedCosmetics")] public List<string> OwnedCosmetics;
    }

    /// <summary>
    /// Only what the post-login route guard needs — "does this account already have a
    /// character" (server field: <c>MeResponse.character</c>, <c>null</c> or not). Mirrors
    /// <c>App.tsx</c>'s own routing decision (character exists → main screen, none → character
    /// creation), which is the only thing login itself has to act on. The character-creation
    /// and main-screen workstreams own the full <c>CharacterDto</c> mirror when they land.
    /// </summary>
    [System.Serializable]
    public sealed class CharacterSummary
    {
        [JsonProperty("id")] public string Id;
        [JsonProperty("nickname")] public string Nickname;
    }

    /// <summary>Mirrors <c>SessionResponseV2</c> (<c>packages/shared/src/types.ts</c>).</summary>
    [System.Serializable]
    public sealed class SessionResponseV2
    {
        [JsonProperty("accessToken")] public string AccessToken;
        [JsonProperty("expiresInSeconds")] public int ExpiresInSeconds;
        [JsonProperty("account")] public AccountDto Account;
        [JsonProperty("character")] public CharacterSummary Character;
        [JsonProperty("refreshToken")] public string RefreshToken;
    }

    /// <summary>Mirrors <c>RefreshResponseV2</c>.</summary>
    [System.Serializable]
    public sealed class RefreshResponseV2
    {
        [JsonProperty("accessToken")] public string AccessToken;
        [JsonProperty("expiresInSeconds")] public int ExpiresInSeconds;
        [JsonProperty("refreshToken")] public string RefreshToken;
    }

    /// <summary>
    /// Mirrors <c>MeResponse</c>. Fetched from the existing, already bearer-token-authenticated
    /// <c>GET /api/v1/me</c> — that route needs no v2 duplicate for the same reason
    /// <c>username-available</c> doesn't (see <see cref="ApiRoutes.UsernameAvailable"/>): it
    /// authenticates by the access token alone, which both transports already share.
    /// <see cref="NativeAuthGateway.TryRestoreSessionAsync"/> is the only caller — a boot-time
    /// refresh proves the stored token but returns no account/character, so this is what
    /// supplies the rest of a restored <see cref="SessionResponseV2"/>.
    /// </summary>
    [System.Serializable]
    public sealed class MeResponse
    {
        [JsonProperty("account")] public AccountDto Account;
        [JsonProperty("character")] public CharacterSummary Character;
    }

    /// <summary>Mirrors <c>UsernameAvailabilityResponse</c>. Served by the v1 endpoint — see
    /// the note on <see cref="ApiRoutes.UsernameAvailable"/>.</summary>
    [System.Serializable]
    public sealed class UsernameAvailabilityResponse
    {
        [JsonProperty("username")] public string Username;
        [JsonProperty("available")] public bool Available;
        [JsonProperty("suggestions")] public List<string> Suggestions;
    }

    /// <summary>Mirrors <c>ApiErrorBody</c>. Only <c>code</c> and <c>message</c> are ever
    /// required by calling code; <c>fields</c>/<c>retryAfterSeconds</c> are optional exactly
    /// as they are in the TS type.</summary>
    [System.Serializable]
    public sealed class ApiErrorBody
    {
        [JsonProperty("error")] public ApiErrorDetail Error;
    }

    [System.Serializable]
    public sealed class ApiErrorDetail
    {
        [JsonProperty("code")] public string Code;
        [JsonProperty("message")] public string Message;
        [JsonProperty("fields")] public Dictionary<string, string> Fields;
        [JsonProperty("retryAfterSeconds")] public int? RetryAfterSeconds;
    }
}
