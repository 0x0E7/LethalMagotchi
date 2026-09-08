import { useEffect, useRef, useState } from 'react';
import { HANDS_PER_TABLE, type SeatView } from '@lethalmagotchi/shared';
import { speciesArt } from '../../species-art.js';
import { useTournament, type TableView } from '../../tournament/TournamentProvider.js';
import { useAnnouncer, useNow } from '../pet/hooks.js';
import { BettingBar } from './BettingBar.js';
import { CardBack, CardSlot, PlayingCard } from './PlayingCard.js';

const COUNTDOWN_VISIBLE_MS = 5_000;

function SeatCard({
  seat,
  isYou,
  isTurn,
  isButton,
  blindLabel,
  turnProgress,
  revealed,
}: {
  seat: SeatView;
  isYou: boolean;
  isTurn: boolean;
  isButton: boolean;
  blindLabel: string | null;
  turnProgress: number;
  revealed: { cards: string[]; handName: string } | null;
}) {
  const className = [
    'seat',
    isYou ? 'you' : '',
    isTurn ? 'acting' : '',
    seat.folded ? 'folded' : '',
    seat.connected ? '' : 'away',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      style={{ ['--turn-progress' as string]: `${Math.round(turnProgress * 100)}%` }}
    >
      <div className="seat-portrait" role="img" aria-label={`${seat.nickname}, a ${seat.speciesId}`}>
        <span aria-hidden="true">{speciesArt(seat.speciesId)}</span>
        {isButton && (
          <span className="seat-badge button" title="Dealer">
            D
          </span>
        )}
        {blindLabel && <span className="seat-badge blind">{blindLabel}</span>}
      </div>

      <div className="seat-info">
        <span className="seat-name">{seat.nickname}</span>
        <span className="seat-stack">
          <span aria-hidden="true">🪙</span> {seat.stack}
        </span>
        {!seat.connected && <span className="seat-away">Away</span>}
        {seat.folded && <span className="seat-away">Folded</span>}
        {seat.allIn && !seat.folded && <span className="seat-allin">All in</span>}
      </div>

      {seat.committed > 0 && (
        <span className="seat-bet" aria-label={`${seat.nickname} has bet ${seat.committed} coins`}>
          {seat.committed}
        </span>
      )}

      {!isYou && (
        <div className="seat-cards">
          {revealed ? (
            revealed.cards.map((card) => <PlayingCard key={card} card={card as never} size="sm" />)
          ) : seat.folded ? (
            <>
              <CardSlot size="sm" />
              <CardSlot size="sm" />
            </>
          ) : (
            <>
              <CardBack size="sm" label={`${seat.nickname}'s card`} />
              <CardBack size="sm" label={`${seat.nickname}'s card`} />
            </>
          )}
        </div>
      )}

      {revealed && <span className="seat-hand">{revealed.handName}</span>}
    </div>
  );
}

export function PokerTable({ table }: { table: TableView }) {
  const { act } = useTournament();
  const now = useNow(200);
  const { message, announce } = useAnnouncer();
  const [flash, setFlash] = useState<string | null>(null);

  const hand = table.hand;
  const you = table.seats[table.seatIndex];
  const yourTurn = table.turn?.seatIndex === table.seatIndex;
  const pending = table.turn !== null && table.pendingSeq === table.turn.seq;

  const remainingMs = table.turn ? Math.max(0, table.turn.deadlineAt - now) : 0;
  const turnTotalMs = 20_000;

  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (!table.showdown || announced.current === table.showdown.summary) return;
    announced.current = table.showdown.summary;
    setFlash(table.showdown.summary);
    announce(table.showdown.summary);
  }, [table.showdown, announce]);

  const lastTurnKey = useRef<string | null>(null);
  useEffect(() => {
    if (!yourTurn || !table.turn) return;
    const key = `${table.turn.handId}:${table.turn.seq}`;
    if (lastTurnKey.current === key) return;
    lastTurnKey.current = key;
    announce(`Your turn. ${table.bestHand ? `You have ${table.bestHand}.` : ''}`);
  }, [yourTurn, table.turn, table.bestHand, announce]);

  useEffect(() => {
    if (!yourTurn || !table.turn) return;
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      const legal = table.turn!.legal.actions;
      if (event.key.toLowerCase() === 'f' && legal.includes('fold')) act('fold');
      if (event.key.toLowerCase() === 'c') {
        if (legal.includes('check')) act('check');
        else if (legal.includes('call')) act('call');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [yourTurn, table.turn, act]);

  const revealsBySeat = new Map(
    (table.showdown?.reveals ?? []).map((reveal) => [reveal.seatIndex, reveal]),
  );

  const blindLabel = (seatIndex: number): string | null => {
    if (!hand) return null;
    if (hand.blinds.smallBlindSeat === seatIndex) return 'SB';
    if (hand.blinds.bigBlindSeat === seatIndex) return 'BB';
    return null;
  };

  const others = table.seats.filter((seat) => seat.seatIndex !== table.seatIndex);

  return (
    <main className="poker-layout">
      <header className="poker-topbar">
        <div>
          <h1>Round {table.round} of {table.totalRounds}</h1>
          <p className="muted small">
            {hand
              ? hand.suddenDeath
                ? 'Sudden death hand'
                : `Hand ${hand.handNumber} of ${table.handsPerTable || HANDS_PER_TABLE}`
              : 'Shuffling…'}{' '}
            · Top stack qualifies
          </p>
        </div>
        <div className="poker-pot" aria-label={`Pot, ${hand?.potCoins ?? 0} coins`}>
          <span className="poker-pot-label">Pot</span>
          <span className="poker-pot-value">
            <span aria-hidden="true">🪙</span> {hand?.potCoins ?? 0}
          </span>
        </div>
      </header>

      <div className="poker-live sr-only" aria-live="polite" aria-atomic="true">
        {message}
      </div>

      <section className="poker-felt" aria-label="Table">
        <div className="seat-arc">
          {others.map((seat) => (
            <SeatCard
              key={seat.seatIndex}
              seat={seat}
              isYou={false}
              isTurn={table.turn?.seatIndex === seat.seatIndex}
              isButton={hand?.buttonSeat === seat.seatIndex}
              blindLabel={blindLabel(seat.seatIndex)}
              turnProgress={table.turn?.seatIndex === seat.seatIndex ? remainingMs / turnTotalMs : 0}
              revealed={revealsBySeat.get(seat.seatIndex) ?? null}
            />
          ))}
        </div>

        <div className="board" role="group" aria-label="Community cards">
          {Array.from({ length: 5 }).map((_, index) => {
            const card = hand?.board[index];
            return card ? (
              <PlayingCard key={card} card={card} size="md" />
            ) : (
              <CardSlot key={`slot-${index}`} size="md" />
            );
          })}
        </div>

        {flash && (
          <p className="showdown-caption" role="status">
            {flash}
          </p>
        )}
      </section>

      <section className="your-seat" aria-label="Your hand">
        {you && (
          <SeatCard
            seat={you}
            isYou
            isTurn={yourTurn}
            isButton={hand?.buttonSeat === you.seatIndex}
            blindLabel={blindLabel(you.seatIndex)}
            turnProgress={yourTurn ? remainingMs / turnTotalMs : 0}
            revealed={null}
          />
        )}

        <div className="your-cards">
          {table.holeCards.length > 0 ? (
            table.holeCards.map((card) => <PlayingCard key={card} card={card} size="lg" />)
          ) : (
            <>
              <CardSlot size="lg" />
              <CardSlot size="lg" />
            </>
          )}
        </div>

        {/* The single biggest onboarding win at the table: never make the player know
            hand rankings to play confidently. */}
        <p className="best-hand" aria-live="polite">
          {table.bestHand ? `You have ${table.bestHand}` : 'Waiting for cards…'}
        </p>
      </section>

      <footer className="poker-actions">
        {table.note && <p className="dock-note">{table.note}</p>}

        {yourTurn && table.turn ? (
          <>
            <div className="turn-timer" aria-hidden="true">
              <i style={{ width: `${Math.max(0, Math.min(100, (remainingMs / turnTotalMs) * 100))}%` }} />
            </div>
            {remainingMs <= COUNTDOWN_VISIBLE_MS && (
              <p className="turn-countdown">{Math.ceil(remainingMs / 1000)}s</p>
            )}
            <BettingBar
              legal={table.turn.legal}
              stack={you?.stack ?? 0}
              potCoins={hand?.potCoins ?? 0}
              pending={pending}
              onAct={act}
            />
          </>
        ) : (
          <p className="poker-waiting">
            {table.showdown
              ? 'Showdown'
              : table.turn
                ? `Waiting on ${table.seats[table.turn.seatIndex]?.nickname ?? 'the table'}…`
                : 'Dealing…'}
          </p>
        )}
      </footer>
    </main>
  );
}
