using System;
using System.Threading.Tasks;

namespace LethalMagotchi.Auth.Tests
{
    /// <summary>Scripted <see cref="IAuthGateway"/> for <c>AuthServiceTests</c> — no
    /// <c>UnityWebRequest</c>, no network, so these tests run in milliseconds and exercise
    /// exactly the branch under test.</summary>
    internal sealed class FakeAuthGateway : IAuthGateway
    {
        public Func<string, string, Task<SessionResponseV2>> OnLogin;
        public Func<string, string, Task<SessionResponseV2>> OnRegister;
        public int RefreshCallCount;

        public string CurrentAccessToken { get; private set; }
        public bool HasSession => CurrentAccessToken != null;
        public event Action SessionExpired;

        public Task<SessionResponseV2> RegisterAsync(string username, string password) =>
            OnRegister?.Invoke(username, password) ?? throw new InvalidOperationException("OnRegister not scripted.");

        public Task<SessionResponseV2> LoginAsync(string username, string password) =>
            OnLogin?.Invoke(username, password) ?? throw new InvalidOperationException("OnLogin not scripted.");

        public Task<SessionResponseV2> TryRestoreSessionAsync() => Task.FromResult<SessionResponseV2>(null);

        public Task RefreshAsync()
        {
            RefreshCallCount++;
            return Task.CompletedTask;
        }

        public Task LogoutAsync()
        {
            CurrentAccessToken = null;
            return Task.CompletedTask;
        }

        public void RaiseSessionExpired() => SessionExpired?.Invoke();
    }

    /// <summary>Scripted <see cref="IUsernameAvailabilityApi"/>.</summary>
    internal sealed class FakeUsernameApi : IUsernameAvailabilityApi
    {
        public Func<string, Task<UsernameAvailabilityResponse>> OnCheck;
        public int CallCount;

        public Task<UsernameAvailabilityResponse> CheckUsernameAsync(string username)
        {
            CallCount++;
            return OnCheck?.Invoke(username)
                ?? Task.FromResult(new UsernameAvailabilityResponse { Username = username, Available = true, Suggestions = new() });
        }
    }
}
