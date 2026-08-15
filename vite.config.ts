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
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/react/') || id.includes('/react-dom/')) return 'react';
          if (id.includes('/recharts/')) return 'charts';
          if (id.includes('/lucide-react/')) return 'icons';
          return undefined;
        },
      },
    },
  },
});
