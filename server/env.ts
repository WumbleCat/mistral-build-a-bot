/**
 * Load .env into process.env (Node 22+ built-in, no dependency).
 *
 * Imported first in vite.config.ts: the server modules read settings such as
 * MISTRAL_VISION_MODEL when they are imported, so .env must be loaded before them.
 * Only server/*.ts reads these; nothing is exposed to the browser.
 */
try {
  process.loadEnvFile();
} catch {
  /* no .env file — integrations stay disabled */
}
