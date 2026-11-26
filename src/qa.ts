import type { AiProtocol, AiSelection, Editor, ExportFormat, PluginInfo, ShellAction, ShellState, Theme, WorkspaceEntry } from './contracts'
import type { Writing } from './ai'
import type { Protocol } from './mcp'
import { invoke, native, reason } from './native'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { imageLinks } from './images'
import { aiTasks } from './ai-prompts'
import { readTyporaProfiles, typoraThemeKey } from './typora'
import { choose } from './dialogs'
import { showUpdate } from './ui/update-dialog'

type Case = {
  phase: 'full' | 'recover' | 'measure' | 'titlebar' | 'opencode' | 'windows' | 'recover-windows'
  epoch: number
  root: string
  guide: string
  mb1: string
  mb10: string
  themes: { path: string; name: string }[]
  typora?: string[]
  typoraConfig?: boolean
  exports: Record<string, string>
  recoveryText?: string
  model?: { endpoint: string; name: string }
  aiFixture?: string
  aiFixtureKey?: string
  activeModel?: AiSelection
  mcp: string
  picgo?: string
  market?: string
  publicMarket?: string
  plugin: string
  updatedPlugin: string
  gallery: string
  plainText: string
  finder?: boolean
  batchPaths: string[]
}
type Ports = {
  editor: Editor; state: ShellState; writing: Writing; protocol: Protocol;
  action: (action: ShellAction) => Promise<void>;
  openPath: (path: string, line?: number, checkUnsaved?: boolean) => Promise<boolean>;
  setWorkspace: (path: string | null) => Promise<void>; addTheme: (path: string) => Promise<void>;
  installPlugin: (path: string) => Promise<PluginInfo[]>;
  formatFiles: (paths: string[], run: (input: string) => Promise<string>) => Promise<void>;
  exportTo: (path: string, format: ExportFormat) => Promise<void>;
  saveFile: () => Promise<boolean>; checkpoint: () => Promise<unknown>; text: () => string;
  monitor: () => Promise<void>; shareSelection: () => Promise<void>; setDocument: (value: null) => void;
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
const mark = (name: string, data: unknown) => invoke('qa_report', { name, data })
const config = () => invoke<Case>('qa_config')
const button = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item =>
    (item.querySelector('.yy-menu-label') ?? item).textContent === text)!
function check(value: unknown, name: string): asserts value {
  if (!value) throw new Error('验收失败：' + name)
}
async function until(ready: () => boolean | Promise<boolean>, ms = 10_000) {
  const deadline = performance.now() + ms
  while (!await ready()) {
    if (performance.now() > deadline) throw new Error('等待验收状态超时')
    await wait(40)
  }
}

function chooseOption(scope: ParentNode, label: string, text: string, detail?: string) {
  const picker = scope.querySelector<HTMLButtonElement>(`[role="combobox"][aria-label="${label}"]`)!
  picker.click()
  const list = document.getElementById(picker.getAttribute('aria-controls')!)!
  const option = [...list.querySelectorAll<HTMLElement>('[role="option"]')].find(item =>
    item.querySelector('.yy-picker-option-text span')?.textContent === text &&
    (detail === undefined || item.querySelector('small')?.textContent === detail))
  check(option, `可选择 ${label} ${text}`)
  option.click()
}

function setInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

export async function prepareRecovery() {
  const scenario = await config()
  if (scenario.phase !== 'recover' && scenario.phase !== 'recover-windows') return
  const observer = new MutationObserver(() => {
    const dialog = [...document.querySelectorAll<HTMLDialogElement>('.app-dialog')].find(element =>
      element.querySelector('h2')?.textContent === '恢复未保存文档')
    if (dialog?.open) {
      observer.disconnect()
      const recover = dialog.querySelector<HTMLButtonElement>('[value="recover"]')!
      if (document.activeElement !== recover) {
        void mark('failure', { error: '恢复提示打开后未聚焦恢复草稿按钮' })
        return
      }
      recover.click()
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
  const frameIntervals: number[] = []
  const paper = document.querySelector('.yy-paper')!
  for (const [side, button] of [['left', 'left'], ['right', 'ai']] as const) {
    const trigger = document.querySelector<HTMLButtonElement>(`[data-toggle="${button}"]`)!
    const panel = document.querySelector(`.yy-sidebar-slot-${side} aside`)!
    for (let repeat = 0; repeat < 4; repeat++) {
      trigger.click()
      const columns = new Set([paper.getBoundingClientRect().width])
      let prior = performance.now()
      while (panel.getAnimations().some(item => item.playState === 'running')) {
        await frame()
        const now = performance.now()
        frameIntervals.push(now - prior)
        prior = now
        columns.add(paper.getBoundingClientRect().width)
      }
      check(columns.size === 1, '侧栏平移期间正文列宽不变')
    }
  }
  frameIntervals.sort((a, b) => a - b)
  result.sidebarMotion = {
    samples: frameIntervals.length,
    frameP95Ms: frameIntervals.length ? Math.round(frameIntervals[Math.ceil(frameIntervals.length * .95) - 1] * 10) / 10 : null,
    columnResizesDuringMotion: 0,
  }
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

function openViewSubmenu(name: '文档主题' | '协作侧栏') {
  document.querySelector<HTMLButtonElement>('[data-menu="view"]')!.click()
  const trigger = button(document.querySelector('.yy-menu-popover')!, name)
  trigger.scrollIntoView({ block: 'nearest' })
  trigger.click()
  return document.querySelector('.yy-submenu-panel')!
}

async function verifyThemeImport(ports: Ports, expected: string[]) {
  const paper = document.querySelector<HTMLElement>('.document-theme')!
  const themeList = () => invoke<Theme[]>('theme_list')
  const choose = (name: string) => button(openViewSubmenu('文档主题'), name).click()
  const themes = openViewSubmenu('文档主题')
  await until(() => expected.every(name => Boolean(button(themes, name))))
  const local = expected.includes('night') ? 'night' : expected[0]
  button(themes, local).click()
  await until(() => ports.state.detail.startsWith('已使用主题 ' + local))
  check(button(openViewSubmenu('文档主题'), local).getAttribute('aria-checked') === 'true', '本机主题首次点击即可使用并显示选中态')
  document.querySelector<HTMLButtonElement>('[data-menu="view"]')!.click()
  choose('白纸')
  await until(() => paper.dataset.theme === 'builtin-paper')
  check(getComputedStyle(paper).backgroundColor === 'rgb(255, 255, 255)', '白纸主题的正文背景为纯白')
  choose('石墨')
  await until(() => paper.dataset.theme === 'builtin-graphite')
  check(document.documentElement.dataset.yeyuAppearance === 'dark', '石墨主题覆盖整窗')

  async function importLocalThemes() {
    await ports.action({ type: 'theme-import-typora' })
    const imported = await themeList()
    check(imported.map(theme => theme.name).sort().join('\n') === [...expected].sort().join('\n'), '本机 Typora 主题完整导入')
    check(paper.dataset.theme === 'builtin-graphite', '批量导入保留当前主题')
    return imported
  }

  const initial = await importLocalThemes()
  const repeated = await importLocalThemes()
  check(initial.every((theme, index) => theme.id === repeated[index].id), '重复导入沿用主题 ID')
  choose(initial[0].name)
  await until(() => paper.dataset.theme === initial[0].id)
  return initial.map(theme => theme.name)
}

async function verifyShellPalette(ports: Ports) {
  const ai = document.querySelector<HTMLButtonElement>('[data-toggle="ai"]')!
  const pane = document.querySelector('.yy-ai-pane')!
  const summary = []
  for (const [id, appearance] of [['builtin-jade', 'light'], ['builtin-pine', 'dark']]) {
    await ports.action({ type: 'theme', id })
    ai.click()
    button(pane, '模型配置').click()
    const samples = ['.yy-topbar', '.yy-left-panel', '.yy-right-panel', '.yy-statusbar', '.yy-ai-settings']
    const background = (selector: string) => getComputedStyle(document.querySelector(selector)!).backgroundColor
    await until(() => background('.yy-right-panel') === background('.yy-left-panel'), 2_000).catch(() => {
      const right = document.querySelector('.yy-right-panel')!
      throw new Error(`协作栏没有应用主题 ${background('.yy-right-panel')} / ${background('.yy-left-panel')} / ${getComputedStyle(right).getPropertyValue('--yy-chrome-bg')}`)
    })
    const surfaces = samples.map(selector => {
      const color = background(selector)
      const [red, green, blue, alpha = 1] = (color.match(/[-\d.]+/g) ?? []).map(Number)
      check(green > Math.max(red, blue) && alpha > 0, `窗口区域跟随主题 ${selector} ${color}`)
      return color
    })
    check(await getCurrentWindow().theme() === appearance, '原生窗口明暗与主题一致')
    document.querySelector<HTMLButtonElement>('.yy-ai-settings [aria-label="关闭"]')!.click()
    ai.click()
    summary.push({ id, appearance, surfaces })
  }
  await ports.action({ type: 'theme', id: 'default' })
  return summary
}

async function verifyTyporaConfig(ports: Ports) {
  const expected = readTyporaProfiles(await native.typoraProfiles(), matchMedia('(prefers-color-scheme: dark)').matches)
  const applying = ports.action({ type: 'typora-config-import' })
  await until(() => Boolean(document.querySelector('.app-dialog[open] [value="apply"]')))
  const dialog = document.querySelector('.app-dialog[open]')!
  check(dialog.querySelector('h2')?.textContent === '导入 Typora 配置', 'Typora 配置预览')
  if (expected.theme) check(dialog.querySelector('p')?.textContent?.includes(expected.theme), '预览包含本机当前主题')
  dialog.querySelector<HTMLButtonElement>('[value="apply"]')!.click()
  await applying
  const settings = await native.preferences()
  check(ports.state.detail.startsWith('已导入 Typora 配置'), '应用 Typora 设置')
  const selected = (await invoke<Theme[]>('theme_list')).find(theme => theme.id === settings?.theme)
  if (expected.theme) check(selected && typoraThemeKey(selected.name) === typoraThemeKey(expected.theme), '应用本机 Typora 主题')
  if (expected.sidebar) check(settings?.sidebarTab === expected.sidebar, '保存侧栏偏好')
  if (expected.matchCase !== undefined) check(settings?.findOptions?.matchCase === expected.matchCase, '保存查找偏好')
  await ports.action({ type: 'autosave', enabled: false })
  return { theme: selected?.name, sidebar: settings?.sidebarTab, findOptions: settings?.findOptions }
}

async function verifyTitlebarResize() {
  const bar = document.querySelector<HTMLElement>('.yy-topbar[data-tauri-drag-region]')
  check(bar, 'macOS 标题栏拖拽区域')
  type NativeLayout = { contentSize: [number, number]; rootSize: [number, number]; webviewFrame: [number, number, number, number]; zoomed: boolean }
  const layout = async (holdWebviewSize = false) => {
    const view = await invoke<NativeLayout>('qa_titlebar', { holdWebviewSize })
    const body = document.querySelector<HTMLElement>('.yy-body')!.getBoundingClientRect()
    const footer = document.querySelector<HTMLElement>('.yy-statusbar')!.getBoundingClientRect()
    return { ...view, html: [innerWidth, innerHeight], body: [body.width, body.height], footer: footer.bottom }
  }
  const doubleClick = () => {
    // 走 Tauri 监听的标题栏双击事件，覆盖 AppKit 放大路径与网页视口。
    const event = { bubbles: true, button: 0, detail: 2, clientX: 400, clientY: 16 }
    bar.dispatchEvent(new MouseEvent('mousedown', event))
    bar.dispatchEvent(new MouseEvent('mouseup', event))
  }
  const afterClick = async () => {
    doubleClick()
    const samples = []
    for (let i = 0; i < 12; i++) {
      await wait(50)
      samples.push(await layout())
    }
    return samples
  }
  const start = await layout(true)
  const maximized = await afterClick()
  const restored = await afterClick()
  const lastMax = maximized.at(-1)!
  const lastRestored = restored.at(-1)!
  await mark('titlebar-observed', { start, maximized, restored })
  check(lastMax.zoomed !== start.zoomed && lastRestored.zoomed === start.zoomed, '双击标题栏切换原生放大状态')
  const close = (a: number, b: number) => Math.abs(a - b) <= 2
  for (const sample of [lastMax, lastRestored]) {
    check(sample.contentSize.every((dim, index) => close(dim, sample.rootSize[index]) &&
      close(dim, sample.webviewFrame[index + 2]) && close(dim, sample.html[index])),
    '窗口、WebView 和网页视口尺寸一致 ' + JSON.stringify(sample))
    check(close(sample.body[0], sample.html[0]) && close(sample.footer, sample.html[1]), '文档区域和状态栏填满窗口')
  }
  return { start, maximized: lastMax, restored: lastRestored }
}

async function verifyOpenCode(ports: Ports, scenario: Case) {
  await ports.setWorkspace(scenario.root)
  await ports.openPath(scenario.guide, 1, false)
  document.querySelector<HTMLButtonElement>('[data-toggle="ai"]')!.click()
  const composer = document.querySelector<HTMLTextAreaElement>('.yy-ai-composer textarea')!
  check(!composer.spellcheck && ['autocorrect', 'autocapitalize', 'autocomplete'].every(name => composer.getAttribute(name) === 'off'), 'AI 输入框关闭输入替换')
  document.querySelector<HTMLButtonElement>('[data-menu="edit"]')!.click()
  button(document.querySelector('.yy-menu-popover')!, '插件市场…').click()
  const market = document.querySelector<HTMLElement>('.yy-plugin-manager')!
  button(market, '内置插件').click()
  const offer = () => market.querySelector<HTMLButtonElement>('[data-market-plugin="yeyu.opencode"]')!
  await until(() => !!offer())
  offer().click()
  await until(() => offer()?.textContent === '已安装' && !offer().disabled)
  const id = 'yeyu.opencode'
  await ports.action({ type: 'plugin-enabled', id, enabled: true })
  const run = (command: string) => ports.action({ type: 'plugin-run', id, command, scope: 'document' })
  let denied = false
  try { await run('copy_v2') } catch (error) { denied = reason(error).includes('授权当前工作区') }
  check(denied, '未授权时拒绝导出 MCP 配置')
  const original = ports.text()
  const offset = original.indexOf('原始段落')
  ports.editor.select({ anchor: offset, head: offset + '原始段落'.length })
  await ports.action({ type: 'mcp-authorize', allow: true })
  const copied: string[] = []
  // 只在隔离的 QA 窗口记录复制结果，避免改动系统剪贴板。
  Object.defineProperty(navigator, 'clipboard', { value: { async writeText(text: string) { copied.push(text) } } })
  await run('copy_v1')
  await run('copy_v2')
  check(copied.length === 2 && ports.text() === original, '生成两份配置并保留正文')
  await mark('opencode-config', { v1: JSON.parse(copied[0]), v2: JSON.parse(copied[1]) })
  await verifyMcpSuggestion(ports, scenario.guide, original)
}

async function verifyMcpSuggestion(ports: Ports, path: string, original: string) {
  await until(() => ports.protocol.proposals.length > 0, 25_000)
  await ports.action({ type: 'mcp-next' })
  const item = ports.writing.pending
  check(item?.view.source === 'mcp', '工作区建议进入差异视图')
  check(ports.text() === original, '审批前原文保持不变')
  await ports.action({ type: 'suggestion-apply', id: item.view.id, hunks: [0] })
  check(ports.text().includes('MCP 已审阅段落'), '应用 MCP 修改建议')
  check(await ports.saveFile() && (await native.read(path)).text.includes('MCP 已审阅段落'), '批准后可保存 MCP 修改')
}

async function verifyWindows(ports: Ports, scenario: Case) {
  type Point = { x: number; y: number }
  type Size = { width: number; height: number }
  type Frame = { position: Point; size: Size }
  const windows = () => invoke<({ label: string; title: string; workArea: Frame } & Frame)[]>('qa_windows')
  const editorWindows = async () => (await windows()).filter(item => !item.label.startsWith('panel-'))
  await ports.action({ type: 'autosave', enabled: false })
  await ports.openPath(scenario.guide, 1, false)
  const original = ports.text()
  const draft = '\r\n独立窗口中的未保存文本'
  ports.editor.replace(original.length, original.length, draft)
  await ports.checkpoint()
  if (scenario.finder) await mark('finder-ready', {})
  else await ports.openPath(scenario.plainText)
  let editors = await editorWindows()
  for (let retry = 0; editors.length < 2 && retry < 100; retry++) {
    await wait(80)
    editors = await editorWindows()
  }
  check(editors.length === 2 && editors.some(item => item.title === '纯文本.txt'), 'TXT 文件独占一个原生文档窗口')
  await ports.openPath(scenario.plainText)
  check((await editorWindows()).length === 2, '同一路径重复打开时聚焦已有窗口')
  check(ports.text() === original + draft, '打开其他文件保留当前未保存正文')
  ports.editor.undo()
  check(ports.text() === original, '原窗口撤销栈保留')

  const current = getCurrentWindow()
  await current.setFocus()
  const editorFrame = async () => (await windows()).find(item => item.label === current.label)!
  const pluginFrame = async () => (await windows()).find(item => item.label.startsWith('panel-'))!
  const move = (position: Point) => invoke('qa_move_window', { position })
  const originalFrame = /Mac/.test(navigator.platform) ? await editorFrame() : null
  let placement: { offset: Point; editorMove: number; pluginMove: Point } | undefined
  let panelHeights: { confirm: number; latest: number; releaseNotes: number } | undefined
  if (originalFrame) {
    // 在靠近屏幕边缘的位置开窗，区分按显示器居中和按文档窗口定位两种行为。
    await move({ x: originalFrame.workArea.position.x + 24, y: originalFrame.position.y })
  }
  const opened: Window[] = []
  const originalOpen = window.open
  window.open = (...args) => {
    const child = originalOpen.apply(window, args)
    if (child) opened.push(child)
    return child
  }
  try {
    document.querySelector<HTMLButtonElement>('[data-toggle="ai"]')!.click()
    document.querySelector<HTMLButtonElement>('[data-menu="edit"]')!.click()
    button(document.querySelector('.yy-menu-popover')!, '插件市场…').click()
    check(opened.length === 1, '插件中心打开独立子窗口')
    const plugins = opened[0]
    check(plugins.document.querySelector('.yy-plugin-manager') &&
      !plugins.document.querySelector('.yy-sidebar-slot, .yy-paper'), '插件窗口有完整页面和独立布局')
    button(plugins.document, '内置插件').click()
    await until(() => !!plugins.document.querySelector('[data-market-plugin="yeyu.opencode"]'))
    check((await windows()).some(item => item.label.startsWith('panel-')), '原生枚举包含插件窗口')
    if (originalFrame) {
      const editor = await editorFrame()
      const before = await pluginFrame()
      await move({ x: editor.position.x + 128, y: editor.position.y })
      const editorMove = (await editorFrame()).position.x - editor.position.x
      const after = await pluginFrame()
      const pluginMove = { x: after.position.x - before.position.x, y: after.position.y - before.position.y }
      check(editorMove !== 0 && pluginMove.x === 0 && pluginMove.y === 0,
        `移动文档窗口时插件窗口保持原位（文档移动 ${editorMove}，插件移动 ${pluginMove.x}, ${pluginMove.y}）`)
      const work = editor.workArea
      const placed = (start: number, available: number, ownerStart: number, ownerSize: number, panelSize: number) =>
        Math.min(Math.max(ownerStart + (ownerSize - panelSize) / 2, start), start + Math.max(0, available - panelSize))
      const offset = {
        x: before.position.x - placed(work.position.x, work.size.width, editor.position.x, editor.size.width, before.size.width),
        y: before.position.y - placed(work.position.y, work.size.height, editor.position.y, editor.size.height, before.size.height),
      }
      check(Math.abs(offset.x) <= 2 && Math.abs(offset.y) <= 2,
        `插件在文档窗口中央或屏幕可用区域内（偏移 ${offset.x}, ${offset.y}）`)
      const page = plugins.document.querySelector('.yy-tool-page')!.getBoundingClientRect()
      check(page.x === 0 && page.y === 0 && page.width === plugins.innerWidth && page.height === plugins.innerHeight,
        '插件页面填满独立窗口视口')
      placement = { offset, editorMove, pluginMove }
    }
    plugins.close()
    await until(() => plugins.closed)

    const decision = choose('关闭文档', '保留当前窗口的修改。', [{ label: '继续编辑', value: 'cancel', primary: true }])
    const confirmation = opened.at(-1)!
    check(confirmation !== plugins && confirmation.document.querySelector('dialog[open]'), '确认弹窗在独立窗口显示')
    const confirmHeight = confirmation.innerHeight
    button(confirmation.document, '继续编辑').click()
    check(await decision === 'cancel', '子窗口归还确认结果')

    ports.editor.replace(original.length, original.length, draft)
    for (const finish of ['继续编辑', '确认放弃']) {
      const count = opened.length
      const attempt = ports.action({ type: 'reload' })
      await until(() => opened.length === count + 1)
      button(opened[count].document, '放弃更改').click()
      await until(() => opened.length === count + 2)
      check(ports.text() === original + draft, '二次确认前正文仍保留')
      button(opened[count + 1].document, finish).click()
      await attempt
      check(ports.text() === (finish === '确认放弃' ? original : original + draft), '放弃或取消按最终选择执行')
    }

    showUpdate(async () => null)
    const currentUpdate = opened.at(-1)!
    check(currentUpdate !== confirmation, '更新另开原生窗口')
    await until(() => currentUpdate.document.querySelector('.yy-update-status h3')?.textContent === '已是最新版本')
    const updateHeight = currentUpdate.innerHeight
    const dismiss = button(currentUpdate.document, '关闭')
    check(dismiss.getBoundingClientRect().bottom <= updateHeight, '紧凑窗口直接显示关闭按钮')
    await until(async () => (await windows()).some(item => item.title === '软件更新'))
    dismiss.click()
    // WebView 的 Window.closed 可能为真，系统仍显示残留的窗口。
    await until(async () => !(await windows()).some(item => item.title === '软件更新'))
    check(!document.getElementById('app')?.inert, '关闭更新后恢复文档操作')
    check(confirmHeight > 0 && confirmHeight <= 172 && updateHeight > 0 && updateHeight <= 266,
      `短确认及已是最新版本使用紧凑窗口（${confirmHeight}、${updateHeight}）`)

    let firstCheck = true
    showUpdate(async () => {
      if (!firstCheck) return null
      firstCheck = false
      return { version: '9.0.0', notes: '## 验收更新\n\n**Markdown**\n\n' + '发布说明。\n\n'.repeat(30), kind: 'install', async apply() {} }
    })
    const update = opened.at(-1)!
    await until(() => !!update.document.querySelector('.yy-update-notes-body strong') && update.innerHeight > updateHeight)
    const notes = update.document.querySelector('.yy-update-notes-body')!
    check(update.innerHeight <= 495 && notes.scrollHeight > notes.clientHeight, '长发布说明使用可滚动的扩展窗口')
    panelHeights = { confirm: confirmHeight, latest: updateHeight, releaseNotes: update.innerHeight }
    update.document.querySelector<HTMLButtonElement>('.yy-update-sources button[aria-pressed="false"]')!.click()
    await until(() => update.document.querySelector('.yy-update-status h3')?.textContent === '已是最新版本' && update.innerHeight === updateHeight)
    button(update.document, '关闭').click()
    await until(async () => !(await windows()).some(item => item.label.startsWith('panel-')))
    check((await editorWindows()).length === 2 && ports.state.path?.endsWith('验收.md'), '关闭工具窗口保留两个文档窗口')
  } finally {
    window.open = originalOpen
    if (originalFrame) await move(originalFrame.position)
  }
  await testWindowDraft(ports, true)
  return { documents: 2, txt: true, deduplicate: true, undo: true, plugins: true, placement, confirm: true, doubleConfirm: true, update: true, nativePanelClose: true, panelHeights }
}

async function testWindowDraft(ports: Ports, main: boolean) {
  await ports.action({ type: 'autosave', enabled: false })
  const saved = ports.text() + (main ? '\r\n已保存的 Markdown' : '\r\n已保存的 TXT')
  ports.editor.replace(ports.text().length, ports.text().length, saved.slice(ports.text().length))
  check(await ports.saveFile() && (await native.read(ports.state.path!)).text === saved, '各窗口独立保存文件')
  const draft = main ? '\r\n主窗口恢复草稿' : '\r\n第二窗口恢复草稿'
  ports.editor.replace(saved.length, saved.length, draft)
  await ports.action({ type: 'mode', mode: 'source' })
  await ports.checkpoint()
  await mark(main ? 'window-main-draft' : 'window-other-draft', { path: ports.state.path })
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
  const file = document.querySelector<HTMLButtonElement>('[data-menu="file"]')!
  file.click()
  const menu = document.querySelector<HTMLElement>('.yy-menu-popover')!
  const exportMenu = button(menu, '导出为')
  exportMenu.scrollIntoView({ block: 'nearest' })
  const menuHeight = menu.scrollHeight
  exportMenu.click()
  const flyout = document.querySelector<HTMLElement>('.yy-submenu-panel')!
  const parentBox = menu.getBoundingClientRect()
  const flyoutBox = flyout.getBoundingClientRect()
  check(!flyout.hidden && flyout.scrollHeight > 0 && menu.scrollHeight === menuHeight, '导出菜单独立展开')
  check(flyoutBox.left >= parentBox.right - 2 || flyoutBox.right <= parentBox.left + 2, '导出菜单在一级菜单侧边')
  file.click()
  result.menuFlyout = true
  const toolbar = [...document.querySelectorAll<HTMLButtonElement>('.yy-topbar-right .yy-tool-btn')]
  check(toolbar.length === 1 && toolbar[0].dataset.toggle === 'ai', '顶栏保留 AI 快捷入口')
  toolbar[0].click()
  check(toolbar[0].getAttribute('aria-pressed') === 'true', '顶栏可直接打开 AI')
  button(openViewSubmenu('协作侧栏'), 'MCP 工具与连接').click()
  const mcpTab = document.querySelector('[data-right-tab="mcp"]')!
  check(mcpTab.getAttribute('aria-selected') === 'true' && document.activeElement === mcpTab,
    '协作子菜单打开并聚焦 MCP 面板')
  const mcpMenu = button(openViewSubmenu('协作侧栏'), 'MCP 工具与连接')
  check(mcpMenu.getAttribute('aria-checked') === 'true', '菜单勾选当前协作面板')
  mcpMenu.click()
  result.collaborationMenu = true
  const motionOption = () => {
    document.querySelector<HTMLButtonElement>('[data-menu="view"]')!.click()
    return button(document.querySelector('.yy-menu-popover')!, '界面动画')
  }
  const slot = document.querySelector<HTMLElement>('.yy-sidebar-slot-right')!
  const panel = slot.querySelector('aside')!
  const normal = getComputedStyle(panel).transitionDuration
  const motion = motionOption()
  check(motion.getAttribute('aria-checked') === 'true', '界面动画默认开启')
  motion.click()
  await until(() => document.documentElement.dataset.yeyuMotion === 'off')
  await until(() => ports.state.detail === '界面动画已关闭')
  const disabled = getComputedStyle(panel).transitionDuration
  check(disabled.split(',').every(duration => Number.parseFloat(duration) === 0), '关闭时侧栏过渡时间为零')
  const immediate = () => slot.getBoundingClientRect().width
  toolbar[0].click()
  check(immediate() > 0 && !slot.inert, '关闭动效后即时展开侧栏')
  toolbar[0].click()
  check(immediate() === 0 && slot.inert, '关闭动效后即时收起侧栏')
  result.motion = { normal, disabled, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches }
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
  if (scenario.picgo) {
    const url = await invoke<string>('image_upload', { document: scenario.guide, image: image.url, endpoint: scenario.picgo, service: 'picgo' })
    check(url === 'https://example.test/icon.png', 'PicGo 本机上传协议')
    result.picgo = true
  }
  ports.editor.select({ anchor: 0, head: 0 })
  result.shellPalette = await verifyShellPalette(ports)
  await mark('shell-palette', result.shellPalette)
  if (scenario.typora?.length) result.localTypora = await verifyThemeImport(ports, scenario.typora)
  if (scenario.typoraConfig) {
    result.typoraConfig = await verifyTyporaConfig(ports)
    await mark('typora-config', result.typoraConfig)
  }
  const themes: unknown[] = []
  for (const theme of scenario.themes) {
    await ports.addTheme(theme.path)
    const paper = getComputedStyle(document.querySelector<HTMLElement>('.document-theme')!)
    const write = getComputedStyle(document.querySelector<HTMLElement>('#write')!)
    const heading = document.querySelector<HTMLElement>('#write h1')
    // 核对样稿中实际出现的正文，不让另一种字重或语言的字体阻塞后续验收。
    const bodyFont = `${write.fontSize} ${write.fontFamily}`
    const bodyFontReady = await until(() => document.fonts.check(bodyFont, 'The draft is wordy.'), 3_000)
      .then(() => true, () => false)
    themes.push({
      name: theme.name, paper: paper.backgroundColor, color: write.color, font: write.fontFamily,
      bodyFontReady,
      appearance: document.documentElement.dataset.yeyuAppearance,
      nativeTheme: await getCurrentWindow().theme().catch(() => null),
      sidebar: getComputedStyle(document.querySelector('.yy-left-panel')!).backgroundColor,
      embeddedBackground: paper.backgroundImage.includes('data:image/png;base64,'),
      backgroundRepeat: paper.backgroundRepeat,
      heading: heading ? getComputedStyle(heading).color : null,
      faces: [...document.fonts].map(face => ({ name: face.family, weight: face.weight, style: face.style, status: face.status })),
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

  if (scenario.aiFixture) {
    const model = scenario.model ?? { endpoint: scenario.aiFixture + '/chat/v1', name: 'qa-shared' }
    const writing = ports.writing.view
    check(writing.settings.active?.providerId === 'legacy' && writing.settings.active.model === 'qa-shared', '旧单模型配置已迁入供应商目录')
    const body = ports.text().indexOf('The draft is wordy.')
    check(body >= 0, 'AI 选区样本')
    const selected = 'The draft is wordy.'
    ports.editor.select({ anchor: body, head: body + selected.length })
    document.querySelector<HTMLButtonElement>('[data-toggle="ai"]')!.click()
    const panel = document.querySelector('.yy-ai-pane')!
    const openModels = () => {
      button(panel, '模型配置').click()
      return document.querySelector<HTMLFormElement>('form[aria-label="模型配置"]')!
    }
    const closeModels = (page: ParentNode) => page.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click()
    const modelPage = openModels()
    const endpoint = modelPage.querySelector<HTMLInputElement>('input[type="url"]')!
    const name = modelPage.querySelector<HTMLInputElement>('input[aria-label="模型 ID 1"]')!
    setInput(name, model.name)
    setInput(modelPage.querySelector<HTMLInputElement>('[name="provider-name"]')!, '本地 Chat')
    setInput(endpoint, 'https://model.example.invalid/v1#fragment')
    modelPage.requestSubmit()
    await until(() => !modelPage.querySelector<HTMLElement>('[role="alert"]')!.hidden)
    check(modelPage.isConnected && name.value === model.name, '模型配置失败后保留字段')
    setInput(endpoint, model.endpoint)
    button(modelPage, '添加模型').click()
    setInput(modelPage.querySelector<HTMLInputElement>('input[aria-label="模型 ID 2"]')!, 'qa-chat-extra')
    modelPage.requestSubmit()
    await until(() => writing.settings.providers[0]?.name === '本地 Chat')
    check(writing.settings.active?.model === model.name && writing.settings.providers[0].models.length === 2,
      '从配置页保存原供应商的两个模型')
    closeModels(modelPage)

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

    chooseOption(panel, '添加上下文', '当前选区')
    await until(() => ports.writing.view.context?.text === selected)
    check(panel.querySelector('.yy-context-fulltext')?.textContent === selected, '发送前可预览完整选区')
    chooseOption(panel, '写作操作', '改写')
    panel.querySelector<HTMLFormElement>('.yy-ai-composer')!.requestSubmit()
    await until(() => !ports.writing.view.pending, 60_000)
    const proposal = ports.writing.pending
    check(proposal && !writing.error, '模型返回差异：' + writing.error)
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
    await ports.action({ type: 'ai-context-clear' })
    const added = openModels()
    const providers = [
      { protocol: 'anthropic', name: 'Anthropic 夹具', label: 'Anthropic Messages', next: 'qa-claude' },
      { protocol: 'responses', name: 'Responses 夹具', label: 'Responses', next: 'qa-response' },
    ] as const
    for (const provider of providers) {
      button(added, '添加供应商').click()
      setInput(added.querySelector<HTMLInputElement>('[name="provider-name"]')!, provider.name)
      chooseOption(added, 'API 协议', provider.label)
      setInput(added.querySelector<HTMLInputElement>('input[type="url"]')!, `${scenario.aiFixture}/${provider.protocol}/v1`)
      setInput(added.querySelector<HTMLInputElement>('input[aria-label="模型 ID 1"]')!, 'qa-shared')
      button(added, '添加模型').click()
      setInput(added.querySelector<HTMLInputElement>('input[aria-label="模型 ID 2"]')!, provider.next)
      if (provider.protocol === 'responses' && scenario.aiFixtureKey) {
        setInput(added.querySelector<HTMLInputElement>('input[type="password"]')!, scenario.aiFixtureKey)
      }
      added.requestSubmit()
      await until(() => writing.settings.providers.some(item => item.name === provider.name && item.models.length === 2))
    }
    closeModels(added)
    const protocols: AiProtocol[] = ['chat']
    for (const { protocol, name, next } of providers) {
      chooseOption(panel, '切换模型', next, name)
      await until(() => writing.settings.active?.model === next)
      check(!writing.messages.length, '各供应商的会话分开保存')
      await ports.action({ type: 'ai-send', intent: 'chat', prompt: 'Answer in just one short sentence. What is Markdown?' })
      check(!writing.error && writing.messages.at(-1)?.text === `${protocol}·${next}`, '协议流式输出 ' + protocol + ' ' + writing.error)
      protocols.push(protocol)
    }
    if (scenario.aiFixtureKey) {
      check(writing.settings.providers.find(provider => provider.protocol === 'responses')?.hasKey, 'Responses 供应商使用系统凭据')
    }
    const remove = openModels()
    button(remove, '删除供应商').click()
    button(remove, '确认删除').click()
    await until(() => writing.settings.providers.length === 2)
    check(writing.settings.active?.providerId === 'legacy' && writing.messages.at(-1)?.text === answer, '删除当前供应商后恢复可用模型及其会话')
    closeModels(remove)
    chooseOption(panel, '切换模型', 'qa-shared', 'Anthropic 夹具')
    await until(() => writing.settings.active?.providerId !== 'legacy')
    check(writing.settings.active?.model === 'qa-shared' && writing.messages.at(-1)?.text === 'anthropic·qa-claude', '同供应商切换模型保留会话')
    result.ai = { answer, hunks: proposal.view.hunks, undo: true, promptSettings: true, protocols,
      sources: { chat: scenario.model ? 'local-model' : 'fixture', anthropic: 'fixture', responses: 'fixture' },
      migrated: true, catalog: true, active: writing.settings.active, systemCredential: !!scenario.aiFixtureKey }
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
  pluginPage.querySelector<HTMLButtonElement>('[aria-label="返回"]')!.click()
  result.plugins = { install: true, hotUpdate: true, reviewAndUndo: true, disableAndRemove: true }
  if (scenario.market) result.pluginMarket = await verifyPluginMarket(ports, scenario)

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
  await verifyMcpSuggestion(ports, scenario.guide, original.text)
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

async function verifyPluginMarket(ports: Ports, scenario: Case) {
  const { market: source, publicMarket } = scenario
  check(source, '验收配置提供本机市场地址')
  document.querySelector<HTMLButtonElement>('[data-menu="edit"]')!.click()
  button(document.querySelector('.yy-menu-popover')!, '插件市场…').click()
  const dialog = document.querySelector<HTMLElement>('.yy-plugin-manager')!
  const panel = dialog.querySelector<HTMLElement>('.yy-plugin-market')!
  const query = panel.querySelector<HTMLInputElement>('[aria-label="搜索插件"]')!
  const find = (id: string) => panel.querySelector<HTMLButtonElement>(`[data-market-plugin="${id}"]`)
  if (publicMarket) {
    const expectedHost = new URL(publicMarket).host
    const online = () => panel.dataset.marketHost === expectedHost
    const marketStatus = panel.querySelector<HTMLElement>('[role="status"]')!
    await until(() => online() || !!marketStatus.title, 22_000)
    check(online(), '首次打开连接公网目录 ' + marketStatus.title)
    const settings = panel.querySelector<HTMLButtonElement>('[aria-label="市场源"]')!
    settings.click()
    check(panel.querySelector<HTMLInputElement>('input[type="url"]')?.value === publicMarket, '首次打开自动连接公网目录')
    settings.click()
    for (const id of ['yeyu.heading-levels', 'yeyu.spreadsheet-tools', 'yeyu.batch-format', 'yeyu.image-organizer', 'yeyu.table-layout']) {
      find(id)!.click()
      await until(() => find(id)?.textContent === '已安装')
      await ports.action({ type: 'plugin-remove', id })
    }
  }
  button(dialog, '内置插件').click()
  await until(() => !!find('yeyu.heading-levels'))
  const bundledCount = panel.querySelectorAll('.yy-market-card').length
  check(bundledCount === 10 && !!find('yeyu.opencode'), '内置市场包含 OpenCode 和九款文档插件')
  query.value = '任务'
  query.dispatchEvent(new Event('input'))
  check(panel.querySelectorAll('.yy-market-card').length === 1 && !!find('yeyu.task-list'), '按关键词搜索市场')
  query.value = ''
  query.dispatchEvent(new Event('input'))
  for (const id of [
    'yeyu.task-list', 'yeyu.trim-lines', 'yeyu.heading-levels',
    'yeyu.spreadsheet-tools', 'yeyu.chinese-typography', 'yeyu.document-toc',
    'yeyu.batch-format', 'yeyu.image-organizer', 'yeyu.table-layout',
  ]) {
    find(id)!.click()
    await until(() => find(id)?.textContent === '已安装' && !find(id)?.disabled)
  }
  find('yeyu.task-list')!.click()
  button(dialog.querySelector('.yy-plugin-body:not(.yy-plugin-market) [aria-label="任务清单"]')!, '启用').click()
  await until(() => !!button(dialog, '转为任务'))
  const original = ports.text()
  const sample = '\r\n\r\n读样稿\r\n- 看差异\r'
  ports.editor.replace(original.length, original.length, sample)
  ports.editor.select({ anchor: original.length, head: original.length + sample.length })
  button(dialog, '转为任务').click()
  await until(() => ports.writing.pending?.view.source === 'plugin')
  check(ports.text() === original + sample, '从市场安装的插件走差异审阅')
  document.querySelector<HTMLButtonElement>('[data-suggestion-action="apply-all"]')!.click()
  await until(() => ports.text() === original + '\r\n\r\n- [ ] 读样稿\r\n- [ ] 看差异\r')
  ports.editor.undo()
  ports.editor.undo()
  check(ports.text() === original, '市场插件的修改可以撤销')

  document.querySelector<HTMLButtonElement>('[data-menu="edit"]')!.click()
  button(document.querySelector('.yy-menu-popover')!, '插件管理…').click()
  const management = document.querySelector<HTMLElement>('.yy-plugin-manager')!
  const trim = management.querySelector('[aria-label="清理行尾空白"]')!
  button(trim, '启用').click()
  await until(() => !!button(management, '清理行尾空白'))
  for (const [id, name] of [
    ['yeyu.spreadsheet-tools', '表格转换'],
    ['yeyu.chinese-typography', '中文排版'],
    ['yeyu.document-toc', '文档目录'],
    ['yeyu.batch-format', '批量格式化'],
    ['yeyu.image-organizer', '图片整理'],
    ['yeyu.table-layout', '表格排版'],
  ]) {
    button(management.querySelector(`[aria-label="${name}"]`)!, '启用').click()
    await until(() => !!management.querySelector(`[data-plugin="${id}"][data-operation="run"]`))
  }
  button(management, '在线市场').click()
  const market = management.querySelector<HTMLElement>('.yy-plugin-market')!
  const sourceToggle = market.querySelector<HTMLButtonElement>('[aria-label="市场源"]')!
  await until(() => !sourceToggle.disabled)
  sourceToggle.click()
  const form = market.querySelector('form')!
  form.querySelector('input')!.value = source
  form.requestSubmit()
  await until(() => !!button(market, '更新'))
  check((await native.preferences())?.pluginMarketSource === source, '保存市场源地址')
  button(market, '更新').click()
  await until(() => market.querySelector('[role="alert"]')?.textContent?.includes('校验失败') === true && !button(market, '更新')?.disabled)
  const installedTrim = async () => (await invoke<PluginInfo[]>('plugin_list')).find(plugin => plugin.id === 'yeyu.trim-lines')
  check((await installedTrim())?.version === '1.0.0', '校验失败保留当前插件')
  button(market, '更新').click()
  await until(() => !!button(market, '已安装'))
  const updated = await installedTrim()
  check(updated?.version === '1.0.1' && updated.enabled, '市场热更新保留启用状态')
  await ports.action({ type: 'plugin-remove', id: 'yeyu.heading-levels' })
  market.querySelector<HTMLButtonElement>('[aria-label="刷新市场"]')!.click()
  check(market.querySelector('[role="status"]')?.textContent?.includes('正在连接在线市场'), '正在刷新已经配置的在线市场')
  button(management, '内置插件').click()
  const bundled = () => market.querySelector<HTMLButtonElement>('[data-market-plugin="yeyu.heading-levels"]')
  await until(() => bundled()?.textContent === '安装' && !bundled()?.disabled, 3_000)
  bundled()!.click()
  await until(() => bundled()?.textContent === '已安装', 3_000)
  check((await native.preferences())?.pluginMarketSource === source, '内置插件独立于加载中的在线目录，保留自定义源')
  if (publicMarket) {
    sourceToggle.click()
    button(form, '恢复官方市场').click()
    await until(() => market.dataset.marketHost === new URL(publicMarket).host, 22_000)
    check((await native.preferences())?.pluginMarketSource === '', '恢复官方市场清除自定义源')
  }
  management.closest('.yy-tool-page')!.querySelector<HTMLButtonElement>('[aria-label="返回"]')!.click()
  const workflows = await verifyPluginWorkflows(ports)
  const newWorkflows = await verifyDocumentPlugins(ports, scenario)
  return {
    bundled: bundledCount, search: true, installed: true, reviewAndUndo: true, checksum: true,
    hotUpdate: true, bundledDuringOnlineLoad: true, publicMarket: publicMarket ?? null, workflows, newWorkflows,
  }
}

async function verifyPluginWorkflows(ports: Ports) {
  const original = ports.text()
  async function apply(label: string) {
    const before = ports.text()
    document.querySelector<HTMLButtonElement>('[data-menu="edit"]')!.click()
    button(document.querySelector('.yy-menu-popover')!, '运行插件').click()
    button(document.querySelector('.yy-submenu-panel')!, label).click()
    await until(() => ports.writing.pending?.view.title === label)
    check(ports.text() === before, '运行插件后等待用户审阅')
    document.querySelector<HTMLButtonElement>('[data-suggestion-action="apply-all"]')!.click()
    await until(() => !ports.writing.pending)
    check(ports.text() !== before, '从差异视图应用插件修改')
  }

  const csv = '名称,备注\r\n页屿,"中文 | 英文, 兼容"'
  const prefix = '\r\n\r\n'
  const start = original.length + prefix.length
  ports.editor.replace(original.length, original.length, prefix + csv)
  ports.editor.select({ anchor: start, head: start + csv.length })
  await apply('CSV 转 Markdown 表格')
  check(ports.text().endsWith('| 名称 | 备注 |\r\n| --- | --- |\r\n| 页屿 | 中文 \\| 英文, 兼容 |'), 'JavaScript 转换管道符、逗号和中文')
  ports.editor.select({ anchor: start, head: ports.text().length })
  await apply('Markdown 表格转 CSV')
  check(ports.text() === original + prefix + csv, 'Markdown 表格导回 CSV')
  ports.editor.undo()
  ports.editor.undo()
  ports.editor.undo()
  check(ports.text() === original, 'JavaScript 插件应用可撤销')

  const tip = '\r\n\r\n同步API文档，共50行。代码 `版本V1`。\r\n'
  ports.editor.replace(original.length, original.length, tip)
  ports.editor.select({ anchor: 0, head: 0 })
  await apply('整理中英文与数字间距')
  check(ports.text().endsWith(tip.replace('API', ' API ').replace('50', ' 50 ')), 'Rust 中文排版在无选区时处理全文并保留代码')
  ports.editor.undo()
  ports.editor.undo()
  check(ports.text() === original, 'Rust 中文排版可撤销')

  const sample = '# 使用手册\r\n\r\n[TOC]\r\n\r\n## 安装\r\n### 测试 API\r\n## 安装\r\n'
  ports.editor.replace(0, original.length, sample)
  ports.editor.select({ anchor: 0, head: 0 })
  await apply('生成或更新目录')
  const toc = ports.text()
  check(toc.includes('- [安装](#安装)\r\n  - [测试 API](#测试-api)\r\n- [安装](#安装-2)'), 'Rust 目录生成层级及重复标题锚点')
  await ports.action({ type: 'mode', mode: 'live' })
  ports.editor.select({ anchor: 0, head: 0 })
  await until(() => !!document.querySelector('[data-markdown-url="#安装-2"]'))
  document.querySelector('[data-markdown-url="#安装-2"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true, ctrlKey: true }))
  check(ports.editor.getSelection().head === toc.lastIndexOf('## 安装'), '实时模式跳转到重复标题')
  await apply('移除生成的目录')
  check(!ports.text().includes('yeyu-toc-begin') && ports.text().startsWith('# 使用手册') &&
    ports.text().endsWith('## 安装\r\n### 测试 API\r\n## 安装\r\n'), '移除目录保留文档标题与正文')
  ports.editor.undo()
  ports.editor.undo()
  ports.editor.undo()
  check(ports.text() === original, 'Rust 目录操作可撤销')
  return { javascript: '表格转换', rust: ['中文排版', '文档目录'], reviewAndUndo: true, anchorJump: true }
}

async function verifyDocumentPlugins(ports: Ports, scenario: Case) {
  function runMenu(label: string) {
    document.querySelector<HTMLButtonElement>('[data-menu="edit"]')!.click()
    button(document.querySelector('.yy-menu-popover')!, '运行插件').click()
    button(document.querySelector('.yy-submenu-panel')!, label).click()
  }
  await ports.openPath(scenario.gallery, 1, false)
  const gallery = ports.text()
  const formatter = (text: string) => invoke<string>('plugin_run', { id: 'yeyu.batch-format', command: 'format_files', text })
  const before = await Promise.all(scenario.batchPaths.map(path => native.read(path)))
  await ports.openPath(before[0].path, 1, false)
  const formatting = ports.formatFiles(scenario.batchPaths, formatter)
  const review = (name: string) => document.querySelector<HTMLDialogElement>(`.app-review-dialog[open][aria-label="${name}"]`)
  await until(() => !!review('批量格式化'))
  const batch = review('批量格式化')!
  check(batch.querySelectorAll('input[type="checkbox"]').length === 3, '批量预览三个文件')
  check(!!batch.querySelector('.app-review-add') && (await native.read(before[0].path)).version === before[0].version, '预览期间不写入')
  button(batch, before[1].name).click()
  check(batch.querySelector('.app-review-preview')?.textContent?.includes('第 2 章'), '逐篇显示差异')
  batch.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].click()
  const external = await native.write(before[2].path, '外部改动\n', true, before[2].version)
  button(batch, '保存所选文件').click()
  await until(() => document.querySelector('.app-dialog[open] h2')?.textContent === '批量格式化结果')
  check(document.querySelector('.app-dialog[open] p')?.textContent?.includes('磁盘上的文件已变化'), '批量格式化报告外部冲突')
  button(document.querySelector('.app-dialog[open]')!, '关闭').click()
  await formatting
  const after = await Promise.all(before.map(item => native.read(item.path)))
  check(after[0].bom && after[0].text === before[0].text.replace('章\r\n', '章\r\n\r\n') && ports.text() === after[0].text,
    '保存所选文件且当前编辑器同步，保留 BOM 和混合行尾')
  check(after[1].version === before[1].version && after[2].version === external.version, '未勾选文件和外部修改得到保留')

  await ports.openPath(scenario.gallery, 1, false)
  const scans = await invoke<Array<{ Ok: { digest: string } }>>('image_fingerprints', { document: scenario.gallery, images: ['源 图.png'] })
  const relative = '图库.assets/image-' + scans[0].Ok.digest.slice(0, 20) + '.png'
  runMenu('收拢本文本地图片…')
  await until(() => !!review('图片整理'))
  const picture = review('图片整理')!
  check(picture.textContent?.includes('1 张图片') && picture.textContent.includes('2 处链接') &&
    picture.textContent.includes('missing.png'), '图片去重计划和缺失提示')
  const targetBefore = await invoke<Array<{ Err?: string }>>('image_fingerprints', { document: scenario.gallery, images: [relative] })
  check(!!targetBefore[0].Err && ports.text() === gallery, '图片预览未复制文件或更改文档')
  button(picture, '取消').click()
  await until(() => ports.state.detail === '已取消图片整理')
  runMenu('收拢本文本地图片…')
  await until(() => !!review('图片整理'))
  button(review('图片整理')!, '复制并更新链接').click()
  await until(() => ports.state.detail.includes('已更新 2 处图片链接'))
  const name = '%E5%9B%BE%E5%BA%93.assets/image-' + scans[0].Ok.digest.slice(0, 20) + '.png'
  check(ports.text() === gallery.replace('<源 图.png>', name).replace('![重复](copy.png)', '![重复](' + name + ')'),
    '图片整理保留标题、远程链接、代码和原有行尾')
  const organized = ports.text()
  ports.editor.undo()
  check(ports.text() === gallery, '图片链接更新可以撤销')
  ports.editor.redo()
  check(ports.text() === organized && await ports.saveFile(), '图片链接可以重做和保存')
  runMenu('收拢本文本地图片…')
  await until(() => document.querySelector('.app-dialog[open] h2')?.textContent === '图片整理结果')
  check(document.querySelector('.app-dialog[open] p')?.textContent?.startsWith('没有需要更新的本地图片链接'), '再次整理不重复复制')
  button(document.querySelector('.app-dialog[open]')!, '关闭').click()
  await until(() => !document.querySelector('.app-dialog[open]'))
  await frame()

  const sample = '\r\n\r\n|名称|状态|\r\n|:-|--:|\r\n|长的标题|a\\|b|\r\n'
  ports.editor.replace(organized.length, organized.length, sample)
  runMenu('对齐 Markdown 表格')
  await until(() => ports.writing.pending?.view.title === '对齐 Markdown 表格')
  document.querySelector<HTMLButtonElement>('[data-suggestion-action="apply-all"]')!.click()
  await until(() => ports.text().includes('| 长的标题 | a\\|b  |'))
  ports.editor.undo()
  ports.editor.undo()
  check(ports.text() === organized, '表格排版可撤销')
  await ports.openPath(scenario.guide, 1, false)
  return { batchFormat: true, bom: true, diskConflict: true, imageDeduplication: true, cancel: true, tableLayout: true }
}

export async function runNativeQa(ports: Ports) {
  try {
    const scenario = await config()
    const main = getCurrentWindow().label === 'main'
    if (scenario.phase === 'recover-windows') {
      const expected = main ? '主窗口恢复草稿' : '第二窗口恢复草稿'
      check(ports.state.path?.endsWith(main ? '验收.md' : '纯文本.txt') &&
        ports.text().endsWith(expected) && ports.state.dirty && ports.state.mode === 'source', '各窗口恢复自己的草稿和源码模式')
      await mark(main ? 'window-main-recovered' : 'window-other-recovered', { path: ports.state.path })
      return
    }
    if (!main) {
      if (scenario.phase === 'windows' && ports.state.path?.endsWith('纯文本.txt')) await testWindowDraft(ports, false)
      return
    }
    // 后台文档窗口的动画帧可能暂停。读写与恢复验收只等待已载入的数据。
    if (scenario.phase !== 'windows') await frame()
    if (scenario.phase === 'measure') await measure(ports, scenario)
    else if (scenario.phase === 'titlebar') await mark('titlebar', await verifyTitlebarResize())
    else if (scenario.phase === 'opencode') {
      await verifyOpenCode(ports, scenario)
      await mark('opencode', { reviewed: true })
    }
    else if (scenario.phase === 'windows') await mark('windows', await verifyWindows(ports, scenario))
    else if (scenario.phase === 'recover') {
      check(ports.text() === scenario.recoveryText && ports.state.dirty && ports.state.mode === 'source', '强制结束后恢复内容和源码模式')
      check((await native.preferences())?.animations === false && document.documentElement.dataset.yeyuMotion === 'off', '重启保留动画开关')
      if (scenario.activeModel) {
        const { providers, active } = ports.writing.view.settings
        check(active?.providerId === scenario.activeModel.providerId && active.model === scenario.activeModel.model &&
          providers.length === 2 && providers.every(provider => provider.models.length === 2), '重启保留供应商、多个模型和当前选择')
      }
      await mark('recovery', { recovered: true, mode: ports.state.mode, dirty: ports.state.dirty,
        motionPersisted: true, aiSelectionPersisted: !!scenario.activeModel })
    } else await verifyFull(ports, scenario)
  } catch (error) {
    await mark('failure', { error: reason(error), stack: error instanceof Error ? error.stack : '' })
  }
}
