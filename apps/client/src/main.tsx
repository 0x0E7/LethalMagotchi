import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { ChatProvider } from './chat/ChatProvider.js';
import { DuelProvider } from './duel/DuelProvider.js';
import { GroupProvider } from './groups/GroupProvider.js';
import { RaidProvider } from './raid/RaidProvider.js';
import { SessionProvider } from './session/SessionProvider.js';
import { TournamentProvider } from './tournament/TournamentProvider.js';
import { SocketProvider } from './ws/SocketProvider.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <SocketProvider>
          <TournamentProvider>
            <ChatProvider>
              <GroupProvider>
                <DuelProvider>
                  <RaidProvider>
                    <App />
                  </RaidProvider>
                </DuelProvider>
              </GroupProvider>
            </ChatProvider>
          </TournamentProvider>
        </SocketProvider>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
