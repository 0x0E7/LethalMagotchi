import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AccountDto, CharacterDto } from '@lethalmagotchi/shared';
import { api, setAccessToken } from '../api/client.js';

type Status = 'loading' | 'anonymous' | 'authenticated';

interface SessionValue {
  status: Status;
  account: AccountDto | null;
  character: CharacterDto | null;
  login: (input: { username: string; password: string }) => Promise<void>;
  register: (input: { username: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
  setCharacter: (character: CharacterDto) => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [account, setAccount] = useState<AccountDto | null>(null);
  const [character, setCharacterState] = useState<CharacterDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const restored = await api.restoreSession().catch(() => null);
      if (cancelled) return;
      if (restored) {
        setAccount(restored.account);
        setCharacterState(restored.character);
        setStatus('authenticated');
      } else {
        setStatus('anonymous');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const adopt = useCallback((session: { accessToken: string; account: AccountDto; character: CharacterDto | null }) => {
    setAccessToken(session.accessToken);
    setAccount(session.account);
    setCharacterState(session.character);
    setStatus('authenticated');
  }, []);

  const login = useCallback(
    async (input: { username: string; password: string }) => {
      adopt(await api.login(input));
    },
    [adopt],
  );

  const register = useCallback(
    async (input: { username: string; password: string }) => {
      adopt(await api.register(input));
    },
    [adopt],
  );

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setAccessToken(null);
    setAccount(null);
    setCharacterState(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo<SessionValue>(
    () => ({ status, account, character, login, register, logout, setCharacter: setCharacterState }),
    [status, account, character, login, register, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
