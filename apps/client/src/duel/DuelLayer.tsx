import type { CharacterDto } from '@lethalmagotchi/shared';
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
          wealthBand: incoming.from.wealthBand,
          isBeggar: incoming.from.isBeggar,
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

  /**
   * The server's snapshot once the invite exists — it is what the target was shown and what
   * the challenger is held to. Null while composing, and deliberately not estimated:
   * `min(both wallets)` would need the opponent's exact balance, which the public card no
   * longer carries and a would-be raider must never be able to read off it. The card says
   * "at most your own wallet" instead, which is true and gives nothing away.
   */
  const stake = outgoing.stakeCoins;
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
        wealthBand: outgoing.target.wealthBand,
        isBeggar: outgoing.target.isBeggar,
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
