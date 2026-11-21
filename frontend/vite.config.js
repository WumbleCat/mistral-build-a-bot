import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },

  build: {
    // Three.js is ~600 kB and unavoidable for the exploded view. It is already behind a
    // dynamic import, so it never touches the initial load -- the warning would only tempt
    // someone to "fix" a split that is already correct. 700 still flags a real regression.
    chunkSizeWarningLimit: 700,

    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // Keep the Three.js vendor code in its own chunk so edits to ExplodedView.jsx
            // don't invalidate 600 kB of cached library on every deploy.
            { name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/ },
          ],
        },
      },
    },
  },
})
