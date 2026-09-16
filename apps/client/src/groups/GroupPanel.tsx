import { useState, type FormEvent } from 'react';
import { GROUP_MAX_MEMBERS, GROUP_NAME_MAX } from '@lethalmagotchi/shared';
import { useChat } from '../chat/ChatProvider.js';
import { useDuel } from '../duel/DuelProvider.js';
import { useSession } from '../session/SessionProvider.js';
import { PeoplePicker } from '../chat/PeoplePicker.js';
import { useGroup } from './GroupProvider.js';

function expiryLabel(iso: string): string {
  const days = Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / (24 * 60 * 60_000)));
  return days === 1 ? 'expires today' : `expires in ${days} days`;
}

/**
 * The one new screen groups add: a name, a public roster, the way out, and — for the leader —
 * the way to remove someone. Everything else groups needed already existed.
 */
export function GroupPanel({ onOpenChannel }: { onOpenChannel: (channelId: string) => void }) {
  const group = useGroup();
  const chat = useChat();
  const duel = useDuel();
  const { account, character } = useSession();
  const [name, setName] = useState('');
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  if (!group) return null;

  const mine = group.group;

  /**
   * Joining and leaving add and remove a channel, which chat has no other way to hear about,
   * and move the group badge on everyone the roster touches, which the Town Square card cache
   * has no other way to hear about either.
   */
  const settle = async (alsoStale: (string | null)[] = []) => {
    const roster = (mine?.members ?? []).map((member) => member.characterId);
    duel?.refetchCards(
      [...roster, ...alsoStale, character?.id ?? null].filter((id): id is string => id !== null),
    );
    await chat?.refreshChannels();
  };

  const onCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim().length === 0) return;
    if (await group.create(name)) {
      setName('');
      await settle();
    }
  };

  return (
    <div className="group-panel">
      {/* Notes deliberately render in the drawer's own footer rather than here: an invitation
          is sent from the Town Square, so its answer has to appear where the player is. */}
      {mine === null ? (
        <>
          {group.invites.length > 0 && (
            <section className="group-section" aria-labelledby="group-invites-heading">
              <h3 id="group-invites-heading" className="group-heading">
                Invitations
              </h3>
              <ul className="group-invites">
                {group.invites.map((invite) => (
                  <li key={invite.id} className="group-invite">
                    <span className="group-invite-name">{invite.groupName}</span>
                    <span className="muted small">
                      from {invite.fromNickname ?? 'a member'} · {expiryLabel(invite.expiresAt)}
                    </span>
                    <span className="group-invite-actions">
                      <button
                        type="button"
                        className="primary small"
                        disabled={group.busy}
                        onClick={() => void group.respond(invite.id, true).then(() => settle())}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        className="ghost small"
                        disabled={group.busy}
                        onClick={() => void group.respond(invite.id, false)}
                      >
                        Decline
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="group-section" aria-labelledby="group-create-heading">
            <h3 id="group-create-heading" className="group-heading">
              Start a group
            </h3>
            <p className="muted small">
              A name, a shared channel, and up to {GROUP_MAX_MEMBERS} people. It changes nothing about
              how you play.
            </p>
            <form className="group-create" onSubmit={(event) => void onCreate(event)}>
              <label className="sr-only" htmlFor="group-name">
                Group name
              </label>
              <input
                id="group-name"
                name="groupName"
                value={name}
                maxLength={GROUP_NAME_MAX}
                autoComplete="off"
                placeholder="Group name"
                onChange={(event) => setName(event.target.value)}
              />
              <button type="submit" className="primary" disabled={group.busy || name.trim().length === 0}>
                Create
              </button>
            </form>
          </section>
        </>
      ) : (
        <section className="group-section" aria-labelledby="group-name-heading">
          <div className="group-head">
            <h3 id="group-name-heading" className="group-heading">
              {mine.name}
            </h3>
            <button type="button" className="ghost small" onClick={() => onOpenChannel(mine.channelId)}>
              Open chat
            </button>
          </div>
          <p className="muted small">
            {mine.memberCount} of {GROUP_MAX_MEMBERS} members
          </p>

          <ul className="group-roster" aria-label={`${mine.name} members`}>
            {mine.members.map((member) => (
              <li key={member.accountId} className="group-member">
                <span className="group-member-name">{member.nickname ?? '[no character]'}</span>
                {member.role === 'leader' && <span className="group-leader-badge">leader</span>}
                {mine.role === 'leader' && member.accountId !== account?.id && (
                  <button
                    type="button"
                    className="group-remove"
                    disabled={group.busy}
                    aria-label={`Remove ${member.nickname ?? 'this member'}`}
                    onClick={() => void group.remove(member.accountId).then(() => settle([member.characterId]))}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>

          {/* Any member may invite, and this is the only way to reach someone who is not
              currently talking in the Town Square. Hidden once the group is full, since the
              server would refuse every pick anyway. */}
          {mine.memberCount < GROUP_MAX_MEMBERS && (
            <section className="group-section" aria-labelledby="group-add-heading">
              <h4 id="group-add-heading" className="group-heading">
                Add members
              </h4>
              <PeoplePicker
                actions={[
                  {
                    label: 'Add',
                    onPick: (card) => {
                      if (card.accountId) void group.invite(card.accountId);
                    },
                    unavailable: (card) =>
                      card.accountId !== null &&
                      mine.members.some((member) => member.accountId === card.accountId)
                        ? 'In group'
                        : null,
                  },
                ]}
              />
            </section>
          )}

          {confirmingLeave ? (
            <p className="group-leave-confirm">
              <span className="small">
                {mine.memberCount === 1
                  ? 'You are the last member — the group closes with you.'
                  : mine.role === 'leader'
                    ? 'The longest-standing member takes over.'
                    : 'Leave this group?'}
              </span>
              <button
                type="button"
                className="primary small"
                disabled={group.busy}
                onClick={() => {
                  setConfirmingLeave(false);
                  void group.leave().then(() => settle());
                }}
              >
                Leave group
              </button>
              <button type="button" className="ghost small" onClick={() => setConfirmingLeave(false)}>
                Stay
              </button>
            </p>
          ) : (
            <button type="button" className="ghost small" onClick={() => setConfirmingLeave(true)}>
              Leave group
            </button>
          )}
        </section>
      )}
    </div>
  );
}
