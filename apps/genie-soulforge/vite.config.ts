import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev/preview proxies keep the browser key-bearing requests same-origin, so
// providers that do not send CORS headers (OpenAI) still work locally.
const proxy = {
  '/llm/omniroute': {
    target: 'https://gateway.innotel.us',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/llm\/omniroute/, '/v1'),
  },
  '/llm/openrouter': {
    target: 'https://openrouter.ai',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/llm\/openrouter/, '/api/v1'),
  },
  '/llm/openai': {
    target: 'https://api.openai.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/llm\/openai/, '/v1'),
  },
}

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
})
