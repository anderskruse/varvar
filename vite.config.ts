import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const hub = `http://127.0.0.1:${process.env.HUB_PORT ?? 4319}`;
// Requests from the Vite dev server reach the hub without the browser's Origin header.
const proxy = {
  target: hub,
  changeOrigin: true,
  configure: (p: { on: (e: string, fn: (req: { removeHeader: (h: string) => void }) => void) => void }) =>
    p.on('proxyReq', (req) => req.removeHeader('origin')),
};

export default defineConfig({
  root: 'web',
  // Relative asset URLs: the same build works at / (hub) and under /<repo>/ (GitHub Pages).
  base: process.env.HUB_BASE ?? './',
  plugins: [react()],
  resolve: { alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) } },
  build: { outDir: '../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: { proxy: { '/api': proxy, '/varvar-config.json': proxy } },
});
