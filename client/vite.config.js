import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/colyseus': {
        target: 'http://localhost:2567',
        changeOrigin: true,
        secure: false,
        ws: true,
        rewrite: (path) => path.replace(/^\/colyseus/, ''),
      },
    },
  },
});
