import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Express API; set VITE_API_AUTH=true for Firebase-authenticated cloud mode.
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    // YAMNet + tfjs are large; silence the chunk-size warning, keep the build green.
    chunkSizeWarningLimit: 4000,
  },
});
