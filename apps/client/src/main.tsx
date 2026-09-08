import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { SessionProvider } from './session/SessionProvider.js';
import { TournamentProvider } from './tournament/TournamentProvider.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <TournamentProvider>
          <App />
        </TournamentProvider>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
