import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useSession } from './session/SessionProvider.js';
import { AuthScreen } from './routes/AuthScreen.js';
import { CreateFlow } from './routes/create/CreateFlow.js';
import { PetScreen } from './routes/PetScreen.js';

function Splash() {
  return (
    <div className="splash" role="status" aria-live="polite">
      <div className="splash-mark">LethalMagotchi</div>
      <p className="muted">Waking up your pet…</p>
    </div>
  );
}

export function App() {
  const { status, character } = useSession();
  const location = useLocation();

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
      <Route path="*" element={<Navigate to={character ? '/pet' : '/create/species'} replace />} />
    </Routes>
  );
}
