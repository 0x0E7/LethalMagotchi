import { useCallback, useEffect, useRef, useState } from 'react';
import { WS_PATH, type ClientMessage, type ServerMessage } from '@lethalmagotchi/shared';
import { currentAccessToken } from '../api/client.js';

const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];

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

  const send = useCallback((message: ClientMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
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
