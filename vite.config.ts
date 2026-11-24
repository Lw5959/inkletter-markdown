import { defineConfig } from 'vite'

export default defineConfig({
  clearScreen: false,
  define: { __YEYU_QA__: JSON.stringify(process.env.YEYU_QA === '1') },
  build: { target: ['safari16', 'chrome105'], assetsInlineLimit: 0 },
  server: { host: '127.0.0.1', port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
})
