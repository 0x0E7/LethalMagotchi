import type { TableStanding } from '@lethalmagotchi/shared';
import { useTournament, type Outcome } from '../../tournament/TournamentProvider.js';

function ordinal(position: number): string {
  const suffix = position % 10 === 1 && position !== 11 ? 'st' : position % 10 === 2 && position !== 12 ? 'nd' : position % 10 === 3 && position !== 13 ? 'rd' : 'th';
  return `${position}${suffix}`;
}

function Standings({ standings, youId }: { standings: TableStanding[]; youId: string | null }) {
  return (
    <ol className="standings">
      {standings.map((standing, index) => (
        <li key={standing.characterId} className={standing.characterId === youId ? 'you' : ''}>
          <span className="standing-rank">{ordinal(index + 1)}</span>
          <span className="standing-name">{standing.nickname}</span>
          <span className="standing-stack">
            <span aria-hidden="true">🪙</span> {standing.stack}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * A single-column vertical ladder, identical on mobile — deliberately not a wide
 * esports bracket tree.
 */
function Ladder({ round, totalRounds, remaining }: { round: number; totalRounds: number; remaining: number }) {
  return (
    <ol className="ladder" aria-label={`Round ${round} of ${totalRounds}`}>
      {Array.from({ length: totalRounds }).map((_, index) => {
        const step = index + 1;
        const state = step < round ? 'done' : step === round ? 'current' : 'ahead';
        return (
          <li key={step} className={`ladder-step ${state}`}>
            <span className="ladder-dot" aria-hidden="true" />
            <span className="ladder-label">
              Round {step}
              {step === round && remaining > 0 ? ` · ${remaining} players left` : ''}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function OutcomeCard({ outcome, youId }: { outcome: Outcome; youId: string | null }) {
  const { ladder, dismissOutcome } = useTournament();

  const body = (() => {
    switch (outcome.kind) {
      case 'bye':
        return {
          title: 'Straight through',
          lead: `Nobody left to seat you against in round ${outcome.round}, so you advance for free — no coins risked.`,
          standings: null,
        };
      case 'qualified':
        return {
          title: 'Qualified',
          lead: `Top stack at your table. You carry ${outcome.coinsDelta} coins into the next round.`,
          standings: outcome.standings,
        };
      case 'eliminated':
        return {
          title: 'Knocked out',
          lead:
            outcome.coinsReturned > 0
              ? `Your run ends here. ${outcome.coinsReturned} coin${outcome.coinsReturned === 1 ? '' : 's'} came back to your wallet.`
              : 'Your run ends here, and your stake with it.',
          standings: outcome.standings,
        };
      case 'winner':
        return {
          title: outcome.you ? 'You won the whole thing' : `${outcome.nickname} takes it`,
          lead: outcome.you
            ? `${outcome.stackCoins} coins from the table plus a ${outcome.prizeCoins}-coin house prize, and a champion's crown.`
            : `${outcome.nickname} finished as champion. Your coins are already back in your wallet.`,
          standings: null,
        };
      case 'cancelled':
        return {
          title: 'Tournament called off',
          lead:
            outcome.reason === 'NOT_ENOUGH_ENTRANTS'
              ? 'Not enough players entered this time. Every coin has been refunded.'
              : 'The tournament stopped early. Every coin has been refunded.',
          standings: null,
        };
    }
  })();

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={body.title}>
      <div className="card modal outcome-card">
        <h2>{body.title}</h2>
        <p>{body.lead}</p>

        {body.standings && <Standings standings={body.standings} youId={youId} />}

        {ladder && outcome.kind === 'qualified' && (
          <Ladder round={ladder.round} totalRounds={ladder.totalRounds} remaining={ladder.remaining} />
        )}

        <button type="button" className="primary" onClick={dismissOutcome}>
          {outcome.kind === 'qualified' ? 'Ready for the next table' : 'Back to my pet'}
        </button>
      </div>
    </div>
  );
}
