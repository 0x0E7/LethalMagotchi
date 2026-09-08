import { WebSocket } from 'ws';
import { WS_PATH, type ClientMessage, type ServerMessage, type ServerMessageType } from '@lethalmagotchi/shared';

/**
 * A recording WS client. `frames` keeps the *raw serialized text* of every message this
 * socket received — the leak tests assert against that string, not against parsed
 * fields, so a newly added leaky field fails loudly instead of passing unnoticed.
 */
export class TestClient {
  readonly frames: string[] = [];
  readonly messages: ServerMessage[] = [];
  private readonly socket: WebSocket;
  private readonly waiters: { match: (message: ServerMessage) => boolean; resolve: (message: ServerMessage) => void }[] = [];
  /**
   * Messages already handed to a `next()` caller. Without this, a message that arrives
   * between two awaits is invisible to the next waiter — which is exactly what a
   * reconnect resync does, since the server pushes state the instant `auth` lands.
   */
  private readonly consumed = new Set<number>();
  private closed = false;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (raw: Buffer) => {
      const text = raw.toString();
      this.frames.push(text);
      const message = JSON.parse(text) as ServerMessage;
      const index = this.messages.push(message) - 1;
      for (const waiter of [...this.waiters]) {
        if (this.consumed.has(index) || !waiter.match(message)) continue;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        this.consumed.add(index);
        waiter.resolve(message);
      }
    });
    socket.on('close', () => {
      this.closed = true;
    });
  }

  static async connect(baseUrl: string, token: string): Promise<TestClient> {
    const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}${WS_PATH}`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const client = new TestClient(socket);
    client.send({ type: 'auth', token });
    await client.next('ready');
    return client;
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  /** Resolves with the first message of `type` received after this call, or already seen. */
  next<T extends ServerMessageType>(
    type: T,
    predicate: (message: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    timeoutMs = 15_000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const match = (message: ServerMessage): boolean =>
      message.type === type && predicate(message as Extract<ServerMessage, { type: T }>);

    return new Promise((resolve, reject) => {
      for (const [index, message] of this.messages.entries()) {
        if (this.consumed.has(index) || !match(message)) continue;
        this.consumed.add(index);
        resolve(message as Extract<ServerMessage, { type: T }>);
        return;
      }

      const timer = setTimeout(() => {
        reject(
          new Error(
            `timed out waiting for ${type}; saw: ${this.messages.map((message) => message.type).join(', ')}`,
          ),
        );
      }, timeoutMs);

      this.waiters.push({
        match,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message as Extract<ServerMessage, { type: T }>);
        },
      });
    });
  }

  received<T extends ServerMessageType>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.messages.filter((message) => message.type === type) as Extract<ServerMessage, { type: T }>[];
  }

  transcript(): string {
    return this.frames.join('\n');
  }

  close(): void {
    if (!this.closed) this.socket.close();
  }
}

export async function closeAll(clients: TestClient[]): Promise<void> {
  for (const client of clients) client.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
}
