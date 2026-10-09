import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies the API to the local control plane so cookies stay same-origin.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: { output: { manualChunks: { three: ['three'], r3f: ['@react-three/fiber'] } } },
  },
});
