import { useCallback, useEffect, useRef, useState } from 'react';
import { WS_PATH, type ClientMessage, type ServerMessage } from '@lethalmagotchi/shared';
import { currentAccessToken } from '../api/client.js';

const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];

/**
 * Messages sent before the socket is live are held rather than dropped. Bounded because a
 * long offline spell must not grow without limit; the oldest go first, since the newest
 * intent is the one worth keeping.
 */
const MAX_QUEUED_MESSAGES = 32;

export type SocketStatus = 'connecting' | 'open' | 'offline';

interface Options {
  enabled: boolean;
  onMessage: (message: ServerMessage) => void;
}

export interface GameSocket {
  status: SocketStatus;
  send: (message: ClientMessage) => void;
}

function socketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${WS_PATH}`;
}

/**
 * One socket for the whole session, reconnecting with backoff. Every reconnect ends in a
 * `tourney:resync`, so a player who drops mid-hand is put back exactly where they were
 * rather than being shown a stale table.
 */
export function useGameSocket({ enabled, onMessage }: Options): GameSocket {
  const [status, setStatus] = useState<SocketStatus>('connecting');
  const socketRef = useRef<WebSocket | null>(null);
  const handler = useRef(onMessage);
  handler.current = onMessage;

  const queued = useRef<ClientMessage[]>([]);

  /**
   * A send before the socket is live used to vanish silently, which is how a chat message
   * could sit on "Sending…" forever: the caller had already marked it pending and nothing
   * ever came back to settle it. Hold it instead and flush once the server says `ready`.
   *
   * Replaying a stale gameplay frame after a reconnect is safe by construction — every
   * real-time protocol here echoes a `seq` and rejects a stale or duplicate one, which is
   * exactly the case those guards exist for.
   */
  const send = useCallback((message: ClientMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      return;
    }
    if (queued.current.length >= MAX_QUEUED_MESSAGES) queued.current.shift();
    queued.current.push(message);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus('offline');
      return;
    }

    let cancelled = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = async (): Promise<void> => {
      if (cancelled) return;
      setStatus('connecting');

      const token = await currentAccessToken();
      if (cancelled) return;
      if (!token) {
        scheduleRetry();
        return;
      }

      const socket = new WebSocket(socketUrl());
      socketRef.current = socket;

      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'auth', token } satisfies ClientMessage));
      };

      socket.onmessage = (event: MessageEvent<string>) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }
        if (message.type === 'ready') {
          attempt = 0;
          setStatus('open');
          socket.send(JSON.stringify({ type: 'tourney:resync' } satisfies ClientMessage));
          // Anything typed while the socket was down goes out now, in the order it was
          // written. Flushed after `ready` rather than after `open`, so it lands on an
          // authenticated socket bound to a character.
          const pending = queued.current;
          queued.current = [];
          for (const held of pending) socket.send(JSON.stringify(held));
        }
        handler.current(message);
      };

      socket.onclose = () => {
        socketRef.current = null;
        if (cancelled) return;
        setStatus('offline');
        scheduleRetry();
      };

      socket.onerror = () => socket.close();
    };

    const scheduleRetry = (): void => {
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!;
      attempt += 1;
      retryTimer = setTimeout(() => void connect(), delay);
    };

    void connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [enabled]);

  return { status, send };
}
