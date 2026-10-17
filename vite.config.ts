import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client' },
  server: {
    port: Number(process.env.VITE_PORT ?? 5173), strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${process.env.PORT ?? 3001}`, '/artifacts': `http://127.0.0.1:${process.env.PORT ?? 3001}` },
  },
});
