import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    watch: {
      // Runtime state written by the local canvas helper is not application
      // source. Watching it causes Vite to full-reload the page every few seconds.
      ignored: ['**/server/data/**', '**/canvas/**'],
    },
    proxy: {
      '/api': 'http://localhost:4317',
    },
  },
})
