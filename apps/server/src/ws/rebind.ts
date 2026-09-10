import type { ServerMessage } from '@lethalmagotchi/shared';
import type { DuelService } from '../duel/service.js';
import type { TournamentService } from '../tournament/service.js';
import type { Hub } from './hub.js';

/**
 * Called whenever an account's active character changes, so a socket that authenticated
 * before the character existed — or that outlived a delete and rebuild — is put right
 * without waiting for a reconnect it has no reason to make.
 *
 * Announced with a fresh `ready`: that frame already means "this is the character this
 * socket is bound to", and both the channel refetch and the table resync are wired to it.
 */
export function rebindAccountCharacter(
  deps: { hub: Hub; tournaments: TournamentService; duels: DuelService },
  accountId: string,
  characterId: string | null,
): void {
  const changed = deps.hub.rebindAccount(accountId, characterId);
  if (changed.length === 0) return;

  const payload = JSON.stringify({ type: 'ready', accountId, characterId } satisfies ServerMessage);
  for (const { connection, previousCharacterId } of changed) {
    connection.socket.send(payload);
    if (previousCharacterId) {
      deps.tournaments.onCharacterOffline(previousCharacterId);
      deps.duels.onCharacterOffline(previousCharacterId);
    }
  }
  if (characterId) {
    deps.tournaments.onCharacterOnline(characterId);
    deps.duels.onCharacterOnline(characterId);
  }
}
