// 用发布配置启动真实 Tauri 窗口，固定输入文件及操作；系统依赖由运行者提供。
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

const [exe, kind = 'full'] = process.argv.slice(2)
if (!exe || !['full', 'measure'].includes(kind)) throw new Error('用法：node scripts/native-qa.mjs <QA 程序> [full|measure]')
const folder = mkdtempSync(join(tmpdir(), 'yeyu-native-'))
const root = join(folder, 'workspace')
const guide = join(root, '验收.md')
const mb1 = join(root, '1-mib.md')
const mb10 = join(root, '10-mib.md')
const report = join(folder, 'case.json')
const assets = join(root, 'assets')
mkdirSync(assets, { recursive: true })
copyFileSync('assets/app-icon.png', join(assets, 'icon.png'))
const sample = readFileSync('tests/fixtures/acceptance.md', 'utf8').trimEnd().split('\n')
const guideText = sample.map((line, index) => line + (index % 7 ? '\r\n' : '\n')).join('')
writeFileSync(guide, '\uFEFF' + guideText)
for (const [size, path] of [[1 << 20, mb1], [10 << 20, mb10]]) {
  const section = Buffer.from('## Section\r\n\r\n| Model | Value |\r\n| -- | -- |\r\n| Alpha | 42 |\r\n\r\n' +
    ('同一页中的长文档段落，使用**实时编辑**记录进度。\n'.repeat(14)) + '\n')
  const header = Buffer.from('# 固定性能测试文档\r\n\r\n')
  const body = Buffer.alloc(size, ' ')
  header.copy(body)
  let offset = header.length
  while (offset + section.length < size) { section.copy(body, offset); offset += section.length }
  body.write('\n\n', offset)
  body.write('\n', size - 1)
  writeFileSync(path, body)
}

const customTheme = join(folder, 'theme', 'qa.css')
mkdirSync(join(dirname(customTheme), 'nested'), { recursive: true })
copyFileSync('assets/app-icon.png', join(dirname(customTheme), 'nested', 'paper.png'))
writeFileSync(customTheme, '@import "nested/colors.css";\n#write { color: rgb(1, 2, 3); }')
writeFileSync(join(dirname(customTheme), 'nested', 'colors.css'), 'body { background-color: rgb(243, 240, 233); background-image: url("paper.png"); background-repeat: no-repeat; background-size: 42px auto; background-position: right 14px top 14px; }')
writeFileSync(join(dirname(customTheme), 'base.user.css'), '#write { color: rgb(7, 8, 9); }')
writeFileSync(join(dirname(customTheme), 'qa.user.css'), '#write { color: rgb(27, 61, 53); }')

const types = ['html', 'pdf', 'png', ...(process.env.YEYU_PANDOC ? ['docx'] : [])]
const exports = Object.fromEntries(types.map(type => [type, join(folder, '实机文档.' + type)]))
if (exports.docx) exports.imported = join(folder, '导回.md')
const themes = process.env.YEYU_TEST_THEMES ? JSON.parse(process.env.YEYU_TEST_THEMES) : []
const plugin = resolve('examples/plugins/trim-lines.yeyu-plugin.json')
const updatedPlugin = join(folder, 'trim-lines-update.yeyu-plugin.json')
writeFileSync(updatedPlugin, JSON.stringify({ ...JSON.parse(readFileSync(plugin, 'utf8')), version: '1.0.1' }))
const setup = {
  phase: kind, root, guide, mb1, mb10, exports, plugin, updatedPlugin,
  themes: [...themes, { path: customTheme, name: '相对资源与级联夹具' }],
  typora: process.env.YEYU_TEST_TYPORA ? JSON.parse(process.env.YEYU_TEST_TYPORA) : undefined,
  typoraConfig: process.env.YEYU_TEST_TYPORA_CONFIG === '1',
  model: process.env.YEYU_TEST_MODEL_URL ? { endpoint: process.env.YEYU_TEST_MODEL_URL, name: process.env.YEYU_TEST_MODEL ?? 'yeyu-qwen' } : undefined,
}
const logfile = (phase) => join(folder, phase + '.log')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let child
let launchFailure
function boot(phase, details = {}) {
  writeFileSync(report, JSON.stringify({ ...setup, ...details, phase, epoch: Date.now() }))
  child = spawn(resolve(exe), [], { env: { ...process.env, YEYU_QA_CASE: folder }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.once('error', error => { launchFailure = error })
  // 日志只写入本次临时目录，包含原生加载错误。
  const log = createLog(logfile(phase))
  child.stdout.on('data', log)
  child.stderr.on('data', log)
}
function createLog(path) {
  return buffer => writeFileSync(path, buffer, { flag: 'a' })
}
async function terminate(signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill(signal)
  const deadline = Date.now() + 4000
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(50)
}
async function result(name, limit = 75_000) {
  const path = join(folder, name + '.json')
  const end = Date.now() + limit
  while (!existsSync(path)) {
    if (launchFailure) throw launchFailure
    const failure = join(folder, 'failure.json')
    if (existsSync(failure)) throw new Error(readFileSync(failure, 'utf8'))
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('应用退出，日志 ' + logfile(kind))
    if (Date.now() > end) throw new Error('等待结果超时 ' + path)
    await delay(70)
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}

async function serveMcp() {
  const marketPackages = join(folder, 'market-packages')
  const marketRoot = join(folder, 'market')
  mkdirSync(marketPackages)
  copyFileSync(updatedPlugin, join(marketPackages, 'trim-lines.yeyu-plugin.json'))
  execFileSync(process.execPath, ['scripts/build-plugin-market.mjs', marketPackages, marketRoot])
  const marketIndex = readFileSync(join(marketRoot, 'index.json'))
  const packagePath = JSON.parse(marketIndex).plugins[0].download
  const marketPackage = readFileSync(join(marketRoot, packagePath))
  let damageOnce = true
  const http = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/market/index.json') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(marketIndex)
      return
    }
    if (request.method === 'GET' && request.url === '/market/' + packagePath) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
        .end(damageOnce ? Buffer.concat([marketPackage, Buffer.from('\n')]) : marketPackage)
      damageOnce = false
      return
    }
    if (request.method === 'POST' && request.url === '/upload') {
      try {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const { list } = JSON.parse(Buffer.concat(chunks).toString())
        assert.deepEqual(list, [realpathSync(join(assets, 'icon.png'))])
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, result: ['https://example.test/icon.png'] }))
      } catch {
        response.writeHead(400).end('Unexpected upload request')
      }
      return
    }
    const app = new McpServer({ name: 'test-yeyu-remote', version: '0.1.0' })
    app.registerTool('ping_sample', { description: 'Return a fixed test message' }, () => ({ content: [{ type: 'text', text: 'pong' }] }))
    app.registerResource('sample', 'notes://sample', { description: 'A Markdown resource', mimeType: 'text/markdown' }, uri =>
      ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: '# Test resource' }] }))
    app.registerPrompt('sample_prompt', { description: 'A test prompt' }, () =>
      ({ messages: [{ role: 'user', content: { type: 'text', text: 'Summarize the test document' } }] }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    response.on('close', () => void app.close())
    try {
      await app.connect(transport)
      await transport.handleRequest(request, response)
    } catch (error) {
      if (!response.headersSent) response.writeHead(500)
      response.end(String(error))
    }
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  return { http, url: 'http://127.0.0.1:' + http.address().port + '/mcp' }
}

async function explicitClient(command) {
  const client = new Client({ name: 'yeyu-acceptance-client', version: '0.1.0' })
  await client.connect(new StdioClientTransport(command))
  try {
    const discovered = (await client.listTools()).tools.map(tool => tool.name)
    assert.deepEqual(discovered.sort(), ['current_selection', 'read_document', 'search_documents', 'suggest_edit'])
    const found = await client.callTool({ name: 'search_documents', arguments: { query: '页屿实机验收' } })
    assert.match(JSON.stringify(found), /验收.md/)
    const fromDisk = await client.callTool({ name: 'read_document', arguments: { path: '验收.md' } })
    const value = fromDisk.structuredContent ?? JSON.parse(fromDisk.content[0].text)
    const selected = await client.callTool({ name: 'current_selection', arguments: {} })
    assert.match(JSON.stringify(selected), /原始段落/)
    const from = value.text.indexOf('原始段落')
    const proposal = await client.callTool({ name: 'suggest_edit', arguments: {
      path: '验收.md', version: value.version, from, to: from + 4, replacement: 'MCP 已审阅段落', summary: '客户端提出的修订'
    } })
    assert.match(JSON.stringify(proposal), /awaiting_review/)
    assert.equal(readFileSync(guide, 'utf8'), '\uFEFF' + guideText)
  } finally { await client.close() }
}

function rss() {
  return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' }).trim())
}

let remote
try {
  console.log('验收目录', folder)
  if (kind === 'measure') {
    boot(kind)
    const ready = await result('measure-ready')
    const rssStartupKiB = rss()
    const metrics = await result('measurement')
    console.log(JSON.stringify({ ...ready, ...metrics, rssStartupKiB, rssAfter10MbKiB: rss() }, null, 2))
  } else {
    remote = await serveMcp()
    boot(kind, {
      mcp: remote.url,
      picgo: new URL('/upload', remote.url).href,
      market: new URL('/market/index.json', remote.url).href,
    })
    const output = await result('exported', 90_000)
    assert.equal(output.themes.at(-1).color, 'rgb(27, 61, 53)')
    assert.equal(output.themes.at(-1).embeddedBackground, true)
    assert.equal(output.themes.at(-1).backgroundRepeat, 'no-repeat')
    assert.match(readFileSync(exports.pdf).subarray(0, 5).toString(), /^%PDF-/)
    assert.deepEqual([...readFileSync(exports.png).subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    const html = readFileSync(exports.html, 'utf8')
    assert.match(html, /data:image\/png;base64,/)
    assert.match(html, /class="markdown-diagram"/)
    await explicitClient(await result('mcp-ready', 120_000))
    await result('external-ready')
    writeFileSync(guide, readFileSync(guide, 'utf8') + '\r\n外部程序写入\r\n')
    await result('conflict-ready')
    writeFileSync(guide, readFileSync(guide, 'utf8') + '\r\n外部冲突内容\r\n')
    const partial = await result('crash-ready')
    await terminate('SIGKILL')
    boot('recover', { recoveryText: partial.recoveryText })
    const recovery = await result('recovery')
    delete partial.recoveryText
    console.log(JSON.stringify({ ...partial, ...recovery }, null, 2))
  }
} finally {
  await terminate()
  remote?.http.closeAllConnections()
  remote?.http.close()
}
