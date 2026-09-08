import type { ServerMessage } from '@lethalmagotchi/shared';

export interface Socket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface Connection {
  id: string;
  accountId: string;
  characterId: string | null;
  socket: Socket;
}

/**
 * The connection registry. Every outbound message goes through here, and there is
 * deliberately no "send to everyone at this table" primitive that takes a payload
 * containing hole cards — table fan-out composes per-seat sends instead, so a private
 * payload can never be handed to a broadcast helper by accident.
 */
export class Hub {
  private readonly byId = new Map<string, Connection>();
  private readonly byCharacter = new Map<string, Set<string>>();
  private readonly byAccount = new Map<string, Set<string>>();

  add(connection: Connection): void {
    this.byId.set(connection.id, connection);
    if (connection.characterId) {
      const set = this.byCharacter.get(connection.characterId) ?? new Set<string>();
      set.add(connection.id);
      this.byCharacter.set(connection.characterId, set);
    }
    const accountSet = this.byAccount.get(connection.accountId) ?? new Set<string>();
    accountSet.add(connection.id);
    this.byAccount.set(connection.accountId, accountSet);
  }

  remove(connectionId: string): Connection | null {
    const connection = this.byId.get(connectionId);
    if (!connection) return null;
    this.byId.delete(connectionId);
    if (connection.characterId) {
      const set = this.byCharacter.get(connection.characterId);
      set?.delete(connectionId);
      if (set && set.size === 0) this.byCharacter.delete(connection.characterId);
    }
    const accountSet = this.byAccount.get(connection.accountId);
    accountSet?.delete(connectionId);
    if (accountSet && accountSet.size === 0) this.byAccount.delete(connection.accountId);
    return connection;
  }

  /**
   * Re-points every live socket of an account at the character it has right now. A socket
   * resolves its character once, at auth, so an account that gains or loses one mid-connection
   * would otherwise carry a stale binding — and a wrong one is unusable, not merely stale —
   * until it happens to reconnect.
   */
  rebindAccount(
    accountId: string,
    characterId: string | null,
  ): { connection: Connection; previousCharacterId: string | null }[] {
    const changed: { connection: Connection; previousCharacterId: string | null }[] = [];
    for (const connection of this.connectionsForAccounts([accountId])) {
      const previousCharacterId = connection.characterId;
      if (previousCharacterId === characterId) continue;
      if (previousCharacterId) {
        const set = this.byCharacter.get(previousCharacterId);
        set?.delete(connection.id);
        if (set && set.size === 0) this.byCharacter.delete(previousCharacterId);
      }
      connection.characterId = characterId;
      if (characterId) {
        const set = this.byCharacter.get(characterId) ?? new Set<string>();
        set.add(connection.id);
        this.byCharacter.set(characterId, set);
      }
      changed.push({ connection, previousCharacterId });
    }
    return changed;
  }

  isOnline(characterId: string): boolean {
    return (this.byCharacter.get(characterId)?.size ?? 0) > 0;
  }

  onlineCharacterIds(): string[] {
    return [...this.byCharacter.keys()];
  }

  get size(): number {
    return this.byId.size;
  }

  sendTo(connectionId: string, message: ServerMessage): void {
    this.byId.get(connectionId)?.socket.send(JSON.stringify(message));
  }

  /** Unicast by character — every socket that character has open, and no other. */
  sendToCharacter(characterId: string, message: ServerMessage): void {
    const connections = this.byCharacter.get(characterId);
    if (!connections) return;
    const payload = JSON.stringify(message);
    for (const connectionId of connections) {
      this.byId.get(connectionId)?.socket.send(payload);
    }
  }

  sendToCharacters(characterIds: Iterable<string>, message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const characterId of characterIds) {
      for (const connectionId of this.byCharacter.get(characterId) ?? []) {
        this.byId.get(connectionId)?.socket.send(payload);
      }
    }
  }

  /**
   * Chat fan-out is account-scoped rather than character-scoped: channel membership is an
   * account property, and a player's other tabs must see their own DMs too. Callers pass a
   * recipient list the server derived from `chat_channel_members`, never one from a client.
   */
  sendToAccounts(accountIds: Iterable<string>, message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const accountId of accountIds) {
      for (const connectionId of this.byAccount.get(accountId) ?? []) {
        this.byId.get(connectionId)?.socket.send(payload);
      }
    }
  }

  connectionsForAccounts(accountIds: Iterable<string>): Connection[] {
    const found: Connection[] = [];
    for (const accountId of accountIds) {
      for (const connectionId of this.byAccount.get(accountId) ?? []) {
        const connection = this.byId.get(connectionId);
        if (connection) found.push(connection);
      }
    }
    return found;
  }

  /**
   * Every socket that has a character, minus the given accounts. The Town Square is the one
   * channel whose membership is "everyone playing", so it is the only caller — and the
   * exclusion set is how a blocked author stays out of the blocker's stream.
   */
  playerConnections(exceptAccountIds: ReadonlySet<string> = new Set()): Connection[] {
    const found: Connection[] = [];
    for (const connection of this.byId.values()) {
      if (!connection.characterId) continue;
      if (exceptAccountIds.has(connection.accountId)) continue;
      found.push(connection);
    }
    return found;
  }

  closeAll(): void {
    for (const connection of this.byId.values()) connection.socket.close(1001, 'server shutting down');
    this.byId.clear();
    this.byCharacter.clear();
    this.byAccount.clear();
  }
}
