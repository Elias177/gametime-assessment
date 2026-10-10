import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { prerenderResume } from './prerender-plugin';

const API_ORIGIN = 'http://localhost:3001';

export default defineConfig({
  plugins: [react(), prerenderResume({ apiOrigin: API_ORIGIN })],
  server: {
    port: 5173,
    proxy: {
      '/api': API_ORIGIN,
    },
  },
});
