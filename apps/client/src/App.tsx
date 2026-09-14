import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import type { CharacterDto } from '@lethalmagotchi/shared';
import { DuelArena } from './duel/DuelArena.js';
import { useDuel } from './duel/DuelProvider.js';
import { RaidArena } from './raid/RaidArena.js';
import { useRaid } from './raid/RaidProvider.js';
import { useSession } from './session/SessionProvider.js';
import { useTournament } from './tournament/TournamentProvider.js';
import { AuthScreen } from './routes/AuthScreen.js';
import { CreateFlow } from './routes/create/CreateFlow.js';
import { PetScreen } from './routes/pet/PetScreen.js';
import { PokerTable } from './routes/poker/PokerTable.js';

function Splash() {
  return (
    <div className="splash" role="status" aria-live="polite">
      <div className="splash-mark">LethalMagotchi</div>
      <p className="muted">Waking up your pet…</p>
    </div>
  );
}

function DuelRoute({ character }: { character: CharacterDto }) {
  const duel = useDuel();
  if (!duel?.match) return <Navigate to="/pet" replace />;
  return <DuelArena match={duel.match} character={character} />;
}

function RaidRoute({ character }: { character: CharacterDto }) {
  const raid = useRaid();
  if (!raid?.match) return <Navigate to="/pet" replace />;
  return <RaidArena match={raid.match} character={character} />;
}

function PokerRoute() {
  const { table } = useTournament();
  if (!table) return <Navigate to="/pet" replace />;
  return <PokerTable table={table} />;
}

/**
 * Being seated or in a duel is server state, not a link the player follows: each route
 * opens itself when the server says the engagement started and closes when it resolves, so
 * a player can never be looking at the wrong screen while a deadline runs against them.
 */
function useSeatRouting(): void {
  const { table } = useTournament();
  const duel = useDuel();
  const raid = useRaid();
  const match = duel?.match ?? null;
  const raidMatch = raid?.match ?? null;
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (table && location.pathname !== '/poker') navigate('/poker', { replace: true });
    if (!table && location.pathname === '/poker') navigate('/pet', { replace: true });
    if (match && location.pathname !== '/duel') navigate('/duel', { replace: true });
    if (!match && location.pathname === '/duel') navigate('/pet', { replace: true });
    if (raidMatch && location.pathname !== '/raid') navigate('/raid', { replace: true });
    if (!raidMatch && location.pathname === '/raid') navigate('/pet', { replace: true });
  }, [table, match, raidMatch, location.pathname, navigate]);
}

export function App() {
  const { status, character } = useSession();
  const location = useLocation();
  useSeatRouting();

  if (status === 'loading') return <Splash />;

  if (status === 'anonymous') {
    return (
      <Routes>
        <Route path="/" element={<AuthScreen />} />
        <Route path="*" element={<Navigate to="/" replace state={{ from: location.pathname }} />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<Navigate to={character ? '/pet' : '/create/species'} replace />} />
      <Route path="/create" element={<Navigate to="/create/species" replace />} />
      <Route
        path="/create/:step"
        element={
          character ? (
            <Navigate to="/pet" replace state={{ toast: 'You already have a character. Edit them in Settings.' }} />
          ) : (
            <CreateFlow />
          )
        }
      />
      <Route
        path="/pet"
        element={character ? <PetScreen character={character} /> : <Navigate to="/create/species" replace />}
      />
      <Route
        path="/poker"
        element={character ? <PokerRoute /> : <Navigate to="/create/species" replace />}
      />
      <Route
        path="/duel"
        element={character ? <DuelRoute character={character} /> : <Navigate to="/create/species" replace />}
      />
      <Route
        path="/raid"
        element={character ? <RaidRoute character={character} /> : <Navigate to="/create/species" replace />}
      />
      <Route path="*" element={<Navigate to={character ? '/pet' : '/create/species'} replace />} />
    </Routes>
  );
}
