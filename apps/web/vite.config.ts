import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const webPort = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.WEB_PORT;

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(webPort ?? 5173),
  },
});
