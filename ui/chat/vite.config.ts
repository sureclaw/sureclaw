import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
});
