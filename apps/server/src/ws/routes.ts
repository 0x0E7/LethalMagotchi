import type { Socket } from 'node:net';
import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import {
  WS_AUTH_TIMEOUT_MS,
  WS_PATH,
  clientMessageSchema,
  type ServerMessage,
} from '@lethalmagotchi/shared';
import type { ServerDeps } from '../deps.js';
import { ApiError } from '../errors.js';
import { findActiveCharacterByAccount } from '../repos/characters.js';
import { uuidv7 } from '../uuid.js';

/**
 * Only *unauthenticated* sockets are capped per address, and only until they authenticate:
 * a socket that presents a valid token hands its slot straight back. A shared public
 * address (carrier NAT, campus, office) therefore carries as many players as it likes and
 * one anonymous flooder can never lock them out — what it can exhaust is the handshake
 * budget, which an honest client occupies for milliseconds and an abusive one for the five
 * second auth deadline at most.
 */
export const MAX_ANON_SOCKETS_PER_IP = 64;

/**
 * Above this many outstanding anonymous sockets an address is presumed to be parking them,
 * and the rest get a much shorter deadline to prove otherwise. A real client sends `auth`
 * on the open event with the token already in hand, so a second is generous for it and
 * five times more expensive for whoever is squatting on the handshake budget.
 */
const ANON_PRESSURE_THRESHOLD = MAX_ANON_SOCKETS_PER_IP / 2;
const ANON_PRESSURE_AUTH_TIMEOUT_MS = 1_000;

/** The real ceiling once a token is on the table: tabs and devices of one player. */
export const MAX_SOCKETS_PER_ACCOUNT = 16;

/**
 * `auth` attempts an anonymous socket may make while the shared address bucket is spent.
 * An honest client needs exactly one; the allowance exists so a flooder cannot poison the
 * `ip:` bucket into a state where a co-NATed player can never authenticate at all. The
 * address bucket is still charged underneath it, so the flooder keeps accruing strikes.
 */
const PREAUTH_GRANT_FRAMES = 2;

/** Frames a client may keep sending after being told it is over the limit, before the socket goes. */
const REFUSALS_BEFORE_CLOSE = 100;

function isAuthFrame(raw: Buffer): boolean {
  try {
    return clientMessageSchema.safeParse(JSON.parse(raw.toString())).data?.type === 'auth';
  } catch {
    return false;
  }
}

/**
 * Live socket counts per key. `acquire` hands back the release rather than wiring it to a
 * socket event, because an anonymous slot is released early — on a successful auth — and
 * not only when the connection ends.
 */
class ConnectionCounter {
  private readonly counts = new Map<string, number>();

  acquire(key: string, limit: number): (() => void) | null {
    const held = this.counts.get(key) ?? 0;
    if (held >= limit) return null;
    this.counts.set(key, held + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.counts.get(key) ?? 1) - 1;
      if (remaining > 0) this.counts.set(key, remaining);
      else this.counts.delete(key);
    };
  }

  held(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}

export async function registerWebSocket(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  const { db, hub, tournaments, limiters } = deps;

  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });

  const anonymous = new ConnectionCounter();
  const perAccount = new ConnectionCounter();
  /**
   * Carries the anonymous slot from `preValidation` to the connection handler, which is
   * where it is given back on a successful auth. Keyed by the raw TCP socket because a
   * rejected upgrade never produces a websocket to hang anything off.
   */
  const anonymousSlots = new WeakMap<Socket, () => void>();

  app.get(
    WS_PATH,
    {
      websocket: true,
      preValidation: async (request) => {
        // A plain GET of this path is answered with a 404 by the plugin and never holds a
        // socket, so only real upgrades are counted against the cap.
        if (!request.ws) return;
        const release = anonymous.acquire(request.ip, MAX_ANON_SOCKETS_PER_IP);
        if (!release) {
          throw new ApiError(429, 'RATE_LIMITED', 'Too many unauthenticated connections from this address.');
        }
        anonymousSlots.set(request.raw.socket, release);
        request.raw.socket.once('close', release);
      },
    },
    (socket, request) => {
      const connectionId = uuidv7();
      const ip = request.ip;
      const releaseAnonymousSlot = anonymousSlots.get(request.raw.socket);
      let releaseAccountSlot: (() => void) | null = null;
      let accountId: string | null = null;
      let characterId: string | null = null;
      let refusals = 0;
      let preAuthGrant = PREAUTH_GRANT_FRAMES;

      const send = (message: ServerMessage): void => {
        socket.send(JSON.stringify(message));
      };

      /**
       * The budget an abuser cannot escape by reconnecting or by staying anonymous: it
       * follows the account once one is presented, and the address until then.
       */
      const sourceKey = (): string => (accountId ? `account:${accountId}` : `ip:${ip}`);

      const refuse = (): void => {
        refusals += 1;
        // One courtesy frame per flood episode. Answering every refused frame is itself
        // the amplifier — a garbage frame in must not buy an error frame out.
        if (refusals === 1) {
          send({ type: 'tourney:rejected', code: 'RATE_LIMITED', seq: null, message: 'Slow down a moment.' });
        } else if (refusals > REFUSALS_BEFORE_CLOSE) {
          socket.close(1008, 'rate limited');
        }
      };

      // The socket is anonymous until it presents an access token, mirroring the
      // documented `auth` first-message protocol rather than a token in the URL.
      const authDeadline = setTimeout(
        () => {
          if (!accountId) {
            send({ type: 'error', code: 'UNAUTHENTICATED', message: 'Send an auth message first.' });
            socket.close(4401, 'unauthenticated');
          }
        },
        anonymous.held(ip) > ANON_PRESSURE_THRESHOLD ? ANON_PRESSURE_AUTH_TIMEOUT_MS : WS_AUTH_TIMEOUT_MS,
      );
      authDeadline.unref?.();

      socket.on('message', (raw: Buffer) => {
        /**
         * Ahead of the parse and of every auth, type and validity check: malformed JSON,
         * unrecognised messages, pings and real gameplay all cost the same budget, so no
         * cheap path is left unthrottled. Both buckets are charged, never short-circuited.
         */
        const perSocket = limiters.wsMessages.check(connectionId);
        const perSource = limiters.wsSource.check(sourceKey());
        if (!perSocket.allowed || !perSource.allowed) {
          /**
           * The address bucket is shared by everyone behind one NAT, so a flooder must not
           * be able to stop a co-NATed player from ever authenticating. A socket that is
           * still anonymous and still within its per-socket budget may therefore spend a
           * couple of over-budget frames — but only on an `auth` that actually parses.
           * Anything else is dropped unanswered, so the grace buys an abuser no output.
           */
          if (accountId !== null || !perSocket.allowed || preAuthGrant === 0 || !isAuthFrame(raw)) {
            refuse();
            return;
          }
          preAuthGrant -= 1;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          send({ type: 'error', code: 'BAD_MESSAGE', message: 'Expected JSON.' });
          return;
        }

        const result = clientMessageSchema.safeParse(parsed);
        if (!result.success) {
          send({ type: 'error', code: 'BAD_MESSAGE', message: 'Unrecognised message.' });
          return;
        }
        const message = result.data;

        if (message.type === 'auth') {
          if (accountId) return;
          void (async () => {
            let subject: string;
            try {
              subject = app.jwt.verify<{ sub: string }>(message.token).sub;
            } catch {
              send({ type: 'error', code: 'UNAUTHENTICATED', message: 'Sign in to continue.' });
              socket.close(4401, 'unauthenticated');
              return;
            }

            const accountSlot = perAccount.acquire(subject, MAX_SOCKETS_PER_ACCOUNT);
            if (!accountSlot) {
              send({ type: 'error', code: 'RATE_LIMITED', message: 'Too many open connections for this account.' });
              socket.close(1008, 'too many connections');
              return;
            }

            try {
              clearTimeout(authDeadline);
              accountId = subject;
              releaseAccountSlot = accountSlot;
              // The handshake is over, so the address gets its slot back immediately: the
              // per-account cap is what bounds this socket from here on.
              releaseAnonymousSlot?.();
              const character = await findActiveCharacterByAccount(db, subject);
              characterId = character?.id ?? null;

              hub.add({ id: connectionId, accountId: subject, characterId, socket });
              send({ type: 'ready', accountId: subject, characterId });
              if (characterId) tournaments.onCharacterOnline(characterId);
            } catch (error) {
              // This runs detached from the message handler, so an unhandled rejection here
              // would take the whole process down with it — one bad socket must only ever
              // cost that socket.
              app.log.error({ err: error }, 'websocket auth failed');
              accountSlot();
              releaseAccountSlot = null;
              socket.close(1011, 'internal error');
            }
          })();
          return;
        }

        if (!accountId) {
          send({ type: 'error', code: 'UNAUTHENTICATED', message: 'Send an auth message first.' });
          return;
        }

        if (message.type === 'ping') return;

        if (!characterId) {
          send({ type: 'error', code: 'NOT_SEATED', message: 'You do not have a character.' });
          return;
        }

        if (message.type === 'tourney:resync') {
          const resyncFlood = limiters.wsResync.check(connectionId);
          if (!resyncFlood.allowed) {
            refuse();
            return;
          }
          tournaments.resync(characterId);
          return;
        }

        const seated = tournaments.act(characterId, {
          handId: message.handId,
          seq: message.seq,
          action: message.action,
          ...(message.amount === undefined ? {} : { amount: message.amount }),
        });
        if (!seated) send({ type: 'error', code: 'NOT_SEATED', message: 'You are not at a table.' });
      });

      socket.on('close', () => {
        clearTimeout(authDeadline);
        releaseAccountSlot?.();
        hub.remove(connectionId);
        // Only the per-connection buckets are dropped, and their key — a fresh uuid per
        // socket — is never reused. Escalating backoff lives on `wsSource`, which is keyed
        // by account or address and deliberately survives a reconnect.
        limiters.wsMessages.reset(connectionId);
        limiters.wsResync.reset(connectionId);
        if (characterId) tournaments.onCharacterOffline(characterId);
      });
    },
  );
}
