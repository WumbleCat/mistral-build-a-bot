import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
// Must come before ./server/api: the server modules read their settings on import.
import './server/env';
import { handleApi } from './server/api';

/** Mounts the server-side /api/* routes on both dev and preview servers. */
function apiPlugin(): Plugin {
  const middleware = async (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    next: (err?: unknown) => void,
  ) => {
    const pathname = (req.url || '').split('?')[0];
    try {
      const handled = await handleApi(req, res, pathname);
      if (!handled) next();
    } catch (err) {
      next(err);
    }
  };
  return {
    name: 'buildfromvision-api',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

/**
 * The robot_bom Python pipeline (photo -> BOM) runs as its own server
 * (`npm run bom-api`). /bom/* is forwarded to it so the browser stays same-origin.
 */
const bomProxy = {
  '/bom': {
    target: process.env.ROBOT_BOM_URL || 'http://127.0.0.1:8001',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/bom/, ''),
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), apiPlugin()],
  server: {
    port: 5173,
    host: true,
    proxy: bomProxy,
  },
  preview: {
    proxy: bomProxy,
  },
});
