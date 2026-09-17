using System;
using System.Runtime.CompilerServices;
using UnityEngine.Networking;

namespace LethalMagotchi.Auth
{
    /// <summary>
    /// <c>UnityWebRequestAsyncOperation</c> has no built-in <c>await</c> support — it is a
    /// Unity-flavoured <c>AsyncOperation</c>, not a <c>Task</c>. This is the standard
    /// community-documented awaiter that bridges the two: it lets every call site in this
    /// assembly write <c>await request.SendWebRequest();</c> directly instead of hand-rolling
    /// a coroutine-and-callback dance per request, which is what makes
    /// <see cref="NativeAuthGateway"/>'s single-flight <c>SemaphoreSlim</c> guard (§14.5)
    /// expressible at all — that pattern needs real <c>async</c>/<c>await</c>, not coroutines.
    /// </summary>
    public static class UnityWebRequestAwaiterExtensions
    {
        public static UnityWebRequestAwaiter GetAwaiter(this UnityWebRequestAsyncOperation op)
        {
            return new UnityWebRequestAwaiter(op);
        }
    }

    public readonly struct UnityWebRequestAwaiter : INotifyCompletion
    {
        private readonly UnityWebRequestAsyncOperation _op;

        public UnityWebRequestAwaiter(UnityWebRequestAsyncOperation op)
        {
            _op = op;
        }

        public bool IsCompleted => _op.isDone;

        public void OnCompleted(Action continuation)
        {
            // completed fires on Unity's main thread as part of the normal player loop, so
            // no synchronization context juggling is needed here — unlike a generic Task
            // awaiter, this never resumes off-thread.
            _op.completed += _ => continuation();
        }

        /// <summary>
        /// Deliberately returns nothing rather than the request/response — the awaited
        /// expression is only ever used for its side effect (waiting for completion); the
        /// caller already holds the <c>UnityWebRequest</c> it sent and reads
        /// <c>result</c>/<c>downloadHandler.text</c> off that, not off the awaiter.
        /// </summary>
        public void GetResult()
        {
        }
    }
}
