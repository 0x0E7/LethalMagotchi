import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import {
  MESSAGE_MAX,
  TOWN_SQUARE_CHANNEL_ID,
  TOWN_SQUARE_NAME,
  authorBadge,
  isChickenBadgeActive,
  type ChatChannelDto,
  type DuelCardDto,
} from '@lethalmagotchi/shared';
import { duelUnavailable } from '../duel/DuelFinder.js';
import { useDuel } from '../duel/DuelProvider.js';
import { PeoplePicker } from './PeoplePicker.js';
import { GroupPanel } from '../groups/GroupPanel.js';
import { useGroup } from '../groups/GroupProvider.js';
import { DonateDialog } from '../raid/DonateDialog.js';
import { useRaid } from '../raid/RaidProvider.js';
import { announcementMatches, useAnnouncer } from '../routes/pet/hooks.js';
import { useSession } from '../session/SessionProvider.js';
import { useChat } from './ChatProvider.js';
import type { Thread } from './state.js';

const NEAR_BOTTOM_PX = 80;
const LOAD_OLDER_PX = 40;

function channelLabel(channel: ChatChannelDto): string {
  if (channel.kind === 'global') return channel.name ?? TOWN_SQUARE_NAME;
  if (channel.kind === 'group') return channel.name ?? 'Group';
  return channel.counterpart?.nickname || '[deleted user]';
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Two players may share a nickname, so the name alone does not say who wrote a line. The
 * tag is derived from the account id and is the same everywhere that account speaks.
 */
function AuthorTag({ accountId }: { accountId: string }) {
  const { tag, hue } = authorBadge(accountId);
  return (
    <span className="chat-tag" style={{ '--tag-hue': hue } as CSSProperties}>
      <span className="chat-tag-dot" aria-hidden="true" />
      <span className="sr-only">identity tag </span>#{tag}
    </span>
  );
}

/**
 * A player's duel standing, shown where their name is. There is no player card in the
 * product yet, so the Town Square is where this lives — the same scoping-down chat itself
 * did when it needed a place to put "message this player".
 */
function DuelStanding({ card, now }: { card: DuelCardDto; now: number }) {
  const chicken = isChickenBadgeActive(card.chickenBadgeUntil, now);
  return (
    <>
      {/* Group names are unique where nicknames are not, so this doubles as a second
          identity signal beside the `#tag` — which it does not replace. */}
      {card.groupName !== null && (
        <span className="chat-group-tag" title={`Member of ${card.groupName}`}>
          {card.groupName}
        </span>
      )}
      <span className="chat-duel-record" aria-label={`${card.duelWins} duel wins, ${card.duelLosses} losses`}>
        {card.duelWins}W · {card.duelLosses}L
      </span>
      {/* A plain state, not a punishment: it appears at zero coins and lifts on the first one. */}
      {card.isBeggar && (
        <span className="beggar-badge" title="Has nothing right now">
          beggar
        </span>
      )}
      {chicken && (
        <span className="duel-chicken" title="Turned down a duel in the last day">
          chicken
        </span>
      )}
    </>
  );
}

export function ChatPanel() {
  const chat = useChat();
  const duel = useDuel();
  const raid = useRaid();
  const group = useGroup();
  const { account, character } = useSession();
  const myCharacterId = character?.id ?? null;
  const [donating, setDonating] = useState<DuelCardDto | null>(null);
  const myAccountId = account?.id ?? null;
  const { message: announcement, announce } = useAnnouncer();
  const [view, setView] = useState<'global' | 'direct' | 'groups'>('global');
  const [draft, setDraft] = useState('');
  const logRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const nearBottom = useRef(true);

  /**
   * Grow the composer to fit what is being written. Reset to `auto` first so it shrinks back
   * when text is deleted — measuring `scrollHeight` against a stale height only ever grows.
   * The cap lives in CSS (`max-height`), and past it the textarea scrolls.
   */
  useLayoutEffect(() => {
    const box = draftRef.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${box.scrollHeight}px`;
  }, [draft]);

  const lastIncoming = chat?.lastIncoming ?? null;
  const spoken = lastIncoming ? `${lastIncoming.authorName} says ${lastIncoming.body}` : null;
  useEffect(() => {
    if (spoken !== null) announce(spoken);
  }, [spoken, announce]);

  const thread: Thread | null = chat?.activeThread ?? null;
  const messageCount = thread?.messages.length ?? 0;
  const activeChannelId = chat?.activeChannelId ?? TOWN_SQUARE_CHANNEL_ID;

  const ensureCards = duel?.ensureCards;
  const townAuthors =
    thread?.channel.kind === 'global'
      ? [...new Set(thread.messages.map((message) => message.authorCharacterId).filter((id): id is string => id !== null))].join(',')
      : '';
  useEffect(() => {
    if (!ensureCards || townAuthors === '') return;
    ensureCards(townAuthors.split(','));
  }, [ensureCards, townAuthors]);

  const groupChannelId = chat?.channels.find((channel) => channel.kind === 'group')?.id ?? null;

  // Opening a DM is something the provider can do on its own — from "message this player",
  // or from a conversation that did not exist when the panel rendered — so the tab follows
  // the active channel rather than only the tab strip.
  useEffect(() => {
    if (activeChannelId === TOWN_SQUARE_CHANNEL_ID) return;
    setView(activeChannelId === groupChannelId ? 'groups' : 'direct');
  }, [activeChannelId, groupChannelId]);

  useLayoutEffect(() => {
    const log = logRef.current;
    if (!log || !nearBottom.current) return;
    log.scrollTop = log.scrollHeight;
  }, [messageCount, chat?.activeChannelId, chat?.open]);

  if (!chat) return null;

  const dmChannels = chat.channels.filter((channel) => channel.kind === 'dm');
  const directUnread = dmChannels.reduce((sum, channel) => sum + (chat.threads[channel.id]?.unread ?? 0), 0);
  const groupUnread = groupChannelId ? (chat.threads[groupChannelId]?.unread ?? 0) : 0;
  const townUnread = chat.threads[TOWN_SQUARE_CHANNEL_ID]?.unread ?? 0;
  const inDirectList = view === 'direct' && chat.activeChannelId === TOWN_SQUARE_CHANNEL_ID;
  // The group view stands where the conversation list stands for DMs: the same
  // list-then-thread shape, with a roster in place of a list of names.
  const inGroupView = view === 'groups' && chat.activeChannelId !== groupChannelId;
  const archived = Boolean(thread?.channel.archivedAt);
  const blocked = Boolean(thread?.channel.blockedByMe);
  const canSend = thread !== null && !archived && !blocked && !inDirectList && !inGroupView;

  /**
   * The Town Square is the only place a player meets someone they have no thread with, so
   * it is where "message this player" lives — inside a DM the affordance would be circular.
   */
  const canDm = (authorAccountId: string | null): boolean =>
    authorAccountId !== null && authorAccountId !== myAccountId && thread?.channel.kind === 'global';

  /** Same guard as "message this player", plus the server's own read of duel eligibility. */
  const duelCardFor = (message: { authorAccountId: string | null; authorCharacterId: string | null }): DuelCardDto | null => {
    if (!duel || !canDm(message.authorAccountId) || !message.authorCharacterId) return null;
    return duel.cards[message.authorCharacterId] ?? null;
  };

  const onScroll = () => {
    const log = logRef.current;
    if (!log) return;
    nearBottom.current = log.scrollHeight - log.scrollTop - log.clientHeight < NEAR_BOTTOM_PX;
    if (log.scrollTop < LOAD_OLDER_PX) void chat.loadOlder(chat.activeChannelId);
  };

  const submitDraft = () => {
    if (!canSend || draft.trim().length === 0) return;
    chat.send(draft);
    setDraft('');
    nearBottom.current = true;
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submitDraft();
  };

  const openChannel = (channelId: string) => {
    chat.select(channelId);
    setView(
      channelId === TOWN_SQUARE_CHANNEL_ID ? 'global' : channelId === groupChannelId ? 'groups' : 'direct',
    );
    nearBottom.current = true;
  };

  const showTab = (next: 'global' | 'direct' | 'groups') => {
    setView(next);
    if (next === 'global') chat.select(TOWN_SQUARE_CHANNEL_ID);
    else if (next === 'groups') {
      // The segment lands on the group view, never straight into the room: joining, leaving
      // and the roster are what a player comes here for.
      if (chat.activeChannelId !== TOWN_SQUARE_CHANNEL_ID) chat.select(TOWN_SQUARE_CHANNEL_ID);
      void group?.refresh();
    } else if (chat.activeChannelId === TOWN_SQUARE_CHANNEL_ID && dmChannels[0]) {
      openChannel(dmChannels[0].id);
    }
  };

  /**
   * Shown where "message this player" is, and under the same Town Square-only rule: there is
   * no player directory in the product, so the Square is where you meet someone to invite.
   */
  const myGroup = group?.group ?? null;
  const canInviteToGroup = (authorAccountId: string | null): boolean =>
    myGroup !== null &&
    authorAccountId !== null &&
    authorAccountId !== myAccountId &&
    thread?.channel.kind === 'global' &&
    !myGroup.members.some((member) => member.accountId === authorAccountId);

  return (
    <div className="chat-dock">
      <button
        type="button"
        className="chat-toggle"
        aria-expanded={chat.open}
        aria-controls="chat-panel"
        onClick={() => chat.setOpen(!chat.open)}
      >
        <span aria-hidden="true">💬</span> Chat
        {chat.totalUnread > 0 && (
          <span className="chat-badge" aria-label={`${chat.totalUnread} unread messages`}>
            {chat.totalUnread}
          </span>
        )}
      </button>

      {chat.open && (
        <section id="chat-panel" className="chat-panel" aria-label="Chat">
          <header className="chat-head">
            <div className="segmented chat-tabs" role="tablist" aria-label="Chat channels">
              <button
                type="button"
                role="tab"
                id="chat-tab-global"
                aria-selected={view === 'global'}
                aria-controls="chat-tabpanel"
                className={view === 'global' ? 'segment active' : 'segment'}
                onClick={() => showTab('global')}
              >
                {TOWN_SQUARE_NAME}
                {townUnread > 0 && <span className="chat-badge">{townUnread}</span>}
              </button>
              <button
                type="button"
                role="tab"
                id="chat-tab-direct"
                aria-selected={view === 'direct'}
                aria-controls="chat-tabpanel"
                className={view === 'direct' ? 'segment active' : 'segment'}
                onClick={() => showTab('direct')}
              >
                Direct
                {directUnread > 0 && <span className="chat-badge">{directUnread}</span>}
              </button>
              <button
                type="button"
                role="tab"
                id="chat-tab-groups"
                aria-selected={view === 'groups'}
                aria-controls="chat-tabpanel"
                className={view === 'groups' ? 'segment active' : 'segment'}
                onClick={() => showTab('groups')}
              >
                Groups
                {groupUnread > 0 && <span className="chat-badge">{groupUnread}</span>}
                {group !== null && group.invites.length > 0 && (
                  <span className="chat-badge" aria-label={`${group.invites.length} invitations`}>
                    {group.invites.length}
                  </span>
                )}
              </button>
            </div>
            <button type="button" className="ghost small" onClick={() => chat.setOpen(false)}>
              Close
            </button>
          </header>

          <div
            id="chat-tabpanel"
            className="chat-panel-body"
            role="tabpanel"
            aria-labelledby={`chat-tab-${view}`}
          >
            {view === 'groups' && chat.activeChannelId === groupChannelId && thread && (
              <div className="chat-thread-bar">
                <button type="button" className="link" onClick={() => chat.select(TOWN_SQUARE_CHANNEL_ID)}>
                  ← Group
                </button>
                <strong>{channelLabel(thread.channel)}</strong>
              </div>
            )}

            {view === 'direct' && (
              <div className="chat-thread-bar">
                {chat.activeChannelId !== TOWN_SQUARE_CHANNEL_ID && thread ? (
                  <>
                    <button type="button" className="link" onClick={() => chat.select(TOWN_SQUARE_CHANNEL_ID)}>
                      ← All conversations
                    </button>
                    <strong>{channelLabel(thread.channel)}</strong>
                    {thread.channel.counterpart && (
                      <button
                        type="button"
                        className="ghost small"
                        onClick={() =>
                          void chat.setBlocked(thread.channel.counterpart!.accountId, !thread.channel.blockedByMe)
                        }
                      >
                        {thread.channel.blockedByMe ? 'Unblock' : 'Block'}
                      </button>
                    )}
                  </>
                ) : (
                  <span className="muted small">Pick a conversation, or message someone from the Town Square.</span>
                )}
              </div>
            )}

            {inGroupView ? (
              <GroupPanel onOpenChannel={openChannel} />
            ) : inDirectList ? (
              <div className="chat-direct-list">
                <ul className="chat-threads" aria-label="Conversations">
                  {dmChannels.length === 0 && <li className="muted small">No conversations yet.</li>}
                  {dmChannels.map((channel) => (
                    <li key={channel.id}>
                      <button type="button" className="chat-thread-row" onClick={() => openChannel(channel.id)}>
                        <span className="chat-thread-name">{channelLabel(channel)}</span>
                        {(chat.threads[channel.id]?.unread ?? 0) > 0 && (
                          <span className="chat-badge">{chat.threads[channel.id]?.unread}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>

                {/* Reaching someone used to mean waiting for them to say something in the
                    Town Square — for a message, and for a challenge just the same. This is
                    the way to find them instead. */}
                <section className="chat-people" aria-labelledby="chat-people-heading">
                  <h3 id="chat-people-heading" className="group-heading">
                    Find a player
                  </h3>
                  <PeoplePicker
                    actions={[
                      {
                        label: 'Message',
                        onPick: (card) => {
                          if (card.accountId) void chat.startDm(card.accountId);
                        },
                      },
                      {
                        label: 'Duel',
                        onPick: (card) => duel?.openStakes(card),
                        // Says what it is waiting for, rather than leaving a dead gap where a
                        // button should be.
                        unavailable: duelUnavailable,
                      },
                    ]}
                  />
                </section>
              </div>
            ) : (
              <div
                id="chat-log"
                className="chat-log"
                role="log"
                tabIndex={0}
                aria-label={thread ? `${channelLabel(thread.channel)} messages` : 'Messages'}
                ref={logRef}
                onScroll={onScroll}
              >
                {/* Outside the <ol> for the same reason `log` is: a list item carrying another
                    role is no longer a list item, and orphans the ones around it. */}
                {thread?.loadFailed && (
                  <p className="chat-failed" role="alert">
                    Could not load messages.{' '}
                    <button type="button" className="link" onClick={() => void chat.retryHistory(activeChannelId)}>
                      Try again
                    </button>
                  </p>
                )}
                {/* `log` on the <ol> itself would override its list role and orphan every <li>. */}
                <ol className="chat-log-list">
                  {thread?.hasMore && (
                    <li className="chat-older">
                      <button
                        type="button"
                        className="link"
                        disabled={thread.loadingOlder}
                        aria-busy={thread.loadingOlder}
                        onClick={() => void chat.loadOlder(chat.activeChannelId)}
                      >
                        {thread.loadingOlder
                          ? 'Loading earlier messages…'
                          : thread.olderFailed
                            ? 'Could not load earlier messages. Try again'
                            : 'Load earlier messages'}
                      </button>
                    </li>
                  )}
                  {/* An empty log only means an empty channel once history has actually landed. */}
                  {thread && !thread.loadFailed && thread.messages.length === 0 && (
                    <li className="muted small">
                      {thread.loaded ? 'Nothing here yet. Say hello.' : 'Loading messages…'}
                    </li>
                  )}
                  {thread?.messages.map((message) => (
                    <li key={message.id} className="chat-message">
                      <span className="chat-meta">
                        {canDm(message.authorAccountId) ? (
                          <button
                            type="button"
                            className="chat-author link"
                            aria-label={`Message ${message.authorName}`}
                            onClick={() => void chat.startDm(message.authorAccountId as string)}
                          >
                            {message.authorName}
                          </button>
                        ) : (
                          <span className="chat-author">{message.authorName}</span>
                        )}
                        {message.authorAccountId && <AuthorTag accountId={message.authorAccountId} />}
                        {(() => {
                          const card = duelCardFor(message);
                          if (!card) return null;
                          return (
                            <>
                              <DuelStanding card={card} now={Date.now()} />
                              {card.duelEligible && (
                                <button
                                  type="button"
                                  className="chat-duel"
                                  aria-label={`Duel ${message.authorName}`}
                                  onClick={() => duel?.openStakes(card)}
                                >
                                  Duel
                                </button>
                              )}
                              {/* One affordance, two meanings: with a party already
                                  assembling it is how the initiator fills it. */}
                              {raid?.party && raid.party.initiatorCharacterId === myCharacterId
                                ? !raid.party.members.some(
                                    (member) => member.characterId === card.characterId,
                                  ) &&
                                  card.characterId !== raid.party.target.characterId && (
                                    <button
                                      type="button"
                                      className="chat-raid"
                                      aria-label={`Invite ${message.authorName}`}
                                      onClick={() => raid.invite(card.characterId)}
                                    >
                                      Invite
                                    </button>
                                  )
                                : card.raidEligible &&
                                  raid !== null && (
                                    <button
                                      type="button"
                                      className="chat-raid"
                                      aria-label={`Raid ${message.authorName}`}
                                      onClick={() => raid.createRaid(card)}
                                    >
                                      Raid
                                    </button>
                                  )}
                              {canInviteToGroup(message.authorAccountId) && (
                                <button
                                  type="button"
                                  className="chat-group-invite"
                                  aria-label={`Invite ${message.authorName} to your group`}
                                  onClick={() => void group?.invite(message.authorAccountId as string)}
                                >
                                  Add to group
                                </button>
                              )}
                              {/* Absent, never disabled, for anyone who is not currently a
                                  beggar — the same rule the admin panel established. */}
                              {card.isBeggar && (
                                <button
                                  type="button"
                                  className="chat-donate"
                                  aria-label={`Donate to ${message.authorName}`}
                                  onClick={() => setDonating(card)}
                                >
                                  Donate
                                </button>
                              )}
                            </>
                          );
                        })()}
                        <time dateTime={message.createdAt}>{timeOf(message.createdAt)}</time>
                      </span>
                      <span className="chat-body">{message.body}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>

          {chat.note && (
            <p className="chat-note" role="alert">
              {chat.note}{' '}
              <button type="button" className="link" onClick={chat.dismissNote}>
                Dismiss
              </button>
            </p>
          )}

          {/* Group actions are taken from wherever the player happens to be — an invitation
              from the Town Square, a removal from the roster — so their answer lands in the
              drawer's one note slot rather than inside the Groups tab. */}
          {group?.note && (
            <p className="chat-note" role="alert">
              {group.note}{' '}
              <button type="button" className="link" onClick={group.dismissNote}>
                Dismiss
              </button>
            </p>
          )}

          {/* A send that never settles has to look like one, rather than like nothing at all. */}
          {chat.sending && <p className="chat-pending muted small">Sending…</p>}

          <form className="chat-composer" onSubmit={onSubmit}>
            <label className="sr-only" htmlFor="chat-draft">
              Write a message to {thread ? channelLabel(thread.channel) : 'this channel'}
            </label>
            {/* A textarea, not an input: an input cannot wrap, so anything longer than the
                box scrolled sideways out of sight while you were still typing it. This grows
                with the message instead, up to a cap, and then scrolls. */}
            <textarea
              id="chat-draft"
              name="chatDraft"
              ref={draftRef}
              value={draft}
              rows={1}
              maxLength={MESSAGE_MAX}
              autoComplete="off"
              disabled={!canSend}
              placeholder={
                blocked ? 'You blocked this player.' : archived ? 'This conversation is closed.' : 'Say something…'
              }
              onChange={(event) => setDraft(event.target.value)}
              // Enter sends, because that is what every chat does. Shift+Enter is the escape
              // hatch for a deliberate second line.
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submitDraft();
                }
              }}
            />
            <button type="submit" className="primary" disabled={!canSend || draft.trim().length === 0}>
              Send
            </button>
            {draft.length > MESSAGE_MAX - 80 && (
              <p className="chat-remaining small muted" aria-live="polite">
                {MESSAGE_MAX - draft.length} left
              </p>
            )}
          </form>
        </section>
      )}

      {donating && <DonateDialog card={donating} onClose={() => setDonating(null)} />}

      {/* The region holds the newest message only while the announcer's throttled copy is
          still that message. Anything else — a blocked author's line the announcer has not
          caught up with, a message purged from the log — is content that is no longer on
          screen, and it stays out of the region too. */}
      <p className="sr-only" role="status" aria-live="polite">
        {announcementMatches(announcement, spoken) ? announcement : ''}
      </p>
    </div>
  );
}
