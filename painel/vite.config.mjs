import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: path.dirname(fileURLToPath(import.meta.url)),
  plugins: [react()],
  build: { outDir: '../src/web/dist', emptyOutDir: true },
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:' + (process.env.PAINEL_PORTA || 3030), changeOrigin: true },
    },
  },
})
