import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const rawPort = process.env.VITE_AX_PORT;
const axPort = rawPort && /^\d+$/.test(rawPort) ? rawPort : '8080';

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: '../../dist/chat-ui',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/v1': {
        target: `http://127.0.0.1:${axPort}`,
        changeOrigin: true,
      },
    },
  },
});
