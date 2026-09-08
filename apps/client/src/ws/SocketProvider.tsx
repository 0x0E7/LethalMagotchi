import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';
import type { ClientMessage, ServerMessage } from '@lethalmagotchi/shared';
import { useSession } from '../session/SessionProvider.js';
import { useGameSocket, type SocketStatus } from './useGameSocket.js';

export type ServerMessageHandler = (message: ServerMessage) => void;

interface SocketValue {
  status: SocketStatus;
  send: (message: ClientMessage) => void;
  subscribe: (handler: ServerMessageHandler) => () => void;
}

const SocketContext = createContext<SocketValue | null>(null);

/**
 * One socket for the session, shared by every feature that speaks over it. Chat and the
 * tournament both need the same connection — a second one would double every per-account
 * connection budget the server enforces, for nothing.
 */
export function SocketProvider({ children }: { children: ReactNode }) {
  const { status: sessionStatus } = useSession();
  const handlers = useRef(new Set<ServerMessageHandler>());

  const onMessage = useCallback((message: ServerMessage) => {
    for (const handler of [...handlers.current]) handler(message);
  }, []);

  const socket = useGameSocket({ enabled: sessionStatus === 'authenticated', onMessage });

  const subscribe = useCallback((handler: ServerMessageHandler) => {
    handlers.current.add(handler);
    return () => {
      handlers.current.delete(handler);
    };
  }, []);

  const value = useMemo<SocketValue>(
    () => ({ status: socket.status, send: socket.send, subscribe }),
    [socket.status, socket.send, subscribe],
  );

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket(): SocketValue {
  const value = useContext(SocketContext);
  if (!value) throw new Error('useSocket must be used inside SocketProvider');
  return value;
}
