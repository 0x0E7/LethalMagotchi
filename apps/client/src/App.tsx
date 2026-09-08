import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
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

function PokerRoute() {
  const { table } = useTournament();
  if (!table) return <Navigate to="/pet" replace />;
  return <PokerTable table={table} />;
}

/**
 * Being seated is server state, not a link the player follows: the table route opens
 * itself when `tourney:seated` arrives and closes when the table resolves, so a player
 * can never be looking at the wrong screen while their turn timer runs.
 */
function useSeatRouting(): void {
  const { table } = useTournament();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (table && location.pathname !== '/poker') navigate('/poker', { replace: true });
    if (!table && location.pathname === '/poker') navigate('/pet', { replace: true });
  }, [table, location.pathname, navigate]);
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
      <Route path="*" element={<Navigate to={character ? '/pet' : '/create/species'} replace />} />
    </Routes>
  );
}
