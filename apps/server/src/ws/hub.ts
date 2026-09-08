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

  add(connection: Connection): void {
    this.byId.set(connection.id, connection);
    if (connection.characterId) {
      const set = this.byCharacter.get(connection.characterId) ?? new Set<string>();
      set.add(connection.id);
      this.byCharacter.set(connection.characterId, set);
    }
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
    return connection;
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

  closeAll(): void {
    for (const connection of this.byId.values()) connection.socket.close(1001, 'server shutting down');
    this.byId.clear();
    this.byCharacter.clear();
  }
}
