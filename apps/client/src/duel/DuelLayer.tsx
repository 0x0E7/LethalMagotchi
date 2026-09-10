import { duelStakeCoins, type CharacterDto } from '@lethalmagotchi/shared';
import { useDuel } from './DuelProvider.js';
import { StakesCard } from './StakesCard.js';

const RESOLUTION_COPY: Record<string, string> = {
  declined: 'turned the challenge down.',
  expired: 'did not answer in time.',
  cancelled: 'The challenge was withdrawn.',
};

/**
 * Where a duel interrupts the rest of the game: the Stakes Card, for the player about to
 * issue one and the player who has just been handed one. The match itself is a route, not
 * an overlay, because it takes over the screen for its whole length.
 */
export function DuelLayer({ character }: { character: CharacterDto }) {
  const duel = useDuel();
  if (!duel) return null;

  const { incoming, outgoing } = duel;

  if (incoming) {
    return (
      <StakesCard
        heading={`${incoming.from.nickname} has challenged ${character.nickname} to a duel.`}
        you={{ nickname: character.nickname, lethalCoins: character.lethalCoins }}
        them={{
          nickname: incoming.from.nickname,
          lethalCoins: incoming.from.lethalCoins,
          duelWins: incoming.from.duelWins,
          duelLosses: incoming.from.duelLosses,
        }}
        stakeCoins={incoming.stakeCoins}
        expiresAt={incoming.expiresAt}
        confirmLabel="Accept the duel"
        onConfirm={() => duel.respond(incoming.inviteId, true)}
        declineLabel="Decline"
        onDecline={() => duel.respond(incoming.inviteId, false)}
        note={duel.note}
      />
    );
  }

  if (!outgoing) return null;

  // Once the invite exists the server's snapshot is what will actually be played for, and
  // it is what the target was shown; before that this is an estimate of the same number.
  const stake = outgoing.stakeCoins ?? duelStakeCoins(character.lethalCoins, outgoing.target.lethalCoins);
  const resolved = outgoing.phase === 'resolved' && outgoing.state;
  const status = resolved
    ? outgoing.state === 'cancelled'
      ? RESOLUTION_COPY.cancelled!
      : `${outgoing.target.nickname} ${RESOLUTION_COPY[outgoing.state as string] ?? 'is no longer available.'}`
    : outgoing.phase === 'pending'
      ? `Waiting for ${outgoing.target.nickname} to answer…`
      : null;

  return (
    <StakesCard
      heading={`Challenge ${outgoing.target.nickname} to a duel?`}
      you={{ nickname: character.nickname, lethalCoins: character.lethalCoins }}
      them={{
        nickname: outgoing.target.nickname,
        lethalCoins: outgoing.target.lethalCoins,
        duelWins: outgoing.target.duelWins,
        duelLosses: outgoing.target.duelLosses,
        chickenBadgeUntil: outgoing.target.chickenBadgeUntil,
      }}
      stakeCoins={stake}
      confirmLabel={outgoing.phase === 'composing' ? 'Send the challenge' : null}
      confirmBusy={outgoing.phase === 'sending'}
      onConfirm={duel.sendInvite}
      declineLabel={outgoing.phase === 'pending' ? 'Withdraw' : resolved ? 'Close' : 'Not now'}
      onDecline={outgoing.phase === 'pending' ? duel.cancelInvite : duel.closeStakes}
      note={duel.note}
      status={status}
    />
  );
}
