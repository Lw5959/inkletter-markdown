import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { dirname, join } from '@tauri-apps/api/path'
import type { Editor, ExportFormat, ImageMode, OutlineEntry, ShellAction, ShellState, Theme, WorkspaceEntry } from './contracts'
import { createEditor, renderMarkdown } from './editor'
import { mountShell } from './ui'
import { ask, invoke, native, open, reason, save } from './native'
import type { FileSnapshot, Preferences, Recovery } from './native'
import { choose, readSetting } from './dialogs'
import { find, interval, lineOffset } from './document-tools'
import { exportHtml, formatExtensions, print, visual } from './export'
import { assetPath, imageLinks, insertImages, localImage, resolveImage } from './images'
import type { Relocated } from './images'
import { importTheme } from './themes'
import { Writing } from './ai'
import { Protocol } from './mcp'
import { bind, chooseHunks, relocate, suggestion } from './suggestions'

const markdownFilter = { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdwn', 'mdtxt', 'mdtext', 'text', 'txt', 'rmd', 'qmd', 'mdx'] }
const imageFilter = { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'tiff', 'heic', 'ico'] }
const defaults: Preferences = {
  autosave: true, theme: 'default', workspace: null, mcp: [],
  hidden: false, allFiles: false, fileGlob: '', zoom: 1, remoteImages: false, uploadEndpoint: '', recent: [],
}

let settings: Preferences = { ...defaults }
let file: FileSnapshot | null = null
let recoveryBase: Recovery | null = null
let documentId = 0
let revision = 0
let cachedRevision = -1
let cachedText = ''
let themes: Theme[] = []
let lastExport: ExportFormat | null = null
let diskConflict: string | null | undefined
let saving: Promise<boolean> | null = null
let switching = false
let opening = false
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
let statsDoc = -1
let statsBusy = false
let statsPending = false
let stagedImageMoves = new Set<string>()
const images = new Map<string, Promise<string>>()
const state: ShellState = {
  title: '未命名.md', path: null, dirty: false, mode: 'live', detail: '',
  words: 0, characters: 0, line: 1, column: 1, workspace: null, autosave: defaults.autosave,
  presentation: { focus: false, typewriter: false, spellcheck: true },
}
const shell = mountShell(document.querySelector<HTMLElement>('#app')!, { dispatch: act })
const writing = new Writing(view => shell.setAI(view))
const protocol = new Protocol(view => shell.setMcp(view))
const stats = new Worker(new URL('./stats.worker.ts', import.meta.url), { type: 'module' })
const editor: Editor = createEditor(shell.editorHost, {
  onChange,
  onSelectionChange: () => {
    if (!statsTimer && !switching) statsTimer = window.setTimeout(updateCounters, 280)
  },
  onAssetPaste: file => act({ type: 'image-import', files: [file] }),
  resolveImage: renderedImage,
  onOpenLink: url => { void visit(url).catch(error => update(reason(error))) },
})
editor.setPresentation(state.presentation)
shell.setState(state)

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
    }, 1_100)
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
    const value = await readSetting('上传图片', '将文档引用的本地图片上传到指定接口。接口需接收名为 file 的字段并返回 url。', endpoint)
    if (!value) return
    settings.uploadEndpoint = endpoint = value
    await persist()
  }
  if (mode === 'move' && !await ask('保存文档后会把原图移入废纸篓。其他文档引用相同图片时可能需要更新路径。继续？')) return
  const replacements: string[] = []
  const originals: string[] = []
  for (const link of links) {
    const image = localImage(link.url)!
    if (mode === 'upload') replacements.push(await invoke<string>('image_upload', { document, image, endpoint }))
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
    const html = await exportHtml(content, state.title, { resolveImage: url => resolveImage(source, url, false) }, active, format === 'plain-html')
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
  if (!loaded) return
  try {
    await dispatch(action)
  } catch (error) {
    update(reason(error))
  }
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
    case 'print': await print(text(), { resolveImage: renderedImage }, themes.find(theme => theme.id === settings.theme)); break
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
    case 'theme-import': {
      const path = await open({ filters: [{ name: 'Typora CSS 主题', extensions: ['css'] }] })
      if (!path) break
      await addTheme(path)
      break
    }
    case 'theme':
      settings.theme = action.id
      shell.setThemes(themes, settings.theme)
      await persist()
      break
    case 'format': editor.format(action.format); editor.focus(); break
    case 'undo': editor.undo(); editor.focus(); break
    case 'redo': editor.redo(); editor.focus(); break
    case 'outline': editor.select({ anchor: action.from, head: action.from }); editor.focus(); break
    case 'presentation': state.presentation = action.value; editor.setPresentation(action.value); update(); break
    case 'autosave':
      state.autosave = settings.autosave = action.enabled
      scheduleAutosave()
      await persist()
      update(action.enabled ? '自动保存已启用' : '自动保存已关闭')
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
        settings.zoom = zoom
        await persist()
        update('缩放 ' + Math.round(zoom * 100) + '%')
      }
      break
    }
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
    case 'ai-config': await writing.configure(action.endpoint, action.model, action.key); break
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

async function addTheme(path: string) {
  const { theme, missing } = await importTheme(path)
  themes = [...themes, theme]
  settings.theme = theme.id
  shell.setThemes(themes, settings.theme)
  await persist()
  update(missing.length ? '已使用主题，缺少资源 ' + missing.join('、') : '已使用主题 ' + theme.name)
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
    themes = imported
    state.autosave = settings.autosave
    state.workspaceFilter = { hidden: settings.hidden, all: settings.allFiles, glob: settings.fileGlob }
    if (settings.zoom !== 1) await getCurrentWebview().setZoom(settings.zoom)
    shell.setThemes(themes, settings.theme)
    protocol.configure(settings.mcp)
    const startupTasks = [writing.load()]
    if (settings.workspace) {
      state.workspace = settings.workspace
      startupTasks.push(refreshTree(), protocol.workspace(state.workspace))
    }
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
          { value: 'discard', label: '放弃草稿' }, { value: 'recover', label: '恢复草稿', primary: true },
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
      editor, state, action: dispatch, openPath, setWorkspace, addTheme, exportTo,
      saveFile, checkpoint, text, writing, protocol, monitor, shareSelection, setDocument,
    }))
  }
  window.setInterval(() => { void monitor() }, 1_650)
  window.addEventListener('focus', () => {
    void monitor()
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
