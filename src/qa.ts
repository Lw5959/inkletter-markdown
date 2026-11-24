import type { AiProtocol, Editor, ExportFormat, PluginInfo, ShellAction, ShellState, WorkspaceEntry } from './contracts'
import type { Writing } from './ai'
import type { Protocol } from './mcp'
import { invoke, native, reason } from './native'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { imageLinks } from './images'
import { aiTasks } from './ai-prompts'

type Case = {
  phase: 'full' | 'recover' | 'measure'
  epoch: number
  root: string
  guide: string
  mb1: string
  mb10: string
  themes: { path: string; name: string }[]
  exports: Record<string, string>
  recoveryText?: string
  model?: { endpoint: string; name: string }
  mcp: string
  plugin: string
  updatedPlugin: string
}
type Ports = {
  editor: Editor; state: ShellState; writing: Writing; protocol: Protocol;
  action: (action: ShellAction) => Promise<void>;
  openPath: (path: string, line?: number, checkUnsaved?: boolean) => Promise<boolean>;
  setWorkspace: (path: string | null) => Promise<void>; addTheme: (path: string) => Promise<void>;
  installPlugin: (path: string) => Promise<PluginInfo[]>;
  exportTo: (path: string, format: ExportFormat) => Promise<void>;
  saveFile: () => Promise<boolean>; checkpoint: () => Promise<unknown>; text: () => string;
  monitor: () => Promise<void>; shareSelection: () => Promise<void>; setDocument: (value: null) => void;
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
const mark = (name: string, data: unknown) => invoke('qa_report', { name, data })
const config = () => invoke<Case>('qa_config')
const button = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!
function check(value: unknown, name: string): asserts value {
  if (!value) throw new Error('验收失败：' + name)
}
async function until(ready: () => boolean, ms = 10_000) {
  const deadline = performance.now() + ms
  while (!ready()) {
    if (performance.now() > deadline) throw new Error('等待验收状态超时')
    await wait(40)
  }
}

export async function prepareRecovery() {
  const scenario = await config()
  if (scenario.phase !== 'recover') return
  const observer = new MutationObserver(() => {
    const dialog = [...document.querySelectorAll<HTMLDialogElement>('.app-dialog')].find(element =>
      element.querySelector('h2')?.textContent === '恢复未保存文档')
    if (dialog?.open) {
      dialog.querySelector<HTMLButtonElement>('[value="recover"]')!.click()
      observer.disconnect()
    }
  })
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] })
}

function input(operation: 'mark' | 'insert', character: string) {
  return invoke('qa_input', { operation, character })
}

async function composedInput(ports: Ports) {
  const original = ports.text()
  const offset = original.length
  const results = []
  for (const mode of ['live', 'source'] as const) {
    await ports.action({ type: 'mode', mode })
    ports.editor.select({ anchor: offset, head: offset })
    ports.editor.focus()
    const events: string[] = []
    const content = document.querySelector('.cm-content')!
    const capture = (event: Event) => { if (event.isTrusted) events.push(event.type) }
    const names = ['compositionstart', 'compositionupdate', 'compositionend']
    for (const name of names) content.addEventListener(name, capture)
    let error = ''
    try {
      await input('mark', 'zhong')
      await wait(55)
      await input('mark', '中文')
      await wait(55)
      await input('insert', '中文')
      await wait(70)
    } catch (failure) {
      error = reason(failure)
    } finally {
      for (const name of names) content.removeEventListener(name, capture)
    }
    const tail = ports.text().slice(offset)
    if (tail) {
      ports.editor.undo()
      for (let count = 0; count < 2 && ports.text() !== original; count++) ports.editor.undo()
    }
    results.push({ mode, tail, events, error, passed: tail === '中文' && events.includes('compositionend') })
  }
  await ports.action({ type: 'mode', mode: 'live' })
  return results
}

async function measure(ports: Ports, scenario: Case) {
  const result: Record<string, unknown> = {}
  await ports.action({ type: 'autosave', enabled: false })
  await frame()
  result.startupMs = Date.now() - scenario.epoch
  await mark('measure-ready', result)
  await wait(400)
  let start = performance.now()
  await ports.openPath(scenario.mb1, 1, false)
  await frame()
  result.open1MbMs = Math.round(performance.now() - start)
  ports.editor.select({ anchor: 60, head: 60 })
  ports.editor.focus()
  const inputMs: number[] = []
  for (let i = 0; i < 34; i++) {
    const t = performance.now()
    await input('insert', '测')
    await frame()
    inputMs.push(performance.now() - t)
  }
  check(ports.text().includes('测'.repeat(34)), '原生文本输入抵达编辑缓冲区')
  result.inputP95Ms = Math.round(inputMs.sort((a, b) => a - b)[Math.ceil(inputMs.length * .95) - 1] * 10) / 10
  result.inputSamples = inputMs.length
  start = performance.now()
  await ports.openPath(scenario.mb10, 1, false)
  await frame()
  result.open10MbMs = Math.round(performance.now() - start)
  result.initialDomLines = document.querySelectorAll('.cm-line').length
  const end = ports.text().length
  ports.editor.select({ anchor: end, head: end })
  await frame()
  await frame()
  result.finalScrollTop = Math.round(document.querySelector('.document-theme')?.scrollTop ?? 0)
  check(Number(result.finalScrollTop) > 1000, '10 MB 滚动到底部')
  await input('insert', '十兆末尾')
  await wait(80)
  check(ports.text().endsWith('十兆末尾'), '10 MB 文档末尾输入')
  start = performance.now()
  await ports.saveFile()
  result.save10MbMs = Math.round(performance.now() - start)
  check((await native.read(scenario.mb10)).text.endsWith('十兆末尾'), '10 MB 文件保存')
  await mark('measurement', result)
}

async function verifyFull(ports: Ports, scenario: Case) {
  const result: Record<string, unknown> = {}
  if (document.querySelector('[data-mac-titlebar="true"]')) {
    type NativeTitlebar = {
      effects: string[]; overlay: boolean; hiddenTitle: boolean; transparent: boolean;
      buttonCenters: number[]; targetCenter: number;
    }
    const titlebar = () => invoke<NativeTitlebar>('qa_titlebar')
    const initial = await titlebar()
    check(initial.overlay && initial.hiddenTitle && initial.transparent, 'macOS 使用透明的系统按钮叠加标题栏')
    await ports.action({ type: 'titlebar-material', material: 'frosted' })
    const frosted = await titlebar()
    check(frosted.effects.length === 1 && frosted.effects[0] === 'NSVisualEffectView', 'AppKit 毛玻璃')
    await ports.action({ type: 'titlebar-material', material: 'liquid' })
    const liquid = await titlebar()
    const hasLiquid = (view: NativeTitlebar) => view.effects.some(name => name.endsWith('NSGlassEffectView'))
    const available = hasLiquid(initial)
    check(hasLiquid(liquid) === available, 'AppKit 液态玻璃或旧系统回退')
    for (const view of [frosted, liquid]) {
      check(view.buttonCenters.length === 3 &&
        view.buttonCenters.every(center => Math.abs(center - view.targetCenter) <= 1),
      '红黄绿按钮垂直居中 ' + JSON.stringify(view.buttonCenters))
    }
    check(document.querySelector('.yy-topbar')?.getAttribute('data-tauri-drag-region') === 'deep', '标题栏支持拖动窗口')
    result.titlebar = { frosted, liquid, available }
  }
  await ports.action({ type: 'autosave', enabled: false })
  await ports.setWorkspace(scenario.root)
  await ports.openPath(scenario.guide, 1, false)
  const filtered = await invoke<WorkspaceEntry[]>('workspace_tree', { root: scenario.root, hidden: false, all: false, filter: '**/*.png' })
  check(filtered.length === 1 && filtered[0].children?.some(child => child.name === 'icon.png'), '文件树路径规则')
  const original = await native.read(scenario.guide)
  check(original.bom && original.text.includes('\r\n') && original.text.includes('\n'), '含 BOM 与 CRLF 的原文')
  check(ports.text() === original.text, '打开保留混合换行')
  await ports.saveFile()
  check(await native.version(scenario.guide) === original.version, '未编辑保存字节完全一致')
  const offset = original.text.indexOf('原始段落')
  check(offset >= 0, '样本正文可定位')
  ports.editor.replace(offset, offset + 4, '测试段落')
  ports.editor.select({ anchor: offset, head: offset + 4 })
  const modifier = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }
  window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', code: 'Slash', bubbles: true, ...modifier }))
  await until(() => ports.state.mode === 'source')
  check(ports.editor.getSelection().head === offset + 4, '源码切换保留选区')
  await ports.action({ type: 'mode', mode: 'live' })
  await ports.action({ type: 'undo' })
  check(ports.text() === original.text, '跨模式撤销还原原文')
  result.roundtrip = true
  result.ime = await composedInput(ports)
  // 输入法是独立验收项，恢复原文后继续验证其他原生链路。
  if (ports.text() !== original.text) {
    await ports.openPath(scenario.guide, 1, false)
  }
  const image = imageLinks(ports.text())[0]
  check(image && image.url.includes('assets/'), '实际文档含相对路径图片')
  ports.editor.select({ anchor: 0, head: 0 })
  const themes: unknown[] = []
  for (const theme of scenario.themes) {
    await ports.addTheme(theme.path)
    await frame()
    await document.fonts.ready
    const paper = getComputedStyle(document.querySelector<HTMLElement>('.document-theme')!)
    const write = getComputedStyle(document.querySelector<HTMLElement>('#write')!)
    const heading = document.querySelector<HTMLElement>('#write h1')
    themes.push({
      name: theme.name, paper: paper.backgroundColor, color: write.color, font: write.fontFamily,
      appearance: document.documentElement.dataset.yeyuAppearance,
      nativeTheme: await getCurrentWindow().theme().catch(() => null),
      sidebar: getComputedStyle(document.querySelector('.yy-left-panel')!).backgroundColor,
      embeddedBackground: paper.backgroundImage.includes('data:image/png;base64,'),
      backgroundRepeat: paper.backgroundRepeat,
      heading: heading ? getComputedStyle(heading).color : null,
      faces: [...document.fonts].map(face => ({ name: face.family, status: face.status })),
    })
  }
  result.themes = themes
  await ports.exportTo(scenario.exports.html, 'html')
  await ports.exportTo(scenario.exports.pdf, 'pdf')
  await ports.exportTo(scenario.exports.png, 'png')
  if (scenario.exports.docx) {
    await ports.exportTo(scenario.exports.docx, 'docx')
    await invoke('pandoc_import', { path: scenario.exports.docx, destination: scenario.exports.imported })
    check((await native.read(scenario.exports.imported)).text.includes('页屿实机验收'), 'Pandoc DOCX 导出并导回')
  }
  result.exports = scenario.exports
  await mark('exported', result)

  if (scenario.model) {
    const body = ports.text().indexOf('The draft is wordy.')
    check(body >= 0, 'AI 选区样本')
    const selected = 'The draft is wordy.'
    ports.editor.select({ anchor: body, head: body + selected.length })
    document.querySelector<HTMLButtonElement>('[data-toggle="ai"]')!.click()
    const panel = document.querySelector('.yy-ai-pane')!
    button(panel, '模型配置').click()
    const modelPage = document.querySelector<HTMLFormElement>('form[aria-label="模型配置"]')!
    const endpoint = modelPage.querySelector<HTMLInputElement>('input[type="url"]')!
    const model = modelPage.querySelector<HTMLInputElement>('input[type="text"]')!
    model.value = scenario.model.name
    endpoint.value = 'http://model.example.invalid/v1'
    modelPage.requestSubmit()
    await until(() => !modelPage.querySelector<HTMLElement>('[role="alert"]')!.hidden)
    check(modelPage.isConnected && model.value === scenario.model.name, '模型配置失败后保留字段')
    endpoint.value = scenario.model.endpoint
    modelPage.requestSubmit()
    await until(() => !modelPage.isConnected)
    check(ports.writing.view.settings.model === scenario.model.name, '从页面保存真实模型配置')

    const rewritePrompt = 'Replace the word "wordy" with "verbose" in the supplied sentence. Keep the rest and output only the changed sentence.'
    const openPrompts = () => {
      button(panel, '默认提示词').click()
      const page = document.querySelector<HTMLFormElement>('form[aria-label="默认提示词"]')!
      button(page, '改写').click()
      return { page, input: page.querySelector('textarea')! }
    }
    const prompts = openPrompts()
    check(prompts.input.value === aiTasks.rewrite.prompt, '显示内置改写提示词')
    prompts.input.value = rewritePrompt
    prompts.input.dispatchEvent(new Event('input'))
    prompts.page.requestSubmit()
    await until(() => !prompts.page.isConnected)
    check((await native.preferences())?.aiPrompts?.rewrite === rewritePrompt, '提示词已写入本地设置')

    const scope = panel.querySelector<HTMLSelectElement>('[aria-label="添加上下文"]')!
    scope.value = 'selection'
    scope.dispatchEvent(new Event('change'))
    await until(() => ports.writing.view.context?.text === selected)
    check(panel.querySelector('.yy-context-fulltext')?.textContent === selected, '发送前可预览完整选区')
    panel.querySelector<HTMLSelectElement>('[aria-label="写作操作"]')!.value = 'rewrite'
    panel.querySelector<HTMLFormElement>('.yy-ai-composer')!.requestSubmit()
    await until(() => !ports.writing.view.pending, 60_000)
    const proposal = ports.writing.pending
    check(proposal && !ports.writing.view.error, '真实模型返回差异：' + ports.writing.view.error)
    check(ports.text() === original.text, '预览差异期间编辑缓冲区保持不变')
    await ports.action({ type: 'suggestion-apply', id: proposal.view.id, hunks: proposal.view.parts.flatMap(part => part.hunk === undefined ? [] : [part.hunk]) })
    check(ports.text() !== original.text, 'AI 建议已应用')
    const answer = ports.writing.view.messages.at(-1)?.text
    check(answer?.toLowerCase().includes('verbose'), '生成使用已保存的改写提示词')
    await ports.action({ type: 'undo' })
    check(ports.text() === original.text, 'AI 应用可撤销')
    const saved = openPrompts()
    check(saved.input.value === rewritePrompt, '重新打开提示词页面保留已保存内容')
    button(saved.page, '恢复默认').click()
    check(saved.input.value === aiTasks.rewrite.prompt, '恢复内置提示词')
    saved.page.requestSubmit()
    await until(() => !saved.page.isConnected)
    check(!(await native.preferences())?.aiPrompts?.rewrite, '恢复默认后清除本地覆盖')
    const protocols: AiProtocol[] = ['chat']
    for (const protocol of ['anthropic', 'responses'] as const) {
      await ports.action({ type: 'ai-clear' })
      await ports.action({ type: 'ai-context-clear' })
      button(panel, '模型配置').click()
      const settingsPage = document.querySelector<HTMLFormElement>('form[aria-label="模型配置"]')!
      const picker = settingsPage.querySelector('select')!
      picker.value = protocol
      picker.dispatchEvent(new Event('change'))
      settingsPage.requestSubmit()
      await until(() => !settingsPage.isConnected)
      check(ports.writing.view.settings.protocol === protocol, '保存协议 ' + protocol)
      await ports.action({ type: 'ai-send', intent: 'chat', prompt: 'Answer in just one short sentence. What is Markdown?' })
      check(!ports.writing.view.error && ports.writing.view.messages.at(-1)?.role === 'assistant',
        '协议流式输出 ' + protocol + ' ' + ports.writing.view.error)
      protocols.push(protocol)
    }
    result.ai = { answer, hunks: proposal.view.hunks, undo: true, modelPage: true, promptSettings: true, protocols }
  }

  const pluginText = '\n\n插件首行  \r\n下一行\t\r末尾  '
  const documentEnd = ports.text().length
  ports.editor.replace(documentEnd, documentEnd, pluginText)
  ports.editor.select({ anchor: documentEnd, head: documentEnd + pluginText.length })
  const [installed] = await ports.installPlugin(scenario.plugin)
  check(installed && !installed.enabled, '新安装的插件等待启用')
  const openPlugins = () => {
    document.querySelector<HTMLButtonElement>('[data-menu="edit"]')!.click()
    button(document.querySelector('.yy-menu-popover')!, '插件管理…').click()
    return document.querySelector<HTMLElement>('[aria-label="插件管理"]')!
  }
  let pluginPage = openPlugins()
  button(pluginPage, '启用').click()
  await until(() => !!button(pluginPage, '清理行尾空白'))
  const [updated] = await ports.installPlugin(scenario.updatedPlugin)
  check(updated.enabled && updated.version === '1.0.1', '运行时替换插件，保留启用状态')
  button(pluginPage, '清理行尾空白').click()
  await until(() => ports.writing.pending?.view.source === 'plugin')
  check(ports.text().endsWith(pluginText), '插件建议等待审阅')
  document.querySelector<HTMLButtonElement>('[data-suggestion-action="apply-all"]')!.click()
  await until(() => ports.text().endsWith('插件首行\r\n下一行\r末尾'))
  ports.editor.undo()
  check(ports.text().endsWith(pluginText), '插件修改可以撤销')
  ports.editor.undo()
  check(ports.text() === original.text, '撤销后回到插件验收前')
  pluginPage = openPlugins()
  button(pluginPage, '停用').click()
  await until(() => !button(pluginPage, '清理行尾空白'))
  button(pluginPage, '卸载').click()
  await until(() => pluginPage.textContent?.includes('暂无已安装插件') === true)
  check((await invoke<PluginInfo[]>('plugin_list')).length === 0, '卸载后清除插件登记')
  pluginPage.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click()
  result.plugins = { install: true, hotUpdate: true, reviewAndUndo: true, disableAndRemove: true }

  await ports.action({ type: 'mcp-authorize', allow: true })
  ports.editor.select({ anchor: offset, head: offset + 4 })
  await ports.shareSelection()
  check(ports.protocol.view.command, '生成实际 stdio 客户端配置')
  const service = JSON.parse(ports.protocol.view.command).mcpServers.yeyu
  await ports.action({ type: 'mcp-config', server: { id: 'local-qa', name: 'QA stdio', transport: 'stdio', ...service } })
  await ports.action({ type: 'mcp-connect', id: 'local-qa' })
  const local = ports.protocol.view.connections.find(item => item.server.id === 'local-qa')
  check(local?.status === 'connected', '桌面 stdio 握手：' + local?.error)
  const tool = local.items.find(item => item.name === 'read_document' && item.kind === 'tool')
  check(tool, '桌面发现本地工具')
  await ports.action({ type: 'mcp-call', id: 'local-qa', item: tool, args: { path: '验收.md' } })
  check(ports.protocol.view.result.includes('页屿实机验收'), '桌面调用本地 MCP')
  if (scenario.mcp) {
    await ports.action({ type: 'mcp-config', server: { id: 'http-qa', name: 'QA HTTP', transport: 'http', url: scenario.mcp } })
    await ports.action({ type: 'mcp-connect', id: 'http-qa' })
    const remote = ports.protocol.view.connections.find(item => item.server.id === 'http-qa')
    check(remote?.status === 'connected', 'Streamable HTTP 握手：' + remote?.error)
    for (const kind of ['tool', 'resource', 'prompt'] as const) {
      const entry = remote.items.find(item => item.kind === kind)
      check(entry, 'Streamable HTTP 发现 ' + kind)
      await ports.action({ type: 'mcp-call', id: 'http-qa', item: entry, args: {} })
      check(!ports.protocol.view.error, 'Streamable HTTP 调用 ' + kind + '：' + ports.protocol.view.error)
    }
    result.httpMcp = true
  }
  await mark('mcp-ready', service)
  await until(() => ports.protocol.proposals.length > 0, 25_000)
  await ports.action({ type: 'mcp-next' })
  const item = ports.writing.pending
  check(item?.view.source === 'mcp', '工作区建议进入差异视图')
  check(ports.text() === original.text, '审批前原文保持不变')
  await ports.action({ type: 'suggestion-apply', id: item.view.id, hunks: [0] })
  check(ports.text().includes('MCP 已审阅段落'), '应用 MCP 修改建议')
  check(await ports.saveFile() && (await native.read(scenario.guide)).text.includes('MCP 已审阅段落'), '批准后可保存 MCP 修改')
  result.mcp = { local: true, externalProposal: true, saved: true }
  await mark('external-ready', {})
  await until(() => ports.text().includes('外部程序写入'))
  result.external = true
  ports.editor.replace(ports.text().length, ports.text().length, '\r\n本地冲突内容')
  await mark('conflict-ready', {})
  await until(() => ports.state.detail.startsWith('磁盘文件有变化'))
  const saving = ports.saveFile()
  await until(() => !!document.querySelector('.app-dialog[open] [value="cancel"]'))
  document.querySelector<HTMLButtonElement>('.app-dialog[open] [value="cancel"]')!.click()
  check(!await saving && ports.text().includes('本地冲突内容'), '取消冲突处理保留本地缓冲')
  const external = await native.read(scenario.guide)
  check(external.text.includes('外部冲突内容') && !external.text.includes('本地冲突内容'), '冲突保存没有覆盖外部版本')
  result.conflict = true
  await ports.openPath(scenario.guide, 1, false)
  ports.editor.replace(ports.text().length, ports.text().length, '\r\n未保存的恢复草稿')
  await ports.action({ type: 'mode', mode: 'source' })
  await ports.checkpoint()
  await mark('crash-ready', { ...result, recoveryText: ports.text() })
}

export async function runNativeQa(ports: Ports) {
  try {
    const scenario = await config()
    await frame()
    if (scenario.phase === 'measure') await measure(ports, scenario)
    else if (scenario.phase === 'recover') {
      check(ports.text() === scenario.recoveryText && ports.state.dirty && ports.state.mode === 'source', '强制结束后恢复内容和源码模式')
      await mark('recovery', { recovered: true, mode: ports.state.mode, dirty: ports.state.dirty })
    } else await verifyFull(ports, scenario)
  } catch (error) {
    await mark('failure', { error: reason(error), stack: error instanceof Error ? error.stack : '' })
  }
}
