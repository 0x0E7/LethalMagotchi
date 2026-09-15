import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { GroupInviteDto, MyGroupDto, MyGroupResponse, ServerMessage } from '@lethalmagotchi/shared';
import { api } from '../api/client.js';
import { useSession } from '../session/SessionProvider.js';
import { useSocket } from '../ws/SocketProvider.js';

interface GroupValue {
  group: MyGroupDto | null;
  invites: GroupInviteDto[];
  loaded: boolean;
  busy: boolean;
  note: string | null;
  refresh: () => Promise<void>;
  create: (name: string) => Promise<boolean>;
  invite: (accountId: string) => Promise<boolean>;
  respond: (inviteId: string, accept: boolean) => Promise<void>;
  leave: () => Promise<void>;
  remove: (accountId: string) => Promise<void>;
  dismissNote: () => void;
}

const GroupContext = createContext<GroupValue | null>(null);

/**
 * Groups are not real-time, so this is a plain fetch-and-replace store rather than a reducer
 * over socket frames: every mutation answers with the caller's whole group, and that answer
 * is what goes on screen. The socket only ever tells it *that* something changed.
 */
export function GroupProvider({ children }: { children: ReactNode }) {
  const { status: sessionStatus, character } = useSession();
  const socket = useSocket();
  const enabled = sessionStatus === 'authenticated' && character !== null;
  const [state, setState] = useState<MyGroupResponse>({ group: null, invites: [] });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const response = await api.myGroup().catch(() => null);
    if (!response) return;
    setState(response);
    setLoaded(true);
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onMessage = useCallback(
    (message: ServerMessage) => {
      // `group:sync` is an invitation arriving; `ready` is a reconnect, after which any
      // `group:sync` sent while the socket was down is gone and only a re-read can find it.
      if (message.type === 'group:sync' || message.type === 'ready') void refresh();
    },
    [refresh],
  );

  useEffect(() => socket.subscribe(onMessage), [socket, onMessage]);

  /** One place that turns a failed call into something a player can read. */
  const run = useCallback(async (work: () => Promise<MyGroupResponse | null>): Promise<boolean> => {
    setBusy(true);
    setNote(null);
    try {
      const response = await work();
      if (response) {
        setState(response);
        setLoaded(true);
      }
      return true;
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Something went wrong.');
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const create = useCallback((name: string) => run(() => api.createGroup(name)), [run]);

  const invite = useCallback(
    async (accountId: string) => {
      const group = state.group;
      if (!group) return false;
      const sent = await run(async () => {
        await api.inviteToGroup(group.id, accountId);
        return null;
      });
      if (sent) setNote('Invitation sent.');
      return sent;
    },
    [run, state.group],
  );

  const respond = useCallback(
    async (inviteId: string, accept: boolean) => {
      const answered = await run(() => api.respondToGroupInvite(inviteId, accept));
      // A refusal here usually means the invitation is gone or the group filled up, and the
      // list on screen is the thing that is now wrong.
      if (!answered) await refresh();
    },
    [refresh, run],
  );

  const leave = useCallback(async () => {
    await run(() => api.leaveGroup());
  }, [run]);

  const remove = useCallback(
    async (accountId: string) => {
      const group = state.group;
      if (!group) return;
      await run(() => api.removeFromGroup(group.id, accountId));
    },
    [run, state.group],
  );

  const value = useMemo<GroupValue>(
    () => ({
      group: state.group,
      invites: state.invites,
      loaded,
      busy,
      note,
      refresh,
      create,
      invite,
      respond,
      leave,
      remove,
      dismissNote: () => setNote(null),
    }),
    [state, loaded, busy, note, refresh, create, invite, respond, leave, remove],
  );

  if (!enabled) return <>{children}</>;
  return <GroupContext.Provider value={value}>{children}</GroupContext.Provider>;
}

/** Null until the player has a character — joining a group needs one, exactly like chat. */
export function useGroup(): GroupValue | null {
  return useContext(GroupContext);
}
