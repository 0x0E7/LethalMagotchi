using UnityEngine;

namespace LethalMagotchi.Auth
{
    /// <summary>
    /// Which backend this build talks to. A <c>ScriptableObject</c> asset rather than a
    /// hardcoded constant, following the same pattern <c>v2-architecture.md</c> §6.3 already
    /// uses for designer-editable data (<c>SpeciesDefinition</c> etc.) — one asset per
    /// environment (Dev/Staging/Prod), swapped per build target rather than edited in code.
    /// </summary>
    [CreateAssetMenu(fileName = "ServerConfig", menuName = "LethalMagotchi/Server Config")]
    public sealed class ServerConfig : ScriptableObject
    {
        [Tooltip("No trailing slash. e.g. https://api.lethalmagotchi.example")]
        [SerializeField] private string baseUrl = "http://localhost:8080";

        [Tooltip("Seconds before a request is abandoned as failed, distinct from the server's " +
                 "own timeouts — this is what stops a dead connection hanging the UI forever.")]
        [SerializeField] private int requestTimeoutSeconds = 15;

        public string BaseUrl => baseUrl;
        public int RequestTimeoutSeconds => requestTimeoutSeconds;
    }
}
