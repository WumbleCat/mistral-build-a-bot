import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { handleApi } from './server/api';

// Load .env into process.env for the server-side middleware (Node 22+ built-in,
// no dependency). Only server/*.ts reads these; nothing is exposed to the browser.
try {
  process.loadEnvFile();
} catch {
  /* no .env file — integrations stay disabled */
}

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

export default defineConfig({
  plugins: [react(), apiPlugin()],
  server: {
    port: 5173,
    host: true,
  },
});
