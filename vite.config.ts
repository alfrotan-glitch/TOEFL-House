import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Vite 8 uses Rolldown; manualChunks must be a function in the current bundler.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
    host: '0.0.0.0',
    // Dev-server convenience: accept requests on any host/origin (including
    // sandbox preview hosts). Production serves the static build, so this has
    // no security impact on deployed artifacts.
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Rolldown's `advancedChunks` groups, not `manualChunks`: with the
        // function form, React's CJS entry points (react/index.js,
        // react-dom/cjs/react-dom.production.js) were pulled into whichever
        // chunk first required them — recharts. That put a 412 KB charting
        // library in the entry's preload graph, so every user downloaded it
        // before the first paint even though only the lazy Dashboard renders
        // a chart. Explicit priority-ordered groups keep React in one chunk.
        advancedChunks: {
          groups: [
            { name: 'react', test: /[\\/]node_modules[\\/](react|react-dom)[\\/]/, priority: 30 },
            { name: 'icons', test: /[\\/]node_modules[\\/]lucide-react[\\/]/, priority: 20 },
            { name: 'charts', test: /[\\/]node_modules[\\/](recharts|d3-[^/]*|victory-[^/]*|decimal\.js-light)[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
});
