import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  ACTION_SPECS,
  CLIP_SPECS,
  SHOP_ITEMS,
  SHOP_ITEMS_BY_ID,
  STAT_DISPLAY_NAMES,
  toDisplayStats,
  type ActionResponse,
  type CharacterDto,
  type CharacterStats,
  type StatId,
} from '@lethalmagotchi/shared';
import { ApiRequestError, NetworkError } from '../../api/client.js';
import { ChatPanel } from '../../chat/ChatPanel.js';
import { DuelFinder } from '../../duel/DuelFinder.js';
import { DuelLayer } from '../../duel/DuelLayer.js';
import { BeggarStrip } from '../../raid/BeggarStrip.js';
import { RaidFinder } from '../../raid/RaidFinder.js';
import { useRaid } from '../../raid/RaidProvider.js';
import { RaidLayer } from '../../raid/RaidLayer.js';
import { useReference } from '../../hooks/useReference.js';
import { useSession } from '../../session/SessionProvider.js';
import { useTournament } from '../../tournament/TournamentProvider.js';
import { OutcomeCard } from '../poker/OutcomeCard.js';
import { ActionDock } from './ActionDock.js';
import { Hud } from './Hud.js';
import { PetStage } from './PetStage.js';
import { RebirthCard } from './RebirthCard.js';
import { TournamentStrip } from './TournamentStrip.js';
import { useAnnouncer, useLiveStats, useNow } from './hooks.js';
import { ANIMATION_MODES, ANIMATION_MODE_LABELS, useAnimationMode, usePrefersReducedMotion } from './settings.js';
import { useActionMachine } from './useActionMachine.js';

const TICK_MS = 1000;
const ATTENTION_THRESHOLDS = [60, 25];

function crossedDown(before: number, after: number): number | null {
  for (const threshold of ATTENTION_THRESHOLDS) {
    if (before >= threshold && after < threshold) return threshold;
  }
  return null;
}

function describeResult(result: ActionResponse['result'], stats: CharacterStats): string {
  const what =
    result.itemId === null
      ? ACTION_SPECS[result.action].displayName
      : SHOP_ITEMS_BY_ID[result.itemId].displayName;

  const moved = (Object.keys(result.deltas) as StatId[])
    .filter((stat) => Math.abs(result.deltas[stat] ?? 0) >= 0.5)
    .map((stat) => `${STAT_DISPLAY_NAMES[stat]} ${Math.round(stats[stat])} percent`)
    .join('. ');

  return moved ? `${what}. ${moved}.` : `${what}.`;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return error.message;
  return 'Something went wrong.';
}

export function PetScreen({ character }: { character: CharacterDto }) {
  const { account, logout, setCharacter } = useSession();
  const { outcome, rebirth, entryNotice, dismissEntryNotice } = useTournament();
  const raid = useRaid();
  const { data: reference } = useReference();
  const location = useLocation();
  const [animationMode, setAnimationMode] = useAnimationMode();
  const reducedMotion = usePrefersReducedMotion();
  const { message, announce } = useAnnouncer();
  const [note, setNote] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const [raiding, setRaiding] = useState(false);

  const now = useNow(TICK_MS);
  const stats = useLiveStats(character, now);

  const toast = (location.state as { toast?: string } | null)?.toast;

  const onCommit = useCallback(
    (response: ActionResponse) => {
      setCharacter(response.character);
      setNote(null);
      announce(describeResult(response.result, response.character.stats));
    },
    [announce, setCharacter],
  );

  const onError = useCallback(
    (error: unknown) => {
      const text = errorMessage(error);
      setNote(text);
      announce(text);
    },
    [announce],
  );

  const machine = useActionMachine({
    characterId: character.id,
    animationMode,
    reducedMotion,
    onCommit,
    onError,
  });

  const previous = useRef(toDisplayStats(stats));
  useEffect(() => {
    const display = toDisplayStats(stats);
    for (const [key, value] of Object.entries(display) as [keyof typeof display, number][]) {
      const threshold = crossedDown(previous.current[key], value);
      if (threshold !== null) {
        announce(`${key}, ${Math.round(value)} percent${threshold === 25 ? ', critical' : ', needs attention'}.`);
      }
    }
    previous.current = display;
  }, [stats, announce]);

  const species = reference?.species.find((entry) => entry.id === character.speciesId);
  const occupation = reference?.occupations.find((entry) => entry.id === character.occupationId);
  const personality = reference?.personalities.find((entry) => entry.id === character.personalityId);
  const country = reference?.countries.find((entry) => entry.code === character.originCountry);

  const subtitle = [
    species?.displayName ?? character.speciesId,
    occupation?.displayName,
    [character.originCity, country?.displayName].filter(Boolean).join(', ') || null,
    personality?.displayName,
  ]
    .filter(Boolean)
    .join(' · ');

  const busyReason = machine.playing
    ? `${character.nickname} is ${CLIP_SPECS[machine.playing.clipId].busyVerb}…${
        machine.queued ? ` ${ACTION_SPECS[machine.queued.action].displayName} is queued.` : ''
      }`
    : null;

  return (
    <div className="pet-layout">
      <header className="pet-topbar">
        <div className="pet-identity">
          <h1>{character.nickname}</h1>
          <p className="pet-subtitle">{subtitle}</p>
          {character.bio && <p className="pet-bio">{character.bio}</p>}
        </div>

        <div className="pet-topbar-right">
          <TournamentStrip character={character} />

          {/* The front door to duelling. It lived only beside a Town Square message before,
              so a player who was not reading chat had no way to find it at all. */}
          <button
            type="button"
            className="ghost small duel-open"
            // Named apart from the per-player "Duel <nickname>" buttons inside the finder,
            // so neither can ever be mistaken for the other.
            aria-label="Find a duel"
            onClick={() => setFinding(true)}
          >
            <span aria-hidden="true">⚔️</span> Duel
          </button>

          {/* Same gap, same fix: a raid could only be aimed at someone who had just posted
              in the Town Square, which made the mode invisible to anyone not reading chat. */}
          <button
            type="button"
            className="ghost small raid-open"
            aria-label="Find a raid"
            // With a party already assembling the card is the surface, not the finder —
            // bring it back rather than opening a second way to start a raid.
            onClick={() => (raid?.party ? raid.showParty() : setRaiding(true))}
          >
            <span aria-hidden="true">🎭</span> Raid
          </button>

          <span
            className={character.lethalCoins <= 2 ? 'coin-chip low' : 'coin-chip'}
            aria-label={`${character.lethalCoins} LethalCoins`}
          >
            <span aria-hidden="true">🪙</span> {character.lethalCoins}
          </span>

          <BeggarStrip character={character} />

          <label className="field-inline">
            <span className="sr-only">Action animations</span>
            <select
              name="animationMode"
              value={animationMode}
              onChange={(event) => setAnimationMode(event.target.value as typeof animationMode)}
            >
              {ANIMATION_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  Animations: {ANIMATION_MODE_LABELS[mode]}
                </option>
              ))}
            </select>
          </label>

          <span className="muted small">{account?.username}</span>
          <button type="button" className="ghost small" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </header>

      {toast && (
        <div className="banner" role="status">
          {toast}
        </div>
      )}

      {entryNotice && (
        <div className="banner" role="status">
          {character.nickname} is in.{' '}
          {entryNotice.hpConverted > 0
            ? `${Math.round(entryNotice.hpConverted)}% HP was converted to cover the entry.`
            : 'Three coins are on the table.'}{' '}
          <button type="button" className="link" onClick={dismissEntryNotice}>
            Dismiss
          </button>
        </div>
      )}

      <main className="pet-main">
        <PetStage
          character={character}
          playing={machine.playing}
          skipOffered={machine.skipOffered}
          onSkip={machine.skip}
        />
      </main>

      <Hud stats={stats} announcement={message} />

      <ActionDock
        nickname={character.nickname}
        coins={character.lethalCoins}
        shopItems={reference?.shopItems ?? SHOP_ITEMS}
        actionCooldowns={character.actionCooldowns}
        now={now}
        busy={machine.playing !== null}
        busyReason={busyReason}
        note={note}
        onFire={machine.fire}
        onNote={setNote}
      />

      <ChatPanel />
      {/* Closed the moment a Stakes Card opens, so the two never stack. */}
      {finding && <DuelFinder onClose={() => setFinding(false)} />}
      {raiding && !raid?.party && <RaidFinder onClose={() => setRaiding(false)} />}
      <DuelLayer character={character} />
      <RaidLayer character={character} />

      {rebirth && <RebirthCard character={character} />}
      {!rebirth && outcome && <OutcomeCard outcome={outcome} youId={character.id} />}
    </div>
  );
}
