// 用发布配置启动真实 Tauri 窗口，固定输入文件及操作；系统依赖由运行者提供。
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

const [exe, kind = 'full'] = process.argv.slice(2)
if (!exe || !['full', 'measure', 'titlebar', 'opencode', 'windows', 'writing-live', 'finder-open', 'vault'].includes(kind)) {
  throw new Error('用法：node scripts/native-qa.mjs <QA 程序> [full|measure|titlebar|opencode|windows|writing-live|finder-open|vault]')
}
const folder = mkdtempSync(join(tmpdir(), 'yeyu-native-'))
const finderBundle = process.platform === 'darwin' ? process.env.YEYU_QA_FINDER_BUNDLE : undefined
const root = join(folder, 'workspace')
const guide = join(root, '验收.md')
const plainText = join(root, '纯文本.txt')
const mb1 = join(root, '1-mib.md')
const mb10 = join(root, '10-mib.md')
const report = join(folder, 'case.json')
const assets = join(root, 'assets')
mkdirSync(assets, { recursive: true })
copyFileSync('assets/app-icon.png', join(assets, 'icon.png'))
const sample = readFileSync('tests/fixtures/acceptance.md', 'utf8').trimEnd().split('\n')
const guideText = sample.map((line, index) => line + (index % 7 ? '\r\n' : '\n')).join('')
writeFileSync(guide, '\uFEFF' + guideText)
writeFileSync(plainText, '\uFEFF第二个原生窗口\r\n')
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
const batchPaths = ['格式一.md', '格式二.md', '格式三.md'].map(name => join(folder, name))
for (const [index, path] of batchPaths.entries()) writeFileSync(path, '\uFEFF# 第 ' + (index + 1) + ' 章\r\n原段落  \n下一行\r\n')
const gallery = join(folder, '图库.md')
const galleryText = '# 图库\r\n\r\n![首图](<源 图.png> "图片说明")\r![重复](copy.png)\n![缺失](missing.png)\r\n![外链](https://example.test/a.png)\r\n\r\n```md\n![代码中的链接](copy.png)\n```\n'
writeFileSync(gallery, galleryText)
copyFileSync('assets/app-icon.png', join(folder, '源 图.png'))
copyFileSync('assets/app-icon.png', join(folder, 'copy.png'))
const setup = {
  phase: kind, root, guide, mb1, mb10, exports, plugin, updatedPlugin, batchPaths, gallery, plainText,
  finder: !!finderBundle,
  themes: [...themes, { path: customTheme, name: '相对资源与级联夹具' }],
  typora: process.env.YEYU_TEST_TYPORA ? JSON.parse(process.env.YEYU_TEST_TYPORA) : undefined,
  typoraConfig: process.env.YEYU_TEST_TYPORA_CONFIG === '1',
  publicMarket: process.env.YEYU_TEST_PUBLIC_MARKET,
  model: process.env.YEYU_TEST_MODEL_URL ? { endpoint: process.env.YEYU_TEST_MODEL_URL, name: process.env.YEYU_TEST_MODEL ?? 'yeyu-qwen' } : undefined,
}
const logfile = (phase) => join(folder, phase + '.log')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let child
let launchFailure
function boot(phase, details = {}) {
  writeFileSync(report, JSON.stringify({ ...setup, ...details, phase, epoch: Date.now() }))
  child = spawn(resolve(exe), [], { env: { ...process.env, YEYU_QA_CASE: folder,
    ...(phase === 'windows' ? { YEYU_QA_NATIVE_PANELS: '1' } : {}),
  }, stdio: ['ignore', 'pipe', 'pipe'] })
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

async function serveFixtures(aiFixtureKey) {
  const marketPackages = join(folder, 'market-packages')
  const marketRoot = join(folder, 'market')
  mkdirSync(marketPackages)
  copyFileSync(updatedPlugin, join(marketPackages, 'trim-lines.yeyu-plugin.json'))
  execFileSync(process.execPath, ['scripts/build-plugin-market.mjs', marketPackages, marketRoot])
  const marketIndex = readFileSync(join(marketRoot, 'index.json'))
  const packagePath = JSON.parse(marketIndex).plugins[0].download
  const marketPackage = readFileSync(join(marketRoot, packagePath))
  let damageOnce = true
  let marketReads = 0
  const http = createServer(async (request, response) => {
    if (request.method === 'POST' && request.url?.startsWith('/qa-ai/')) {
      try {
        const [, , provider] = request.url.split('/')
        const routes = { chat: 'chat/completions', anthropic: 'messages', responses: 'responses' }
        assert.equal(request.url, `/qa-ai/${provider}/v1/${routes[provider]}`)
        const data = []
        for await (const chunk of request) data.push(chunk)
        const body = JSON.parse(Buffer.concat(data))
        assert.equal(body.stream, true)
        let events
        if (provider === 'chat') {
          assert.equal(body.model, 'qa-shared')
          assert.equal(body.reasoning_effort, 'high')
          assert.ok(body.messages.some(message => message.role === 'user' && /The draft is wordy\./.test(message.content)))
          assert.match(body.messages[0].content, /verbose/)
          events = [{ choices: [{ delta: { reasoning_content: '先核对改写范围。' } }] },
            { choices: [{ delta: { content: 'The draft is verbose.' }, finish_reason: null }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }] }]
        } else if (provider === 'anthropic') {
          assert.equal(request.headers['anthropic-version'], '2023-06-01')
          assert.equal(body.model, 'claude-opus-4-6')
          assert.equal(body.messages.length, 1)
          assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' })
          assert.equal(body.output_config.effort, 'low')
          events = [{ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '核对 Anthropic 的思考文本。' } },
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'anthropic·' + body.model } }, { type: 'message_stop' }]
        } else {
          assert.equal(request.headers.authorization, aiFixtureKey ? 'Bearer ' + aiFixtureKey : undefined)
          if (aiFixtureKey) assert.ok(!readFileSync(join(folder, 'app-data', 'ai.json'), 'utf8').includes(aiFixtureKey))
          assert.equal(body.model, 'gpt-5.4-qa')
          assert.equal(body.input.length, 1)
          assert.deepEqual(body.reasoning, { effort: 'low', summary: 'auto' })
          events = [{ type: 'response.reasoning_summary_text.delta', delta: '核对 Responses 的思考摘要。' },
            { type: 'response.output_text.delta', delta: 'responses·' + body.model }, { type: 'response.completed' }]
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify(events[0])}\n\n`)
        await delay(350)
        response.end(events.slice(1).map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
      } catch {
        response.writeHead(400).end('模型协议、路径、模型或鉴权与验收请求不符')
      }
      return
    }
    if (request.method === 'GET' && request.url === '/market/index.json') {
      // 第二次请求挂起，让桌面验收覆盖在线目录未返回时的内置安装。
      if (++marketReads === 2) await delay(8_000)
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
let temporaryVault
try {
  console.log('验收目录', folder)
  if (kind === 'measure') {
    boot(kind)
    const ready = await result('measure-ready')
    const rssStartupKiB = rss()
    const metrics = await result('measurement')
    console.log(JSON.stringify({ ...ready, ...metrics, rssStartupKiB, rssAfter10MbKiB: rss() }, null, 2))
  } else if (kind === 'titlebar') {
    boot(kind)
    console.log(JSON.stringify(await result(kind), null, 2))
  } else if (kind === 'finder-open') {
    assert.ok(finderBundle, '请用 YEYU_QA_FINDER_BUNDLE 指定 QA .app')
    const warm = process.env.YEYU_QA_FINDER_WARM === '1'
    writeFileSync(report, JSON.stringify({ ...setup, finderWarm: warm, epoch: Date.now() }))
    child = spawn('/usr/bin/open', ['-W', '-n', '-a', finderBundle, '--env', 'YEYU_QA_CASE=' + folder,
      '--stdout', logfile(kind), '--stderr', logfile(kind), ...(warm ? [] : [guide])], { stdio: 'inherit' })
    child.once('error', error => { launchFailure = error })
    try {
      if (warm) {
        await result('finder-ready')
        execFileSync('/usr/bin/open', ['-a', finderBundle, guide])
      }
      const first = await result('finder-first')
      assert.deepEqual(first.windows, ['main'])
      execFileSync('/usr/bin/open', ['-a', finderBundle, guide, plainText])
      console.log(JSON.stringify(await result('finder-open'), null, 2))
    } finally {
      const launch = join(finderBundle, 'Contents', 'MacOS', 'yeyu')
      const processes = execFileSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).trim().split('\n')
      for (const line of processes) {
        const found = /^\s*(\d+)\s+(.+)$/.exec(line)
        if (found?.[2] === launch) process.kill(Number(found[1]))
      }
    }
  } else if (kind === 'vault') {
    const aiFixtureKey = 'ya-vault-fixture-' + randomUUID()
    remote = await serveFixtures(aiFixtureKey)
    const aiFixture = new URL('/qa-ai', remote.url).href
    boot(kind, { aiFixture, aiFixtureKey })
    const report = await result('vault')
    const folderData = join(folder, 'app-data')
    const catalog = readFileSync(join(folderData, 'ai.json'), 'utf8')
    const { credential } = JSON.parse(catalog).providers[0]
    assert.ok(!catalog.includes(aiFixtureKey))
    if (process.platform === 'darwin') {
      assert.match(credential, /^local-/)
      assert.ok(!readFileSync(join(folderData, 'ai-credentials', credential)).includes(aiFixtureKey))
    }
    await terminate()
    boot('vault-recover', { aiFixture, aiFixtureKey })
    console.log(JSON.stringify({ ...report, ...await result('vault-recover') }, null, 2))
  } else if (kind === 'windows') {
    boot(kind)
    if (finderBundle) {
      await result('finder-ready')
      execFileSync('open', ['-a', finderBundle, plainText, guide])
    }
    const verified = await result(kind)
    await result('window-main-draft')
    await result('window-other-draft')
    assert.match(readFileSync(guide, 'utf8'), /已保存的 Markdown$/)
    assert.match(readFileSync(plainText, 'utf8'), /已保存的 TXT$/)
    await terminate('SIGKILL')
    boot('recover-windows')
    await result('window-main-recovered')
    await result('window-other-recovered')
    console.log(JSON.stringify({ ...verified, savedIndependently: true, recoveredBoth: true, finder: !!finderBundle }, null, 2))
  } else if (kind === 'opencode') {
    boot(kind)
    const configuration = await result('opencode-config')
    const [command, ...args] = configuration.v2.mcp.servers.yeyu.command
    assert.deepEqual(configuration.v1.mcp.yeyu.command, [command, ...args])
    await explicitClient({ command, args })
    console.log(JSON.stringify({ ...configuration, ...await result(kind), stdio: true }, null, 2))
  } else if (kind === 'writing-live') {
    const configuration = process.env.YEYU_QA_AI_SETTINGS
    if (!configuration) throw new Error('请指定 YEYU_QA_AI_SETTINGS，使用其中当前模型测试真实写作请求')
    const { providers, active } = JSON.parse(readFileSync(configuration, 'utf8'))
    const provider = providers?.find(item => item.id === active?.providerId && item.models.includes(active.model))
    if (!provider) throw new Error('配置文件里没有可用的当前模型')
    const appData = join(folder, 'app-data')
    mkdirSync(appData)
    const { id, name, endpoint, protocol, models, modelOptions, credential } = provider
    if (process.platform === 'darwin' && credential) {
      if (!/^local-[a-f0-9-]{36}$/i.test(credential)) throw new Error('请使用页屿密钥库的模型配置启动真实验收')
      const vault = join(dirname(configuration), 'ai-credentials')
      temporaryVault = join(appData, 'ai-credentials')
      mkdirSync(temporaryVault, { mode: 0o700 })
      // 只复制本次使用的加密记录，测试结束后删除这个临时密钥库。
      for (const file of ['vault.key', credential]) {
        const target = join(temporaryVault, file)
        copyFileSync(join(vault, file), target)
        chmodSync(target, 0o600)
      }
    }
    writeFileSync(join(appData, 'ai.json'), JSON.stringify({ providers: [{ id, name, endpoint, protocol, models, modelOptions, credential }], active }), { mode: 0o600 })
    const markdown = '# 发布会验收记录\n\n负责人：林宁\n截止时间：12 月 3 日 17:00\n状态：草稿\n'
    writeFileSync(guide, markdown)
    const scope = provider.id + '\n' + provider.endpoint
    const chat = randomUUID()
    const code = 'YEYU-417-KP'
    const messages = [
      { role: 'user', text: `发布会验收识别码是 ${code}。任何精简记录都应准确保留它。` + '验收时用这条记录核对现场投屏和字幕的版本。'.repeat(25) },
      { role: 'assistant', text: `已记录识别码 ${code}，验收负责人是林宁。` + '届时会先检查投屏和字幕，然后核对登记结果。'.repeat(16) },
      { role: 'user', text: '下次会议请准备一页纸议程。' },
      { role: 'assistant', text: '已记录，下次会议使用一页议程。' },
    ]
    const conversation = { id: chat, scope, title: '压缩验收', messages, summary: '', covered: 0, updated: Date.now() }
    writeFileSync(join(appData, 'ai-conversations.json'), JSON.stringify({ conversations: [conversation], selected: { [scope]: chat } }))
    const cacheFile = join(root, '合成现场记录.txt')
    const cacheCode = 'YEYU-REC-6219'
    const topics = ['舞台口播', '灯光方案', '设备巡检', '物料登记', '车辆调度', '系统登出', '仓库交接', '摄影机位']
    const notes = Array.from({ length: 120 }, (_, i) =>
      `样例 ${i + 1} ${topics[i % topics.length]}。请核对版本 ${1007 + i * 23}、登记窗口 ${8 + i % 13} 点和备份编号 ${2003 + i * 37}。所有记录都是用于验证写作功能的虚构样本。 `)
    writeFileSync(cacheFile, `这是缓存验收用虚构记录。主馆通行校验码为 ${cacheCode}。\n\n` + notes.join('\n'))
    const imageCode = process.env.YEYU_QA_VISION === '1' ? '9472' : undefined
    boot(kind, { writingLive: { chat, code, markdown, cacheFile, cacheCode, imageCode } })
    const verified = await result(kind, 410_000)
    console.log(JSON.stringify(verified, null, 2))
    assert.equal(verified.agent.passed, true)
    assert.equal(verified.compression.passed, true)
    if (process.env.YEYU_QA_CACHE === '1') assert.equal(verified.cache.passed, true)
    if (imageCode) assert.equal(verified.vision.passed, true)
  } else {
    const aiFixtureKey = process.env.YEYU_TEST_KEYS === '1' ? 'qa-only-' + randomUUID() : undefined
    remote = await serveFixtures(aiFixtureKey)
    const aiFixture = new URL('/qa-ai', remote.url).href
    const data = join(folder, 'app-data')
    mkdirSync(data)
    const aiFile = join(data, 'ai.json')
    writeFileSync(aiFile, JSON.stringify({ endpoint: aiFixture + '/chat/v1/chat/completions', model: 'qa-shared' }))
    boot(kind, {
      mcp: remote.url,
      aiFixture, aiFixtureKey,
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
    assert.equal(JSON.parse(readFileSync(aiFile, 'utf8')).providers.length, 2)
    const organized = readFileSync(gallery, 'utf8')
    const picture = /\(([^) ]+\/image-[a-f0-9]{20}\.png)/.exec(organized)?.[1]
    assert.ok(picture)
    assert.deepEqual(readFileSync(join(folder, decodeURIComponent(picture))), readFileSync(join(folder, '源 图.png')))
    assert.deepEqual(readFileSync(join(folder, 'copy.png')), readFileSync(join(folder, '源 图.png')))
    assert.ok(readFileSync(batchPaths[0]).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))
    await terminate('SIGKILL')
    boot('recover', { recoveryText: partial.recoveryText, activeModel: partial.ai.active })
    const recovery = await result('recovery')
    delete partial.recoveryText
    console.log(JSON.stringify({ ...partial, ...recovery }, null, 2))
  }
} finally {
  await terminate()
  if (temporaryVault) rmSync(temporaryVault, { recursive: true, force: true })
  remote?.http.closeAllConnections()
  remote?.http.close()
}
