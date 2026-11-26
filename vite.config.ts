import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

const chunkLimit = 500_000
const deferredDiagramBudgets = [
  { module: '/@mermaid-js/parser/dist/chunks/', bytes: 700_000 },
  { module: '/elkjs/lib/elk.bundled.js', bytes: 1_550_000 },
]

function checkChunkSizes(): Plugin {
  return {
    name: 'yeyu-build-chunk-budget',
    apply: 'build',
    generateBundle(_options, bundle) {
      const startup = new Set<string>()
      function addStaticImports(name: string) {
        if (startup.has(name)) return
        startup.add(name)
        const chunk = bundle[name]
        if (chunk?.type === 'chunk') chunk.imports.forEach(addStaticImports)
      }
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk' && chunk.isEntry) addStaticImports(chunk.fileName)
      }
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue
        const size = Buffer.byteLength(chunk.code)
        if (size <= chunkLimit) continue
        // 上游生成的语法表和 ELK 各是一整个模块，只允许在按需加载的图表中使用其独立上限。
        const modules = Object.keys(chunk.modules)
        const allowance = deferredDiagramBudgets.find(item => modules.some(id => id.includes(item.module)))
        if (!startup.has(chunk.fileName) && allowance && size <= allowance.bytes) continue
        this.error(chunk.fileName + ' 的大小 ' + size + ' 字节超出构建体积上限')
      }
    },
  }
}

export default defineConfig({
  clearScreen: false,
  plugins: [checkChunkSizes()],
  define: { __YEYU_QA__: JSON.stringify(process.env.YEYU_QA === '1') },
  build: {
    target: ['safari16', 'chrome105'], assetsInlineLimit: 0,
    chunkSizeWarningLimit: Math.max(...deferredDiagramBudgets.map(item => item.bytes)) / 1000,
    rolldownOptions: {
      input: ['index.html', 'mobile.html'].map(file => fileURLToPath(new URL(file, import.meta.url))),
      output: {
        codeSplitting: {
          groups: [{ name: 'syntax-highlighting', test: /\/highlight\.js\/lib\//, minSize: 30_000, maxSize: 340_000 }],
        },
      },
    },
  },
  server: { host: '127.0.0.1', port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
})
