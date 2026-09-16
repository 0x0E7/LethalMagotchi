import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: false,
      },
      /*
       * The socket needs proxying too, and needs `ws: true` to be upgraded rather than
       * answered as a normal request.
       *
       * Without this, everything real-time — chat, duels, raids, tournaments, group
       * sync — is dead in `npm run dev`: the client asks its own origin for `/ws`, the dev
       * server has nothing to hand back, and the socket never opens. It did not show up in
       * the end-to-end suite because that serves the built client from the API server
       * itself, so there both live on one origin and no proxy is involved.
       */
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
        changeOrigin: false,
      },
    },
  },
});
