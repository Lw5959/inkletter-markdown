import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { dirname, join } from '@tauri-apps/api/path'
import type { Editor, ExportFormat, ImageMode, MarketPlugin, OutlineEntry, PluginCatalog, PluginInfo, ShellAction, ShellState, Theme, TitlebarMaterial, TitlebarView, WorkspaceEntry } from './contracts'
import { createEditor, renderMarkdown } from './editor'
import { mountShell } from './ui'
import { detectMac } from './ui/shortcuts'
import { ask, invoke, native, open, reason, save } from './native'
import type { FileSnapshot, Preferences, Recovery } from './native'
import { choose, readSetting, reviewChanges } from './dialogs'
import { find, interval, lineOffset } from './document-tools'
import { exportHtml, formatExtensions, print, visual } from './export'
import { assetPath, imageLinks, insertImages, localImage, planImageCollection, resolveImage } from './images'
import type { Relocated } from './images'
import { importTheme } from './themes'
import { builtinThemes } from './builtin-themes'
import { readTyporaProfiles, typoraThemeKey } from './typora'
import { Writing } from './ai'
import { normalizePrompts } from './ai-prompts'
import { Protocol } from './mcp'
import { bind, chooseHunks, relocate, suggestion } from './suggestions'

const markdownFilter = { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdwn', 'mdtxt', 'mdtext', 'text', 'txt', 'rmd', 'qmd', 'mdx'] }
const imageFilter = { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'tiff', 'heic', 'ico'] }
const officialPluginMarket = 'https://lw5959.github.io/yeyu-plugin-market/index.json'
const defaults: Preferences = {
  autosave: true, animations: true, theme: 'default', typoraThemes: {}, workspace: null, mcp: [],
  hidden: false, allFiles: false, fileGlob: '', zoom: 1, remoteImages: false, uploadEndpoint: '', recent: [],
  aiPrompts: {},
  titlebarMaterial: 'liquid',
  pluginMarketSource: '',
  uploadService: 'multipart', autosaveDelay: 1_100, spellcheck: true,
  findOptions: { matchCase: false, wholeWord: false },
}

let settings: Preferences = { ...defaults }
let file: FileSnapshot | null = null
let recoveryBase: Recovery | null = null
let documentId = 0
let revision = 0
let cachedRevision = -1
let cachedText = ''
let themes: Theme[] = [...builtinThemes]
let typoraThemePaths: string[] = []
let lastExport: ExportFormat | null = null
let diskConflict: string | null | undefined
let saving: Promise<boolean> | null = null
let switching = false
let opening = false
let importingThemes = false
let themeSelection = 0
let loaded = false
let checkpointTimer = 0
let autoSaveTimer = 0
let statsTimer = 0
let statsTask = 0
let workspaceSearch = 0
let recoveryQueue = Promise.resolve()
let preferenceQueue = Promise.resolve()
let checking = false
let exits = false
let outlineKey = ''
let outline: OutlineEntry[] = []
let plugins: PluginInfo[] = []
let runningPluginTools = false
let statsDoc = -1
let statsBusy = false
let statsPending = false
let stagedImageMoves = new Set<string>()
const images = new Map<string, Promise<string>>()
const state: ShellState = {
  title: '未命名.md', path: null, dirty: false, mode: 'live', detail: '',
  words: 0, characters: 0, line: 1, column: 1, workspace: null, autosave: defaults.autosave,
  animations: false,
  presentation: { focus: false, typewriter: false, spellcheck: true },
}
const macTitlebar = detectMac()
const shell = mountShell(document.querySelector<HTMLElement>('#app')!, {
  dispatch: act,
  pluginMarket: {
    official: officialPluginMarket,
    source: pluginMarketSource,
    bundled: () => invoke<PluginCatalog>('plugin_market_list', { source: null, refresh: false }),
    load: loadPluginMarket,
    install: installMarketPlugin,
  },
  macTitlebar,
  onWindowAppearance: appearance => {
    void getCurrentWindow().setTheme(appearance).catch(error => console.error('窗口外观切换失败', error))
  },
})
const writing = new Writing(view => shell.setAI(view))
const protocol = new Protocol(view => shell.setMcp(view))
const stats = new Worker(new URL('./stats.worker.ts', import.meta.url), { type: 'module' })
const editor: Editor = createEditor(shell.editorHost, {
  onChange,
  onSelectionChange: () => {
    if (!statsTimer && !switching) statsTimer = window.setTimeout(updateCounters, 280)
  },
  onAssetPaste: async file => { await act({ type: 'image-import', files: [file] }) },
  resolveImage: renderedImage,
  onOpenLink: url => { void visit(url).catch(error => update(reason(error))) },
})
editor.setPresentation(state.presentation)
shell.setState(state)
editor.focus()

stats.onmessage = ({ data }: MessageEvent<{ task: number; doc: number; words: number; characters: number; line: number; column: number; outline?: OutlineEntry[] }>) => {
  if (data.outline) {
    statsBusy = false
    if (data.doc === revision) {
      outline = data.outline
      const key = JSON.stringify(outline)
      if (key !== outlineKey) { outlineKey = key; shell.setOutline(outline) }
    }
    if (statsPending) updateCounters()
    return
  }
  if (data.task !== statsTask || data.doc !== revision) return
  state.words = data.words
  state.characters = data.characters
  state.line = data.line
  state.column = data.column
  shell.setState(state)
}


function update(detail?: string) {
  if (detail !== undefined) state.detail = detail
  shell.setState(state)
}

function text() {
  if (cachedRevision !== revision) {
    cachedText = editor.getMarkdown()
    cachedRevision = revision
  }
  return cachedText
}

function onChange() {
  if (switching) return
  revision++
  if (!state.dirty) {
    state.dirty = true
    update('未保存')
  }
  window.clearTimeout(checkpointTimer)
  checkpointTimer = window.setTimeout(() => { void checkpoint() }, 380)
  scheduleAutosave()
  if (!statsTimer) statsTimer = window.setTimeout(updateCounters, 280)
}

function updateCounters() {
  statsTimer = 0
  if (switching) return
  if (statsBusy) { statsPending = true; return }
  statsPending = false
  const next = statsDoc !== revision
  statsBusy = next
  statsDoc = revision
  stats.postMessage({ task: ++statsTask, doc: revision, text: next ? text() : undefined, offset: editor.getSelection().head })
}

function scheduleAutosave() {
  window.clearTimeout(autoSaveTimer)
  if (state.autosave && state.path && state.dirty && diskConflict === undefined) {
    autoSaveTimer = window.setTimeout(() => {
      if (!switching && diskConflict === undefined && state.dirty) {
        void saveFile(false, true).catch(error => update('自动保存失败：' + reason(error)))
      }
    }, settings.autosaveDelay)
  }
}

function checkpoint() {
  window.clearTimeout(checkpointTimer)
  const current = text()
  const saved = file?.text ?? ''
  const dirty = state.dirty && (current !== saved || !!recoveryBase)
  if (state.dirty !== dirty) {
    state.dirty = dirty
    update('已恢复到保存版本')
  }
  const draft = dirty ? {
    path: state.path, text: current, title: state.title, bom: file?.bom ?? recoveryBase?.bom ?? false,
    baseVersion: file?.version ?? recoveryBase?.baseVersion ?? null, mode: state.mode, ...editor.getSelection(),
  } : null
  recoveryQueue = recoveryQueue.catch(() => {}).then(() => native.checkpoint(draft))
  return recoveryQueue.catch(error => update('恢复草稿写入失败：' + reason(error)))
}

function persist() {
  const snapshot = { ...settings }
  preferenceQueue = preferenceQueue.catch(() => {}).then(() => native.persist(snapshot))
  return preferenceQueue
}

function setDocument(value: FileSnapshot | null, draft: Recovery | null = null) {
  switching = true
  window.clearTimeout(checkpointTimer)
  window.clearTimeout(autoSaveTimer)
  window.clearTimeout(statsTimer)
  documentId++
  revision++
  file = value
  outline = []
  outlineKey = ''
  shell.setOutline([])
  recoveryBase = draft
  diskConflict = draft?.path && (value?.version ?? null) !== draft.baseVersion ? value?.version ?? null : undefined
  stagedImageMoves = new Set()
  state.path = draft?.path ?? value?.path ?? null
  state.title = draft?.title ?? value?.name ?? '未命名.md'
  state.dirty = !!draft
  state.presentation.readonly = false
  editor.setPresentation(state.presentation)
  state.mode = draft?.mode ?? state.mode
  images.clear()
  editor.setMarkdown(draft?.text ?? value?.text ?? '')
  editor.setMode(state.mode)
  if (draft) {
    const length = draft.text.length
    editor.select({ anchor: Math.min(draft.anchor, length), head: Math.min(draft.head, length) })
  }
  switching = false
  writing.clearContext()
  writing.review(null)
  update(draft ? '已恢复未保存草稿' : value ? '已打开' : '新文档')
  updateCounters()
  editor.focus()
}

async function canLeave() {
  if (saving) await saving
  if (!state.dirty || (!recoveryBase && text() === (file?.text ?? ''))) return true
  const option = await choose('未保存的编辑', '离开“' + state.title + '”前保存编辑。', [
    { value: 'cancel', label: '继续编辑' }, { value: 'discard', label: '放弃更改' },
    { value: 'save', label: '保存', primary: true },
  ])
  return option === 'discard' || (option === 'save' && await saveFile())
}

async function openPath(path: string, line = 1, checkUnsaved = true) {
  if (switching) return false
  if (path === file?.path && checkUnsaved) {
    const from = lineOffset(text(), line)
    editor.select({ anchor: from, head: from })
    editor.focus()
    return true
  }
  if (opening) return false
  opening = true
  try {
    if (checkUnsaved && !await canLeave()) return false
    const started = revision
    const value = await native.read(path)
    if (checkUnsaved && started !== revision && !await canLeave()) return false
    setDocument(value)
    const offset = lineOffset(value.text, line)
    editor.select({ anchor: offset, head: offset })
    await checkpoint()
    settings.recent = [value.path, ...settings.recent.filter(item => item !== value.path)].slice(0, 24)
    await persist()
    return true
  } finally { opening = false }
}

async function saveFile(as = false, silently = false): Promise<boolean> {
  if (saving) return saving
  const initial = revision
  const attempt = writeFile(as, silently)
  saving = attempt
  try {
    return await attempt
  } finally {
    saving = null
    if (state.dirty && diskConflict === undefined && revision !== initial) scheduleAutosave()
  }
}

async function writeFile(as: boolean, silently: boolean) {
  const id = documentId
  const oldPath = state.path
  let path = oldPath
  let expected = file?.version ?? recoveryBase?.baseVersion ?? null
  if (as || !path) {
    if (silently) return false
    path = await save({ defaultPath: oldPath ?? state.title, filters: [markdownFilter] })
    if (!path || id !== documentId) return false
    if (path !== oldPath) expected = await native.version(path)
  }
  const current = text()
  const bom = file?.bom ?? recoveryBase?.bom ?? false
  if (diskConflict !== undefined && path === oldPath) {
    if (silently) return false
    return resolveConflict(path, current, bom)
  }
  try {
    const saved = await native.write(path, current, bom, expected)
    await afterSave(saved, id, current)
    return true
  } catch (error) {
    if ((error as { kind?: string })?.kind !== 'conflict') throw error
    if (path !== oldPath) {
      update('目标文件已被修改，请重新选择保存位置')
      return false
    }
    diskConflict = await native.version(path)
    update('磁盘文件有变化，保存时可处理冲突')
    if (!silently) return resolveConflict(path, current, bom)
    return false
  }
}

async function resolveConflict(path: string, current: string, bom: boolean) {
  const id = documentId
  const previousVersion = await native.version(path)
  const selected = await choose('磁盘文件有变化', path, [
    { value: 'cancel', label: '继续编辑' }, { value: 'reload', label: '载入磁盘' },
    { value: 'copy', label: '另存副本', primary: true }, { value: 'overwrite', label: '覆盖磁盘' },
  ])
  if (id !== documentId) return false
  if (selected === 'reload' && previousVersion !== null) {
    await openPath(path, 1, false)
    return true
  }
  if (selected === 'copy') {
    const copy = await save({ defaultPath: state.title.replace(/\.[^.]+$/, '') + '-副本.md', filters: [markdownFilter] })
    if (!copy || copy === path) return false
    await afterSave(await native.write(copy, current, bom, await native.version(copy)), id, current)
    return true
  }
  if (selected === 'overwrite') {
    await afterSave(await native.write(path, current, bom, previousVersion), id, current)
    return true
  }
  return false
}

async function afterSave(saved: FileSnapshot, id: number, content: string) {
  if (id !== documentId) return
  if (state.path !== saved.path) {
    images.clear()
    stagedImageMoves.clear()
  }
  file = saved
  recoveryBase = null
  diskConflict = undefined
  state.path = saved.path
  state.title = saved.name
  state.dirty = text() !== content
  update('已保存')
  await checkpoint()
  if (stagedImageMoves.size && !state.dirty) {
    // 等到文档引用已持久化才移动原图，防止保存失败留下失效链接。
    const references = imageLinks(content).map(link => localImage(link.url)).filter(link => link !== null)
    const paths = [...stagedImageMoves]
    stagedImageMoves.clear()
    if (paths.length) await invoke('image_remove', { paths, references, document: saved.path })
  }
  if (state.workspace) await refreshTree()
}

async function refreshTree(preferences = settings) {
  const root = state.workspace
  if (!root) {
    shell.setWorkspace([])
    return
  }
  const entries = await invoke<WorkspaceEntry[]>('workspace_tree', {
    root, hidden: preferences.hidden, all: preferences.allFiles, filter: preferences.fileGlob || null,
  })
  if (root === state.workspace) shell.setWorkspace(entries)
}

async function setWorkspace(path: string | null) {
  if (protocol.view.workspaceAllowed) await protocol.current(null)
  path = path ? await invoke<string>('workspace_root', { root: path }) : null
  state.workspace = settings.workspace = path
  shell.setSearchResults([])
  await Promise.all([refreshTree(), protocol.workspace(path), persist()])
  update(path ? '已打开工作区' : '')
}

function renderedImage(url: string) {
  let image = images.get(url)
  if (!image) {
    image = resolveImage(state.path, url, settings.remoteImages)
    images.set(url, image)
  }
  return image
}

async function visit(url: string) {
  if (url.startsWith('#')) {
    const id = decodeURIComponent(url.slice(1))
    const heading = outline.find(entry => entry.id === id) ?? editor.getOutline().find(entry => entry.id === id)
    if (heading) editor.select({ anchor: heading.from, head: heading.from })
    return
  }
  if (/^(https?:|mailto:)/i.test(url)) {
    await invoke('visit_link', { url })
    return
  }
  const [relative, anchor] = url.split('#', 2)
  const path = localImage(relative)
  if (state.path && path && /\.(?:md|markdown|txt|mdown|mdx|qmd|rmd)$/i.test(path)) {
    const absolute = /^[/\\]|^[a-z]:[/\\]/i.test(path) ? path : await join(await dirname(state.path), path)
    if (await openPath(absolute) && anchor) await visit('#' + anchor)
  }
}

async function addImages(files?: File[]) {
  if (state.presentation.readonly) throw new Error('请先关闭只读模式')
  const range = interval(editor.getSelection())
  const target = bind(documentId, revision, text(), range)
  if (!state.path && !await saveFile()) return
  if (!state.path) return
  if (!files?.length) {
    const paths = await open({ multiple: true, filters: [imageFilter] })
    if (paths?.length) await addImagePaths(paths, target)
    return
  }
  const links = await insertImages(state.path, files)
  const location = relocate(target, documentId, revision, text())
  if (!location) throw new Error('原来的插入位置已改变，请重新选择')
  if (links.length) {
    editor.replace(location.from, location.to, links.join('\n'))
    editor.focus()
    update('已插入图片')
  }
}

async function addImagePaths(paths: string[], target = bind(documentId, revision, text(), interval(editor.getSelection()))) {
  if (state.presentation.readonly) throw new Error('请先关闭只读模式')
  if (!state.path && !await saveFile()) return
  const document = state.path
  if (!document) return
  const copied = await Promise.all(paths.map(image => invoke<Relocated>('image_copy', { document, image })))
  const location = relocate(target, documentId, revision, text())
  if (!location) throw new Error('原来的插入位置已改变，请重新选择')
  editor.replace(location.from, location.to, copied.map(item => '![](' + assetPath(item.path) + ')').join('\n'))
  editor.focus()
  update('已插入图片')
}

async function manageImages(mode: ImageMode) {
  if (state.presentation.readonly) throw new Error('请先关闭只读模式')
  const document = state.path
  if (!document) throw new Error('请先保存文档')
  const id = documentId
  const version = revision
  const content = text()
  const links = imageLinks(content).filter(link => localImage(link.url) !== null)
  if (!links.length) throw new Error('文档中没有可处理的本地图片')
  let endpoint = settings.uploadEndpoint
  if (mode === 'upload') {
    const description = settings.uploadService === 'picgo'
      ? '将文档引用的本地图片交给 PicGo 或 PicList。请先打开图床应用并启用本机上传服务。'
      : '将文档引用的本地图片上传到指定接口。接口需接收名为 file 的字段并返回 url。'
    const value = await readSetting('上传图片', description, endpoint)
    if (!value) return
    if (settings.uploadService === 'picgo' && value !== endpoint) {
      const target = new URL(value)
      if (!['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname) || target.pathname !== '/upload') settings.uploadService = 'multipart'
    }
    settings.uploadEndpoint = endpoint = value
    await persist()
  }
  if (mode === 'move' && !await ask('保存文档后会把原图移入废纸篓。其他文档引用相同图片时可能需要更新路径。继续？')) return
  const replacements: string[] = []
  const originals: string[] = []
  for (const link of links) {
    const image = localImage(link.url)!
    if (mode === 'upload') replacements.push(await invoke<string>('image_upload', { document, image, endpoint, service: settings.uploadService }))
    else {
      const result = await invoke<Relocated>('image_copy', { document, image })
      replacements.push(assetPath(result.path))
      if (mode === 'move' && result.original) originals.push(result.original)
    }
  }
  if (id !== documentId || version !== revision) throw new Error('文档已变化，图片链接请重新处理')
  let start = 0
  const parts: string[] = []
  for (const [index, link] of links.entries()) {
    parts.push(content.slice(start, link.from), replacements[index])
    start = link.to
  }
  parts.push(content.slice(start))
  editor.replace(0, content.length, parts.join(''))
  for (const original of originals) stagedImageMoves.add(original)
  update(mode === 'upload' ? '图片已上传，保存后写入新链接' : '图片路径已更新')
}

type PluginRunner = (input: string) => Promise<string>

async function pluginIssues(title: string, detail: string, issues: string[]) {
  await choose(title, [detail, ...issues].join('\n'), [{ value: 'ok', label: '关闭', primary: true, autofocus: true }])
}

async function formatFiles(paths: string[], run: PluginRunner) {
  const changes: Array<FileSnapshot & { replacement: string }> = []
  const issues: string[] = []
  const parsed = new Set<string>()
  let same = 0
  update(`正在预览 ${paths.length} 份文档`)
  for (const path of paths) {
    try {
      const value = await native.read(path)
      if (parsed.has(value.path)) continue
      parsed.add(value.path)
      if (!markdownFilter.extensions.includes(value.name.split('.').at(-1)?.toLowerCase() ?? '')) {
        throw new Error('请选择 Markdown 文档')
      }
      if (value.path === state.path && (state.dirty || saving)) throw new Error('请先保存当前文档')
      const replacement = await run(value.text)
      if (value.text === replacement) same++
      else changes.push({ ...value, replacement })
    } catch (error) {
      issues.push(path + ' · ' + reason(error))
    }
  }
  if (!changes.length) {
    const detail = `没有需要写回的文档，${same} 份已符合格式`
    update(detail)
    if (issues.length) await pluginIssues('批量格式化结果', detail, issues)
    return
  }
  const selected = await reviewChanges('批量格式化',
    `${changes.length} 份有更改，${same} 份已符合格式。确认后将写回勾选的文件。`,
    changes, '保存所选文件', true, issues)
  if (!selected.size) { update('已取消批量格式化'); return }
  let written = 0
  const conflicts: string[] = []
  for (const entry of changes) {
    if (!selected.has(entry.path)) continue
    try {
      if (state.presentation.readonly) throw new Error('请先关闭只读模式')
      const active = entry.path === state.path
      if (active && (state.dirty || saving || file?.version !== entry.version)) throw new Error('当前文档已变化，请重新预览')
      const id = documentId
      const initial = revision
      // 每份文档沿用普通保存的版本检查、BOM 和原子写入。
      const saved = await native.write(entry.path, entry.replacement, entry.bom, entry.version)
      written++
      if (active && id === documentId && initial === revision) {
        file = saved
        editor.replace(0, entry.text.length, entry.replacement)
        await afterSave(saved, id, entry.replacement)
      }
    } catch (error) {
      conflicts.push(entry.path + ' · ' + reason(error))
    }
  }
  const detail = `已保存 ${written} 份文档${conflicts.length ? `，${conflicts.length} 项需查看` : ''}`
  update(detail)
  if (conflicts.length) await pluginIssues('批量格式化结果', detail, conflicts)
}

async function organizeImages(run: PluginRunner) {
  const current = file
  if (!current) throw new Error('请先保存文档')
  const id = documentId
  const version = revision
  const original = text()
  const stillCurrent = () => id === documentId && version === revision && current.path === state.path
  update('正在检查本文引用的本地图片')
  const plan = await planImageCollection(current, original, run)
  if (!stillCurrent()) throw new Error('文档已变化，请重新预览')
  if (!plan.updatedLinks) {
    const detail = '没有需要更新的本地图片链接'
    update(detail)
    if (plan.issues.length) await pluginIssues('图片整理结果', detail, plan.issues)
    return
  }
  const selected = await reviewChanges('图片整理',
    `将 ${plan.count} 张图片归集到 ${plan.folder}，并更新 ${plan.updatedLinks} 处链接。`,
    [{ ...current, text: original, replacement: plan.replacement }], '复制并更新链接', false, plan.issues)
  if (!selected.size) { update('已取消图片整理'); return }
  if (!stillCurrent() || state.presentation.readonly) throw new Error('文档已变化或处于只读模式，请重新预览')
  await invoke('image_collect', { document: current.path, copies: plan.copies })
  if (!stillCurrent() || state.presentation.readonly) throw new Error('图片已归集，文档已变化，请重新生成链接')
  editor.replace(0, original.length, plan.replacement)
  editor.focus()
  update(`已更新 ${plan.updatedLinks} 处图片链接，可撤销`)
}

async function performExport(format: ExportFormat) {
  const extension = formatExtensions[format]
  const path = await save({ defaultPath: state.title.replace(/\.[^.]+$/, '') + '.' + extension, filters: [{ name: format, extensions: [extension] }] })
  if (!path) return
  await exportTo(path, format)
}

async function exportTo(path: string, format: ExportFormat) {
  update('正在导出 ' + format.toUpperCase())
  const source = state.path
  const content = text()
  if (visual.has(format)) {
    const active = themes.find(theme => theme.id === settings.theme)
    const html = await exportHtml(content, state.title, { resolveImage: url => resolveImage(source, url, false) }, active, format === 'plain-html', shell.getAppearance())
    await invoke('export_document', { path, html, format })
  } else await invoke('pandoc_export', { path, text: content, format, source })
  lastExport = format
  update('已导出 ' + format.toUpperCase())
}

async function reviewMcp() {
  const proposal = protocol.proposals[0]
  if (!proposal) return
  if (file?.path !== proposal.path && !await openPath(proposal.path)) return
  if (file?.version !== proposal.version) {
    if (await choose('建议引用的版本已变化', '请让 MCP 客户端重新读取后提交建议。', [
      { value: 'keep', label: '保留建议' }, { value: 'dismiss', label: '移除此建议', primary: true },
    ]) === 'dismiss') await protocol.resolve(proposal.id)
    return
  }
  const baseRevision = text() === file.text ? revision : -1
  const target = bind(documentId, baseRevision, file.text, { from: proposal.from, to: proposal.to })
  const item = suggestion('mcp', proposal.summary || 'MCP 修改建议', target, proposal.replacement, proposal.id)
  if (!item.view.hunks) {
    await protocol.resolve(proposal.id)
    update('建议与文档一致')
    return
  }
  writing.review(item)
}

async function act(action: ShellAction) {
  if (!loaded) return '正在载入应用，请稍后重试'
  try {
    await dispatch(action)
  } catch (error) {
    const detail = reason(error)
    update(detail)
    return detail
  }
}

function setPlugins(entries: PluginInfo[]) {
  plugins = entries
  shell.setPlugins(entries)
}

async function installPlugin(path: string) {
  const entries = await invoke<PluginInfo[]>('plugin_install', { path })
  setPlugins(entries)
  return entries
}

function pluginMarketSource() {
  return settings.pluginMarketSource.trim() || officialPluginMarket
}

async function loadPluginMarket(source?: string, refresh = false) {
  if (!loaded) throw new Error('正在载入应用，请稍后重试')
  const url = source?.trim() || pluginMarketSource()
  const catalog = await invoke<PluginCatalog>('plugin_market_list', {
    source: url, refresh,
  })
  if (source !== undefined) {
    const previous = settings.pluginMarketSource
    settings.pluginMarketSource = catalog.source === officialPluginMarket ? '' : catalog.source ?? ''
    try {
      await persist()
    } catch (error) {
      settings.pluginMarketSource = previous
      throw error
    }
  }
  return catalog
}

async function installMarketPlugin(source: string | null, plugin: MarketPlugin) {
  const result = await invoke<{ installed: PluginInfo[]; catalog: PluginCatalog }>('plugin_market_install', {
    source, id: plugin.id, sha256: plugin.sha256,
  })
  setPlugins(result.installed)
  update(plugin.availability === 'update' ? '已更新 ' + plugin.name : '已安装 ' + plugin.name)
  return result.catalog
}

async function applyTitlebar(material: TitlebarMaterial) {
  const view = await invoke<TitlebarView>('titlebar_apply', { material })
  shell.setTitlebar(view)
}

async function dispatch(action: ShellAction) {
  switch (action.type) {
    case 'new':
      if (await canLeave()) { setDocument(null); await checkpoint() }
      break
    case 'open': {
      const path = await open({ filters: [markdownFilter] })
      if (path) await openPath(path)
      break
    }
    case 'open-path': await openPath(action.path, action.line); break
    case 'markdown-default': {
      const result = await invoke<'applied' | 'systemSettings' | 'finder'>('markdown_default')
      if (result === 'applied') update('页屿已是 Markdown 的默认打开方式')
      else if (result === 'systemSettings') update('已打开默认应用设置，请将 .md 和 .markdown 设为 Yeyu')
      else await choose('设置 Markdown 默认打开方式',
        '在 Finder 选中 .md 文件，打开「显示简介」，将「打开方式」设为 Yeyu，再点「全部更改」。',
        [{ value: 'ok', label: '好', primary: true, autofocus: true }])
      break
    }
    case 'reopen': {
      const path = settings.recent.find(path => path !== state.path)
      if (path) await openPath(path)
      else update('没有其他最近打开的文档')
      break
    }
    case 'open-folder': {
      const path = await open({ directory: true, defaultPath: state.workspace ?? undefined })
      if (path) await setWorkspace(path)
      break
    }
    case 'save': await saveFile(); break
    case 'save-as': await saveFile(true); break
    case 'reload':
      if (state.path && await canLeave()) await openPath(state.path, 1, false)
      break
    case 'mode':
      state.mode = action.mode
      editor.setMode(action.mode)
      editor.focus()
      update('')
      break
    case 'print': await print(text(), { resolveImage: renderedImage }, themes.find(theme => theme.id === settings.theme), shell.getAppearance()); break
    case 'export': await performExport(action.format); break
    case 'export-again':
      if (lastExport) await performExport(lastExport)
      else update('请先执行一次导出')
      break
    case 'import': {
      const path = await open({ filters: [{ name: 'Pandoc', extensions: ['docx', 'epub', 'odt', 'html', 'tex', 'rtf', 'rst', 'textile', 'opml', 'org'] }] })
      if (!path || !await canLeave()) break
      const stem = path.split(/[/\\]/).pop()!.replace(/\.[^.]+$/, '')
      const destination = await save({ defaultPath: stem + '.md', filters: [markdownFilter] })
      if (!destination) break
      await invoke('pandoc_import', { path, destination })
      await openPath(destination, 1, false)
      break
    }
    case 'theme-import':
    case 'theme-import-typora':
    case 'theme': {
      const path = action.type === 'theme' ? typoraThemePaths.find(path => typoraThemeId(path) === action.id) : undefined
      if (action.type === 'theme' && !path) {
        themeSelection++
        settings.theme = action.id
        syncThemeMenu()
        await persist()
        break
      }
      if (importingThemes) {
        update('主题正在导入，请稍后切换')
        break
      }
      importingThemes = true
      try {
        if (action.type === 'theme-import-typora') update('正在导入主题')
        const paths = path ? [path] : action.type === 'theme-import-typora'
          ? await refreshTyporaThemes()
          : await open({ multiple: true, filters: [{ name: 'CSS 主题', extensions: ['css'] }] })
        if (paths?.length) await addThemes(paths)
        else if (action.type === 'theme-import-typora') update('未找到本机 Typora 主题，可直接导入主题 CSS')
      } finally {
        importingThemes = false
      }
      break
    }
    case 'typora-config-import': await migrateTyporaPreferences(); break
    case 'format': editor.format(action.format); editor.focus(); break
    case 'undo': editor.undo(); editor.focus(); break
    case 'redo': editor.redo(); editor.focus(); break
    case 'outline': editor.select({ anchor: action.from, head: action.from }); editor.focus(); break
    case 'presentation':
      state.presentation = action.value
      editor.setPresentation(action.value)
      update()
      if (settings.spellcheck !== action.value.spellcheck) {
        settings.spellcheck = action.value.spellcheck
        await persist()
      }
      break
    case 'autosave':
      state.autosave = settings.autosave = action.enabled
      scheduleAutosave()
      await persist()
      update(action.enabled ? '自动保存已启用' : '自动保存已关闭')
      break
    case 'animations':
      state.animations = settings.animations = action.enabled
      update(action.enabled ? '界面动画已启用' : '界面动画已关闭')
      await persist()
      break
    case 'copy-markdown': {
      const { from, to } = interval(editor.getSelection())
      await navigator.clipboard.writeText(text().slice(from, to))
      update('已复制 Markdown')
      break
    }
    case 'copy-html': {
      const { from, to } = interval(editor.getSelection())
      const html = await renderMarkdown(text().slice(from, to), { resolveImage: renderedImage })
      if ('ClipboardItem' in window && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }) })])
      } else await navigator.clipboard.writeText(html)
      update('已复制 HTML')
      break
    }
    case 'paste-plain': {
      if (state.presentation.readonly) break
      const target = bind(documentId, revision, text(), interval(editor.getSelection()))
      const value = await navigator.clipboard.readText()
      const location = relocate(target, documentId, revision, text())
      if (location) editor.replace(location.from, location.to, value)
      break
    }
    case 'find':
      if (action.operation.startsWith('replace') && state.presentation.readonly) throw new Error('请先关闭只读模式')
      update(find(editor, action.query, action.operation))
      break
    case 'search-workspace': {
      const sequence = ++workspaceSearch
      const root = state.workspace
      if (!root || !action.text) { shell.setSearchResults([]); break }
      const matches = await invoke<import('./contracts').SearchResult[]>('workspace_search', { root, text: action.text, regex: action.regex, hidden: settings.hidden })
      if (sequence === workspaceSearch && root === state.workspace) shell.setSearchResults(matches)
      break
    }
    case 'workspace-filter': {
      const option = action.option
      const next = { ...settings }
      if (option === 'glob') {
        const glob = await readSetting('筛选文件树', '按工作区相对路径匹配。例如 **/*.md。留空可清除规则。', settings.fileGlob, 'text')
        if (glob === null) break
        next.fileGlob = glob
      } else if (option === 'hidden') next.hidden = !next.hidden
      else next.allFiles = !next.allFiles
      await refreshTree(next)
      settings = next
      state.workspaceFilter = { hidden: next.hidden, all: next.allFiles, glob: next.fileGlob }
      await persist()
      update()
      break
    }
    case 'window-view': {
      if (action.operation === 'fullscreen') {
        const current = getCurrentWindow()
        await current.setFullscreen(!await current.isFullscreen())
      } else {
        const delta = action.operation === 'zoom-in' ? 0.1 : -0.1
        const zoom = action.operation === 'zoom-default' ? 1 : Math.round(Math.max(0.6, Math.min(2.4, settings.zoom + delta)) * 10) / 10
        await getCurrentWebview().setZoom(zoom)
        if (macTitlebar) document.documentElement.style.setProperty('--yy-titlebar-zoom', String(zoom))
        settings.zoom = zoom
        await persist()
        update('缩放 ' + Math.round(zoom * 100) + '%')
      }
      break
    }
    case 'titlebar-material':
      if (macTitlebar) {
        await applyTitlebar(action.material)
        settings.titlebarMaterial = action.material
        await persist()
      }
      break
    case 'workspace-create': {
      const root = state.workspace
      if (!root) break
      const path = await invoke<string>('workspace_create', { root, parent: action.parent, name: action.name, folder: action.folder })
      await refreshTree()
      if (!action.folder) await openPath(path)
      break
    }
    case 'workspace-rename': {
      const root = state.workspace
      if (!root) break
      if (saving) await saving
      const path = await invoke<string>('workspace_rename', { root, path: action.path, name: action.name })
      if (state.path === action.path || state.path?.startsWith(action.path + '/') || state.path?.startsWith(action.path + '\\')) {
        const updated = path + state.path.slice(action.path.length)
        if (file) { file.path = updated; file.name = updated.split(/[/\\]/).pop()! }
        state.path = updated
        state.title = file?.name ?? state.title
        images.clear()
        await checkpoint()
      }
      await refreshTree()
      update('已重命名')
      break
    }
    case 'workspace-trash': {
      const root = state.workspace
      if (!root) break
      const active = state.path === action.path || state.path?.startsWith(action.path + '/') || state.path?.startsWith(action.path + '\\')
      if (active && !await canLeave()) break
      await invoke('workspace_trash', { root, path: action.path })
      if (active) { setDocument(null); await checkpoint() }
      await refreshTree()
      break
    }
    case 'image-import': await addImages(action.files); break
    case 'images': await manageImages(action.mode); break
    case 'ai-provider-save':
    case 'ai-provider-remove':
    case 'ai-model-select': {
      const notice = await writing.configure(action)
      if (notice) update(notice)
      break
    }
    case 'ai-prompts': {
      const previous = settings.aiPrompts
      const next = normalizePrompts(action.prompts)
      settings.aiPrompts = next
      try {
        await persist()
      } catch (error) {
        if (settings.aiPrompts === next) settings.aiPrompts = previous
        throw error
      }
      writing.setPrompts(next)
      break
    }
    case 'ai-context': {
      if (action.scope !== 'files') {
        writing.preview(action.scope, editor, documentId, revision, state.title)
        break
      }
      const paths = await open({ multiple: true, filters: [markdownFilter] })
      if (!paths?.length) break
      const items = await Promise.all(paths.map(path => native.read(path)))
      writing.files(items.map(item => item.name).join('、'), items.map(item => '# ' + item.name + '\n\n' + item.text).join('\n\n'))
      break
    }
    case 'ai-context-clear': writing.clearContext(); break
    case 'ai-send': await writing.send(action.intent, action.prompt, editor, documentId, revision); break
    case 'ai-cancel': await writing.cancel(); break
    case 'ai-retry': await writing.retry(); break
    case 'ai-clear': writing.clear(); break
    case 'plugin-install': {
      const path = await open({ filters: [{ name: '页屿插件', extensions: ['json'] }] })
      if (path) await installPlugin(path)
      break
    }
    case 'plugin-enabled':
      setPlugins(await invoke<PluginInfo[]>('plugin_set_enabled', { id: action.id, enabled: action.enabled }))
      break
    case 'plugin-remove':
      setPlugins(await invoke<PluginInfo[]>('plugin_remove', { id: action.id }))
      break
    case 'plugin-run': {
      if (state.presentation.readonly) throw new Error('请先关闭只读模式')
      if (writing.pending || writing.view.pending) throw new Error('请先处理当前修改建议或等待生成结束')
      if (runningPluginTools) throw new Error('已有插件命令正在运行')
      const command = plugins.find(item => item.id === action.id && item.enabled)?.commands.find(item => item.id === action.command)
      if (!command) throw new Error('插件已停用、卸载或更新')
      const run = (input: string) => invoke<string>('plugin_run', { id: action.id, command: command.id, text: input })
      if (command.workflow) {
        runningPluginTools = true
        try {
          if (command.workflow === 'files') {
            const paths = await open({ multiple: true, filters: [markdownFilter], defaultPath: state.workspace ?? undefined })
            if (paths?.length) await formatFiles(paths, run)
          } else await organizeImages(run)
        } finally {
          runningPluginTools = false
        }
        break
      }
      const source = text()
      const range = action.scope === 'selection' ? interval(editor.getSelection()) : { from: 0, to: source.length }
      if (range.from === range.to) throw new Error('请先选中文字，或把处理范围切换为当前全文')
      const target = bind(documentId, revision, source, range)
      const replacement = await run(target.text)
      if (writing.pending || writing.view.pending) throw new Error('请先处理当前修改建议，再运行插件')
      if (!relocate(target, documentId, revision, text())) throw new Error('原文位置已变化，请重新运行插件')
      const item = suggestion('plugin', command.label, target, replacement)
      if (item.view.hunks) writing.review(item)
      else update('插件处理结果与原文一致')
      break
    }
    case 'suggestion-apply': {
      if (state.presentation.readonly) throw new Error('请先关闭只读模式')
      const item = writing.pending
      if (!item || item.view.id !== action.id || !action.hunks.length) break
      const location = relocate(item.binding, documentId, revision, text())
      if (!location) throw new Error('改稿位置已变化，请基于当前文档重新生成建议')
      editor.replace(location.from, location.to, chooseHunks(item.view.parts, action.hunks))
      writing.review(null)
      if (item.mcpId) await protocol.resolve(item.mcpId)
      editor.focus()
      update('建议已应用，可撤销')
      break
    }
    case 'suggestion-dismiss': {
      const item = writing.pending
      if (item?.view.id !== action.id) break
      writing.review(null)
      if (item.mcpId) await protocol.resolve(item.mcpId)
      break
    }
    case 'mcp-config':
      if (settings.mcp.some(server => server.id === action.server.id)) await protocol.disconnect(action.server.id)
      settings.mcp = [...settings.mcp.filter(server => server.id !== action.server.id), action.server]
      protocol.configure(settings.mcp)
      await persist()
      break
    case 'mcp-remove':
      await protocol.disconnect(action.id)
      settings.mcp = settings.mcp.filter(server => server.id !== action.id)
      protocol.configure(settings.mcp)
      await persist()
      break
    case 'mcp-connect': await protocol.connect(action.id); break
    case 'mcp-disconnect': await protocol.disconnect(action.id); break
    case 'mcp-call': await protocol.call(action.id, action.item, action.args); break
    case 'mcp-authorize':
      if (!state.workspace) throw new Error('请先打开工作区')
      await protocol.workspace(state.workspace, action.allow)
      await shareSelection()
      break
    case 'mcp-next': await reviewMcp(); break
  }
}

const typoraThemeId = (path: string) => 'typora:' + path
const themeName = (path: string) => path.split(/[/\\]/).pop()!.replace(/\.css$/i, '')

function syncThemeMenu() {
  // 本机主题先显示名称，使用后把同一入口绑定到已保存的离线主题。
  const local = new Map<string, Theme>()
  for (const path of typoraThemePaths) {
    const theme = themes.find(theme => theme.id === settings.typoraThemes[path])
      ?? { id: typoraThemeId(path), name: themeName(path), styles: [] }
    local.set(theme.id, theme)
  }
  shell.setThemes(themes, settings.theme, [...local.values()])
}

async function refreshTyporaThemes() {
  const paths = await invoke<string[]>('typora_theme_paths')
  if (paths.length !== typoraThemePaths.length || paths.some((path, index) => path !== typoraThemePaths[index])) {
    typoraThemePaths = paths
    syncThemeMenu()
  }
  return paths
}

async function loadTheme(path: string) {
  const result = await importTheme(path, themes)
  if (!themes.some(item => item.id === result.theme.id)) themes = [...themes, result.theme]
  return result
}

async function addThemes(paths: string[]) {
  const selectedAtStart = themeSelection
  const available = new Map<string, Theme>()
  const linked: [string, string][] = []
  const missing = new Set<string>()
  const failures: string[] = []
  update('正在导入主题')
  for (const path of paths) {
    try {
      const result = await loadTheme(path)
      const { theme } = result
      available.set(theme.id, theme)
      if (typoraThemePaths.includes(path)) linked.push([path, theme.id])
      for (const file of result.missing) missing.add(file)
    } catch (error) {
      failures.push(path.split(/[/\\]/).pop() + ' ' + reason(error))
    }
  }
  if (!available.size) throw new Error('主题导入失败，' + failures[0])
  const single = paths.length === 1 && selectedAtStart === themeSelection ? available.values().next().value : undefined
  if (single) settings.theme = single.id
  if (linked.length) settings.typoraThemes = { ...settings.typoraThemes, ...Object.fromEntries(linked) }
  syncThemeMenu()
  if (single || linked.length) await persist()
  const success = single ? '已使用主题 ' + single.name : `已有 ${available.size} 套主题可用，可从「视图 → 文档主题」切换`
  update(success + (missing.size ? '，缺少资源 ' + [...missing].join('、') : '')
    + (failures.length ? '，导入失败 ' + failures.join('、') : ''))
}

async function migrateTyporaPreferences() {
  const paths = await refreshTyporaThemes().catch(() => [])
  let configurationPath: string | null = null
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  for (;;) {
    let changes: ReturnType<typeof readTyporaProfiles> | undefined
    let loadError = ''
    try { changes = readTyporaProfiles(await native.typoraProfiles(configurationPath), systemDark) }
    catch (error) { loadError = reason(error) }
    const selected = changes?.theme ? typoraThemeKey(changes.theme) : ''
    const themePath = selected ? paths.find(path => typoraThemeKey(themeName(path)) === selected) : undefined
    const theme = selected ? themes.find(theme => theme.id === settings.typoraThemes[themePath ?? '']
      || (!themePath && typoraThemeKey(theme.name) === selected)) : undefined
    const rows: string[] = []
    const notes: string[] = []
    if (changes?.theme) {
      if (theme || themePath) rows.push('主题 · ' + changes.theme)
      else notes.push('找不到主题 ' + changes.theme + ' 的样式，可从「视图 → 文档主题」导入 CSS。')
    }
    if (changes?.upload) rows.push('图床 · ' + (changes.upload.service === 'picgo' ? 'PicGo / PicList' : new URL(changes.upload.endpoint).host))
    if (changes?.unsupportedUpload) notes.push('原图床工具需要单独配置。支持 PicGo、PicList 和 HTTP 上传接口。')
    const shortcutCount = Object.keys(changes?.shortcuts ?? {}).length
    if (shortcutCount) rows.push(`快捷键 · ${shortcutCount} 项，冲突项保留页屿当前配置`)
    if (changes?.unsupportedShortcuts) notes.push(`${changes.unsupportedShortcuts} 个快捷键缺少对应命令或键位。`)
    if (changes?.sidebar) rows.push('侧栏 · ' + ({ files: '文件', outline: '大纲', search: '检索' }[changes.sidebar]))
    if (changes?.autosave !== undefined) rows.push('自动保存 · ' + (changes.autosave ? '开启' : '关闭'))
    if (changes?.autosaveDelay !== undefined) rows.push(`自动保存等待 · ${changes.autosaveDelay / 60_000} 分钟`)
    if (changes?.spellcheck !== undefined) rows.push('拼写检查 · ' + (changes.spellcheck ? '开启' : '关闭'))
    if (changes?.matchCase !== undefined || changes?.wholeWord !== undefined) rows.push('查找 · 大小写和全词匹配偏好')
    const choices = [{ value: 'cancel', label: '取消' }, { value: 'file', label: '选择配置文件…' }]
    const action = await choose('导入 Typora 配置', [...(rows.length ? rows : [loadError || '本机配置中没有可导入的项目。']), ...notes].join('\n'),
      rows.length ? [...choices, { value: 'apply', label: '导入配置', primary: true }] : choices)
    if (action === 'file') {
      configurationPath = await open({ filters: [{ name: 'Typora 配置', extensions: ['plist', 'json', 'jsonc'] }] })
      if (!configurationPath) return
      continue
    }
    if (action !== 'apply' || !changes) return

    const loadedTheme = !theme && themePath ? (await loadTheme(themePath)).theme : theme
    const previous = settings
    settings = { ...settings,
      theme: loadedTheme?.id ?? settings.theme,
      typoraThemes: loadedTheme && themePath ? { ...settings.typoraThemes, [themePath]: loadedTheme.id } : settings.typoraThemes,
      uploadService: changes.upload?.service ?? settings.uploadService,
      uploadEndpoint: changes.upload?.endpoint ?? settings.uploadEndpoint,
      autosave: changes.autosave ?? settings.autosave,
      autosaveDelay: changes.autosaveDelay ?? settings.autosaveDelay,
      spellcheck: changes.spellcheck ?? settings.spellcheck,
      sidebarTab: changes.sidebar ?? settings.sidebarTab,
      findOptions: {
        matchCase: changes.matchCase ?? settings.findOptions.matchCase,
        wholeWord: changes.wholeWord ?? settings.findOptions.wholeWord,
      },
    }
    try { await persist() } catch (error) { settings = previous; throw error }
    syncThemeMenu()
    applyTypingPreferences()
    scheduleAutosave()
    const shortcuts = shell.importShortcutBindings(changes.shortcuts)
    update('已导入 Typora 配置' + (shortcuts.applied ? `，应用 ${shortcuts.applied} 个快捷键` : '')
      + (shortcuts.conflicts ? `，跳过 ${shortcuts.conflicts} 个冲突快捷键` : ''))
    return
  }
}

function applyTypingPreferences() {
  state.autosave = settings.autosave
  state.presentation.spellcheck = settings.spellcheck
  editor.setPresentation(state.presentation)
  shell.setFindOptions(settings.findOptions)
  if (settings.sidebarTab) shell.setSidebarTab(settings.sidebarTab)
}

async function shareSelection() {
  const path = state.path
  const root = state.workspace
  if (!path || !root) return protocol.current(null)
  const selection = editor.getSelection()
  const range = interval(selection)
  await protocol.current({ path, ...selection, text: text().slice(range.from, range.to) })
}

async function monitor() {
  if (checking || !loaded) return
  checking = true
  try {
    const paths = await invoke<string[]>('launch_paths')
    for (const path of new Set(paths)) await openPath(path)
    const openFile = file
    if (openFile && !saving && !switching && diskConflict === undefined) {
      const version = await native.version(openFile.path)
      if (!saving && openFile === file && version !== openFile.version) {
        if (state.dirty || version === null) {
          diskConflict = version
          update('磁盘文件有变化，保存时可处理冲突')
        } else {
          const stamp = revision
          const latest = await native.read(openFile.path)
          if (stamp === revision && openFile === file) {
            const caret = Math.min(editor.getSelection().head, latest.text.length)
            setDocument(latest)
            editor.select({ anchor: caret, head: caret }, false)
            update('已载入磁盘上的更新')
          }
        }
      }
    }
    if (protocol.view.workspaceAllowed) await shareSelection()
    await protocol.check()
  } catch (error) {
    update(reason(error))
  } finally {
    checking = false
  }
}

async function startup() {
  try {
    const [preferences, imported, recovery] = await Promise.all([
      native.preferences(), invoke<Theme[]>('theme_list'), native.recover(),
    ])
    settings = { ...defaults, ...preferences }
    state.animations = settings.animations
    settings.aiPrompts = normalizePrompts(settings.aiPrompts)
    writing.setPrompts(settings.aiPrompts)
    themes = [...builtinThemes, ...imported]
    state.workspaceFilter = { hidden: settings.hidden, all: settings.allFiles, glob: settings.fileGlob }
    if (settings.zoom !== 1) {
      await getCurrentWebview().setZoom(settings.zoom)
      if (macTitlebar) document.documentElement.style.setProperty('--yy-titlebar-zoom', String(settings.zoom))
    }
    syncThemeMenu()
    void refreshTyporaThemes().catch(() => {})
    protocol.configure(settings.mcp)
    const startupTasks = [writing.load(), invoke<PluginInfo[]>('plugin_list').then(setPlugins)]
    if (macTitlebar) startupTasks.push(applyTitlebar(settings.titlebarMaterial === 'frosted' ? 'frosted' : 'liquid'))
    if (settings.workspace) {
      state.workspace = settings.workspace
      startupTasks.push(refreshTree(), protocol.workspace(state.workspace))
    }
    update()
    applyTypingPreferences()
    update()
    const result = await Promise.allSettled(startupTasks)
    const rejected = result.find(item => item.status === 'rejected')
    if (rejected) update(reason(rejected.reason))
    loaded = true
    if (recovery) {
      const base = recovery.path ? await native.read(recovery.path).catch(() => null) : null
      if (base?.text === recovery.text && base.bom === recovery.bom) {
        setDocument(base)
        await checkpoint()
      } else {
        const option = await choose('恢复未保存文档', '恢复上次退出时保留的“' + recovery.title + '”。', [
          { value: 'discard', label: '放弃草稿' }, { value: 'recover', label: '恢复草稿', primary: true, autofocus: true },
        ])
        if (option !== 'discard') setDocument(base, recovery)
        else await checkpoint()
      }
    }
    await monitor()
  } catch (error) {
    loaded = true
    update(reason(error))
  }
  if (__YEYU_QA__) {
    void import('./qa').then(({ runNativeQa }) => runNativeQa({
      editor, state, action: dispatch, openPath, setWorkspace, addTheme: path => addThemes([path]), installPlugin, formatFiles, exportTo,
      saveFile, checkpoint, text, writing, protocol, monitor, shareSelection, setDocument,
    }))
  }
  window.setInterval(() => { void monitor() }, 1_650)
  window.addEventListener('focus', () => {
    void monitor()
    if (loaded) void refreshTyporaThemes().catch(() => {})
    if (state.workspace) void refreshTree().catch(error => update(reason(error)))
  })
  const currentWindow = getCurrentWindow()
  void currentWindow.onCloseRequested(event => {
    if (exits) return
    event.preventDefault()
    void canLeave().then(async allowed => {
      if (!allowed) return
      exits = true
      await Promise.allSettled([recoveryQueue.then(() => native.checkpoint(null)), protocol.current(null)])
      await currentWindow.destroy()
    }).catch(error => update(reason(error)))
  }).catch(error => update(reason(error)))
  void getCurrentWebview().onDragDropEvent(event => {
    if (event.payload.type !== 'drop') return
    const paths = event.payload.paths
    if (paths.length && paths.every(path => /\.(png|jpe?g|gif|webp|svg|bmp|avif|tiff|heic|ico)$/i.test(path))) {
      void addImagePaths(paths).catch(error => update(reason(error)))
    } else if (paths[0]) void openPath(paths[0]).catch(error => update(reason(error)))
  }).catch(error => update(reason(error)))
}

if (__YEYU_QA__) void import('./qa').then(({ prepareRecovery }) => prepareRecovery())
void startup()
