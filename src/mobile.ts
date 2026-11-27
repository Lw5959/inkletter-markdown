import { invoke } from '@tauri-apps/api/core'
import { builtinThemes } from './builtin-themes'
import type { EditorFormat, EditorMode, Presentation, Selection } from './contracts'
import { count, find, lineOffset } from './document-tools'
import { createEditor } from './editor'
import { localImage } from './images'
import { createMobileMotion } from './mobile-motion'
import type { MobileServicePage, MobileServiceSettings, createMobileServices } from './mobile-services'
import { installMobileViewport } from './mobile-viewport'
import { checkPublishedPackage } from './release-updates'
import { createAppearance } from './ui/appearance'
import { cancelDialog } from './ui/dialog-dismiss'
import { FindBar } from './ui/find-bar'
import { el } from './ui/helpers'
import { icons } from './ui/icons'
import { createImagePreview } from './ui/image-preview'
import { createPages } from './ui/pages'
import { showAutomaticUpdate, showUpdate, type UpdatePreferences, type UpdateSource } from './ui/update-dialog'
import './ui/shell.css'
import './ui/motion.css'
import './mobile.css'

type Origin = { uri: string; name: string; bom: boolean; version: string; writable: boolean }
type Document = Origin & { text: string }
type Draft = { origin: Origin | null; text: string; selection: Selection }
type WorkspaceFile = { uri: string; name: string; path: string; kind?: 'image' }
type RecentFile = { uri: string; name: string }
type Session = { theme: string; animations: boolean; autoCheckUpdates?: boolean; mode: EditorMode; draft?: Draft; recoveries?: Draft[];
  recent?: RecentFile[]; workspace?: string; presentation?: Presentation; services?: MobileServiceSettings }
type PageRow = { label: string; icon?: string; checked?: boolean; action: (button: HTMLButtonElement) => void }
type BackGesture = { phase: 'start' | 'progress' | 'cancel'; progress: number; edge: 'left' | 'right' }

const recentLimit = 12

let origin: Origin | null = null
let saved = ''
let mode: EditorMode = 'live'
let theme = 'default'
let animations = true
let autoCheckUpdates = false
let hasDocument = false
let recoveries: Draft[] = []
let recent: RecentFile[] = []
let workspace: string | undefined
let workspaceFiles: { root: string; request: Promise<WorkspaceFile[]> } | undefined
const imageSources = new Map<string, Promise<string>>()
let presentation: Presentation = { focus: false, typewriter: false, spellcheck: false }
let serviceSettings: MobileServiceSettings = {}
let services: ReturnType<typeof createMobileServices> | undefined
let documentId = 0
let dirty = false
let replacing = false
let busy = false
let revision = 0
let timer = 0
let pending = Promise.resolve()
let backState = ''
let backUpdate = Promise.resolve()

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
const motion = createMobileMotion(reducedMotion)

const title = el('h1', { className: 'yy-mobile-title' })
const detail = el('p', { className: 'yy-mobile-detail', attrs: { role: 'status' } })
const paper = el('main', { className: 'yy-paper document-theme', attrs: { 'aria-label': 'Markdown 编辑器' } })
const host = el('div')
paper.append(host)
const themeStyle = document.head.appendChild(el('style'))
const editor = createEditor(host, {
  onChange: () => {
    if (replacing) return
    revision++
    dirty = true
    refresh()
    scheduleCheckpoint()
  },
  onSelectionChange: () => { if (dirty && !replacing) scheduleCheckpoint() },
  resolveImage: resolveMobileImage,
  onOpenLink: url => operate(() => followLink(url)),
})

const fileOpen = iconButton('打开文件', icons.folderOpen, () => operate(openFile))
const fileSave = iconButton('保存文档', icons.save, () => operate(() => writeDocument(false)))
const headerControls = () => [iconButton('文档主题', icons.palette, showThemes), iconButton('更多操作', icons.more, showActions)]
const editorControls = headerControls()
const homeControls = headerControls()
const homeDetail = el('p', { className: 'yy-mobile-detail', attrs: { role: 'status', hidden: '' } })
const header = screenHeader(title, detail, [fileOpen, fileSave, ...editorControls])
const homeHeader = screenHeader(el('h1', { className: 'yy-mobile-title', text: '墨笺' }), homeDetail, homeControls)
const canvas = document.createElement('canvas')
canvas.width = canvas.height = 1
const colorPixel = canvas.getContext('2d', { willReadFrequently: true })
let barStyle = ''
const appearance = createAppearance(paper, syncSystemBars)

const live = modeButton('实时', 'live')
const source = modeButton('源码', 'source')
const finder = new FindBar({ dispatch(action) {
  if (action.type === 'find') {
    try { refresh(find(editor, action.query, action.operation)) }
    catch (error) { report(error) }
  }
}, onClose: () => editor.focus() })
const stage = el('div', { className: 'yy-mobile-stage' }, paper, finder.element)
const footer = el('footer', { className: 'yy-mobile-footer yy-chrome' },
  el('div', { className: 'yy-mobile-modes', attrs: { role: 'group', 'aria-label': '编辑模式' } }, live, source),
  el('div', { className: 'yy-mobile-tools', attrs: { role: 'group', 'aria-label': '编辑工具' } },
    iconButton('大纲', icons.outline, showOutline), iconButton('查找替换', icons.search, () => finder.open(true)),
    iconButton('撤销', icons.undo, () => editor.undo()), iconButton('重做', icons.redo, () => editor.redo())))

function launchButton(label: string, icon: string, action: () => void, primary = false) {
  const button = el('button', { className: 'yy-mobile-launch-button', type: 'button', text: label,
    attrs: primary ? { 'data-primary': 'true' } : {} })
  button.prepend(el('span', { className: 'yy-mobile-row-icon', html: icon }))
  button.addEventListener('click', action)
  return button
}

const chooseFile = launchButton('打开文件', icons.folderOpen, () => operate(openFile), true)
const createFile = launchButton('新建 Markdown', icons.filePlus, () => operate(newDocument))
const workspaceButton = launchButton('打开工作区', icons.folder, () => operate(showWorkspace))
const recoverFiles = launchButton('恢复草稿', icons.undo, showRecoveries)
const landingList = el('div', { className: 'yy-mobile-recent-list' })
const landingRecent = el('section', { className: 'yy-mobile-landing-recent', attrs: { 'aria-labelledby': 'yy-mobile-recent-title' } },
  el('h2', { text: '最近打开', attrs: { id: 'yy-mobile-recent-title' } }), landingList)
const landing = el('main', { className: 'yy-mobile-landing yy-chrome', attrs: { 'aria-label': '文件入口' } },
  el('div', { className: 'yy-mobile-launch-content' },
    el('div', { className: 'yy-mobile-launch-actions' }, chooseFile, createFile, workspaceButton, recoverFiles), landingRecent))
const fileActions = [fileOpen, fileSave, ...editorControls, ...homeControls, chooseFile, createFile, workspaceButton, recoverFiles]
const homeScreen = el('div', { className: 'yy-mobile-screen yy-mobile-home' }, homeHeader, landing)
const editorScreen = el('div', { className: 'yy-mobile-screen yy-mobile-editor', attrs: { hidden: '' } }, header, stage, footer)
const documentArea = el('div', { className: 'yy-mobile-document-area' }, homeScreen, editorScreen)
const pages = createPages(documentArea, undefined, (current, direction) => {
  motion.enter(current ?? (hasDocument ? editorScreen : homeScreen), direction)
  syncBackNavigation()
})
document.body.classList.add('yy-android')
document.querySelector('#app')!.replaceChildren(el('div', { className: 'yy-shell yy-mobile' }, documentArea, pages.element))
installMobileViewport(paper)

function screenHeader(heading: HTMLElement, status: HTMLElement, controls: HTMLButtonElement[]) {
  return el('header', { className: 'yy-mobile-header yy-chrome' },
    el('div', { className: 'yy-mobile-heading' }, heading, status),
    el('nav', { className: 'yy-mobile-tools', attrs: { 'aria-label': '文件操作' } }, ...controls))
}

function iconButton(label: string, icon: string, onClick: () => void) {
  const button = el('button', { className: 'yy-mobile-icon', type: 'button', html: icon, title: label, attrs: { 'aria-label': label } })
  button.addEventListener('click', onClick)
  return button
}

function modeButton(label: string, value: EditorMode) {
  const button = el('button', { className: 'yy-mobile-mode', type: 'button', text: label })
  button.addEventListener('click', () => {
    setMode(value)
    scheduleCheckpoint()
  })
  return button
}

function setMode(value: EditorMode) {
  mode = value
  paper.dataset.mode = value
  editor.setMode(value)
  live.setAttribute('aria-pressed', String(value === 'live'))
  source.setAttribute('aria-pressed', String(value === 'source'))
}

function refresh(message?: string) {
  const name = origin?.name ?? '未命名.md'
  const status = message ?? (dirty ? '有未保存的编辑' : origin ? (origin.writable ? '已保存' : '只读文件') : hasDocument ? '尚未保存' : '')
  const visibleDetail = hasDocument ? detail : homeDetail
  if (title.textContent !== name) title.textContent = name
  if (visibleDetail.textContent !== status) visibleDetail.textContent = status
  visibleDetail.hidden = !status
  if (editorScreen.hidden === hasDocument) {
    editorScreen.hidden = !hasDocument
    homeScreen.hidden = hasDocument
    if (!pages.active) motion.enter(hasDocument ? editorScreen : homeScreen, hasDocument ? 'forward' : 'back')
  }
  recoverFiles.hidden = !recoveries.length
  landingList.inert = busy
  for (const button of fileActions) button.disabled = busy
  syncBackNavigation()
}

function reason(error: unknown) {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

function report(error: unknown) { refresh(reason(error)) }

function syncSystemBars() {
  if (!colorPixel) return
  colorPixel.fillStyle = getComputedStyle(header).backgroundColor
  colorPixel.fillRect(0, 0, 1, 1)
  const color = '#' + Array.from(colorPixel.getImageData(0, 0, 1, 1).data).slice(0, 3).map(value => value.toString(16).padStart(2, '0')).join('')
  const light = document.documentElement.dataset.yeyuAppearance !== 'dark'
  if (barStyle === color + light) return
  barStyle = color + light
  void invoke('android_appearance', { light, color }).catch(() => { barStyle = '' })
}

function setTheme(value: string) {
  const current = builtinThemes.find(item => item.id === value)
  theme = current?.id ?? 'default'
  themeStyle.textContent = current?.styles.join('\n') ?? ''
  appearance.select(current)
  syncSystemBars()
}

function setAnimations(value: boolean) {
  animations = value
  document.documentElement.dataset.yeyuMotion = value ? 'on' : 'off'
  if (!motion.enabled()) motion.reset()
  syncBackNavigation()
}

function syncBackNavigation() {
  const enabled = !!pages.active || hasDocument || busy
  const animated = motion.enabled()
  const next = `${enabled}:${animated}`
  if (backState === next) return
  backState = next
  // 动画偏好和页面状态可能连续变化，按顺序更新原生回调的启用状态。
  backUpdate = backUpdate.then(() => invoke<void>('android_back_navigation', { enabled, animated })).catch(() => {
    if (backState === next) backState = ''
  })
}

function showDocument(value: Document | null, draft?: Draft, opened = true) {
  replacing = true
  try {
    finder.close()
    if (value) {
      const { text, ...metadata } = value
      origin = metadata
      saved = text
      rememberOpened(metadata)
    } else {
      origin = null
      saved = ''
    }
    if (draft) origin = draft.origin
    imageSources.clear()
    editor.setMarkdown(draft?.text ?? saved)
    if (draft) editor.select(draft.selection, false)
    dirty = !!draft
    hasDocument = opened
    documentId++
    revision++
    services?.documentChanged()
  } finally { replacing = false }
  refresh()
}

function checkpoint() {
  window.clearTimeout(timer)
  timer = 0
  const session: Session = { theme, animations, autoCheckUpdates, mode, recoveries, recent, workspace, presentation, services: serviceSettings }
  if (dirty) session.draft = { origin, text: editor.getMarkdown(), selection: editor.getSelection() }
  const next = pending.then(() => invoke<void>('android_save_session', { session }))
  pending = next.catch(() => {})
  return next
}

function scheduleCheckpoint() {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => { void checkpoint().catch(report) }, 400)
}

function operate(action: () => Promise<unknown>) {
  if (busy) return
  busy = true
  refresh()
  void action().catch(report).finally(() => {
    busy = false
    landingList.inert = false
    for (const button of fileActions) button.disabled = false
    syncBackNavigation()
  })
}

const read = (uri: string) => invoke<Document>('android_read', { uri })
const pick = (name?: string, mime?: string) => invoke<string | null>('android_pick', { name, mime })

function loadWorkspace(root: string, refresh = false) {
  if (!refresh && workspaceFiles?.root === root) return workspaceFiles.request
  const request = invoke<{ entries: WorkspaceFile[] }>('android_workspace', { uri: root }).then(value => value.entries)
  workspaceFiles = { root, request }
  void request.catch(() => { if (workspaceFiles?.request === request) workspaceFiles = undefined })
  return request
}

async function workspaceResource(uri: string, url: string) {
  const path = localImage(url)
  if (!workspace || !path || path.startsWith('/')) return
  const entries = await loadWorkspace(workspace)
  // 文件选择器和工作区可返回同一文档的单文件 URI 和树 URI。
  const key = (value: string) => value.replace(/\/tree\/[^/]+(?=\/document\/)/, '')
  const document = entries.find(file => key(file.uri) === key(uri))
  if (!document) return
  const parts = document.path.split('/').slice(0, -1)
  for (const part of path.split('/')) {
    if (part === '..') {
      if (!parts.length) return
      parts.pop()
    } else if (part && part !== '.') parts.push(part)
  }
  const relative = parts.join('/')
  return entries.find(file => file.path === relative)
}

function resolveMobileImage(url: string) {
  if (/^(?:https?:\/\/|data:image\/)/i.test(url)) return url
  const uri = origin?.uri
  if (!uri) return ''
  const cached = imageSources.get(url)
  if (cached) return cached
  const source = workspaceResource(uri, url)
    .then(file => file?.kind === 'image' ? invoke<string>('android_image', { uri: file.uri }) : '')
    .catch(() => '')
  imageSources.set(url, source)
  void source.then(value => { if (!value && imageSources.get(url) === source) imageSources.delete(url) })
  return source
}

async function followLink(url: string) {
  if (/^(https?:|mailto:)/i.test(url)) return invoke('visit_link', { url })
  const uri = origin?.uri
  const [path, anchor] = url.split('#', 2)
  const file = uri && await workspaceResource(uri, path)
  if (!file) throw new Error('找不到链接文件，请先打开它所在的工作区')
  if (file.kind === 'image') { previewWorkspaceImage(file); return }
  if (await openUri(file.uri) && anchor) {
    const heading = editor.getOutline().find(item => item.id === anchor || encodeURIComponent(item.id ?? '') === anchor)
    if (heading) editor.select({ anchor: heading.from, head: heading.from })
  }
}

async function canLeave() {
  if (!dirty || editor.getMarkdown() === saved) return true
  const answer = await choosePage('未保存的编辑', '离开当前文档前要保存吗？', [
    { label: '继续编辑', value: 'cancel' }, { label: '放弃更改', value: 'discard' }, { label: '保存', value: 'save', primary: true },
  ])
  if (answer === 'discard') return confirmDiscard()
  return answer === 'save' && await writeDocument(false) && !dirty
}

async function confirmDiscard() {
  return await choosePage('放弃未保存的编辑？', '当前文档中未保存的修改将被丢弃。', [
    { label: '继续编辑', value: 'cancel' }, { label: '确认放弃', value: 'discard' },
  ]) === 'discard'
}

async function openFile() {
  const uri = await pick()
  return uri ? openUri(uri) : false
}

async function openUri(uri: string, line?: number) {
  if (uri === origin?.uri && !line) return true
  if (uri !== origin?.uri) {
    if (!await canLeave()) return false
    showDocument(await read(uri))
  }
  if (line) {
    const offset = lineOffset(editor.getMarkdown(), line)
    editor.select({ anchor: offset, head: offset })
  }
  await checkpoint()
  return true
}

function renderRecent(list: HTMLElement) {
  list.replaceChildren(...recent.map(item => {
    const button = el('button', { className: 'yy-mobile-row', type: 'button' },
      el('span', { className: 'yy-mobile-row-icon', html: icons.file }), el('span', { text: item.name }))
    button.addEventListener('click', () => operate(() => openRecent(item, list)))
    return button
  }))
  if (!recent.length) list.append(el('p', { className: 'yy-mobile-page-message', text: '暂无最近打开的文档' }))
}

function rememberOpened({ uri, name }: RecentFile) {
  if (recent[0]?.uri === uri && recent[0].name === name) return
  // 只记录成功打开、保存的文档。重开仍由 Android 检查原有的系统授权。
  recent = [{ uri, name }, ...recent.filter(item => item.uri !== uri)].slice(0, recentLimit)
  renderRecent(landingList)
}

async function openRecent(item: RecentFile, list: HTMLElement) {
  if (item.uri === origin?.uri) { pages.closeAll(); return }
  const value = await read(item.uri).catch(() => null)
  if (!list.isConnected) return
  if (value) {
    if (!await canLeave()) return
    showDocument(value)
    pages.closeAll()
    await checkpoint()
    return
  }
  const answer = await choosePage('无法打开最近文件', `「${item.name}」可能已移动、删除或授权失效。`, [
    { label: '取消', value: 'cancel' }, { label: '移出记录', value: 'forget' }, { label: '选择文件', value: 'pick', primary: true },
  ])
  const reopened = answer === 'pick' && await openFile()
  if (answer === 'forget' || (reopened && origin?.uri !== item.uri)) {
    recent = recent.filter(entry => entry.uri !== item.uri)
    renderRecent(landingList)
    if (list !== landingList) renderRecent(list)
    await checkpoint()
  }
  if (reopened) pages.closeAll()
}

function showRecents() {
  const list = el('div', { className: 'yy-mobile-recent-list yy-mobile-file-list', attrs: { 'data-page-scroll': '' } })
  renderRecent(list)
  pages.push('最近打开', el('div', { className: 'yy-mobile-file-page' }, list,
    el('div', { className: 'yy-mobile-file-actions' }, launchButton('打开文件', icons.folderOpen, () => operate(async () => {
      if (await openFile()) pages.closeAll()
    })))))
}

async function newDocument() {
  if (!await canLeave()) return
  showDocument(null)
  await checkpoint()
}

async function recoverDraft(draft: Draft) {
  if (!await canLeave()) return false
  const original = draft.origin ? await read(draft.origin.uri).catch(() => null) : null
  recoveries = recoveries.filter(item => item !== draft)
  if (original?.text === draft.text) showDocument(original)
  else showDocument(original?.version === draft.origin?.version ? original : null, { ...draft, origin: original ? draft.origin : null })
  await checkpoint()
  return true
}

function showRecoveries() {
  showListPage('恢复草稿', recoveries.map(draft => ({ label: draft.origin?.name ?? '未命名.md', icon: icons.file,
    action: () => operate(async () => { if (await recoverDraft(draft)) pages.closeAll() }) })))
}

async function writeDocument(copy: boolean): Promise<boolean> {
  const existing = copy || !origin?.writable ? null : origin
  const name = origin?.name.replace(/\.[^.]+$/, '') ?? '未命名'
  const uri = existing?.uri ?? await pick(`${name}${copy ? '-副本' : ''}.md`)
  if (!uri) return false
  const text = editor.getMarkdown()
  const request = revision
  const bom = origin?.bom ?? false
  // 如果文件提供方写入失败，尝试从应用私有目录恢复当前编辑稿。
  await checkpoint().catch(report)
  try {
    const { text: savedText, ...metadata } = await invoke<Document>('android_write', { uri, text, bom, expected: existing?.version ?? null })
    origin = metadata
    rememberOpened(metadata)
    saved = savedText
    dirty = request !== revision
    refresh(dirty ? '已保存上一版，仍有新编辑' : '已保存')
    await checkpoint().catch(report)
    return true
  } catch (error) {
    if (!existing || (error as { kind?: string })?.kind !== 'conflict') throw error
    const answer = await choosePage('文件已被其他应用修改', '可以载入磁盘上的版本，或把当前编辑另存为副本。', [
      { label: '继续编辑', value: 'cancel' }, { label: '载入磁盘', value: 'reload' }, { label: '另存副本', value: 'copy', primary: true },
    ])
    if (answer === 'copy') return writeDocument(true)
    if (answer === 'reload' && await confirmDiscard()) {
      showDocument(await read(uri))
      await checkpoint()
    }
    return false
  }
}

function setRowChecked(button: HTMLButtonElement, checked: boolean) {
  button.setAttribute('aria-pressed', String(checked))
  button.querySelector('.yy-mobile-row-check')?.remove()
  if (checked) button.append(el('span', { className: 'yy-mobile-row-check', html: icons.check }))
}

function actionRow(row: PageRow) {
  const button = el('button', { className: 'yy-mobile-row', type: 'button' },
    ...(row.icon ? [el('span', { className: 'yy-mobile-row-icon', html: row.icon })] : []),
    el('span', { text: row.label }))
  if (row.checked !== undefined) setRowChecked(button, row.checked)
  button.addEventListener('click', () => row.action(button))
  return button
}

function choosePage(title: string, message: string, choices: { label: string; value: string; primary?: boolean }[]) {
  return new Promise<string>(resolve => {
    let answer = ''
    const actions = el('div', { className: 'yy-mobile-brief-actions' })
    for (const choice of choices) {
      const button = el('button', { type: 'button', text: choice.label, className: choice.primary ? 'yy-btn yy-btn-primary' : 'yy-btn' })
      button.addEventListener('click', () => {
        answer = choice.value
        pages.back()
      })
      actions.append(button)
    }
    pages.push(title, el('div', { className: 'yy-mobile-brief-page' }, el('p', { text: message }), actions), () => resolve(answer))
  })
}

function showListPage(label: string, rows: PageRow[]) {
  const list = el('div', { className: 'yy-mobile-file-list', attrs: { 'data-page-scroll': '' } }, ...rows.map(actionRow))
  pages.push(label, el('div', { className: 'yy-mobile-file-page' }, list))
}

function showOutline() {
  const entries = editor.getOutline()
  if (!entries.length) { refresh('大纲为空'); return }
  showListPage('文档大纲', entries.map(entry => ({ label: entry.title, icon: icons.outline, action: () => {
    pages.back()
    editor.select({ anchor: entry.from, head: entry.from })
  } })))
}

const formats: ReadonlyArray<readonly [EditorFormat, string]> = [
  ['heading-1', '一级标题'], ['heading-2', '二级标题'], ['heading-3', '三级标题'],
  ['bold', '加粗'], ['italic', '斜体'], ['underline', '下划线'], ['strike', '删除线'],
  ['highlight', '高亮'], ['subscript', '下标'], ['superscript', '上标'], ['quote', '引用'],
  ['bullet-list', '无序列表'], ['ordered-list', '有序列表'],
  ['task', '任务列表'], ['table', '表格'], ['inline-code', '行内代码'], ['code-block', '代码块'],
  ['link', '链接'], ['image', '图片链接'], ['math', '公式'], ['mermaid', 'Mermaid 图表'],
  ['toc', '目录'], ['footnote', '脚注'], ['rule', '分隔线'], ['clear', '清除格式'],
]

function setPresentation(value: Presentation) {
  presentation = value
  editor.setPresentation(value)
}

function showPresentation() {
  showListPage('阅读与编辑', ([['focus', '专注'], ['typewriter', '打字机'], ['spellcheck', '拼写检查'], ['readonly', '只读']] as const)
    .map(([key, label]) => ({ label, checked: !!presentation[key], action: button => {
      setPresentation({ ...presentation, [key]: !presentation[key] })
      setRowChecked(button, !!presentation[key])
      scheduleCheckpoint()
    } })))
}

async function exportDocument(format: 'html' | 'pdf') {
  refresh('正在准备 ' + format.toUpperCase())
  const { exportHtml } = await import('./export')
  const name = origin?.name.replace(/\.[^.]+$/, '') ?? '未命名'
  const html = await exportHtml(editor.getMarkdown(), name, { resolveImage: resolveMobileImage }, builtinThemes.find(item => item.id === theme), false, appearance.get())
  if (format === 'pdf') {
    await invoke('android_print', { name, html })
    refresh('已打开系统打印预览')
  }
  else {
    const uri = await pick(name + '.html', 'text/html')
    if (!uri) { refresh(); return }
    await invoke('android_write', { uri, text: html, bom: false, expected: null })
    refresh('已导出 HTML')
  }
}

const mobileUpdatePreferences: UpdatePreferences = {
  enabled: () => autoCheckUpdates,
  async save(enabled) {
    const prior = autoCheckUpdates
    autoCheckUpdates = enabled
    try { await checkpoint() }
    catch (error) { autoCheckUpdates = prior; throw error }
  },
}
const findMobileUpdate = (source: UpdateSource) => checkPublishedPackage({ source, beforeInstall: checkpoint })

function showMobileUpdate() {
  showUpdate(findMobileUpdate, { open: pages.push }, mobileUpdatePreferences)
}

async function openService(page: MobileServicePage) {
  if (!services) {
    const parent = pages.active
    const { createMobileServices } = await import('./mobile-services')
    if (pages.active !== parent) return
    services = createMobileServices({ editor, pages, settings: serviceSettings, persist: checkpoint, notify: refresh, read, pick,
      state: () => ({ id: documentId, revision, title: origin?.name ?? '未命名.md', uri: origin?.uri ?? null,
        open: hasDocument, readonly: !!presentation.readonly }),
    })
  }
  await services.open(page)
}

function previewWorkspaceImage(file: WorkspaceFile) {
  const { frame, detail } = createImagePreview(file.name, () => invoke('android_image', { uri: file.uri }))
  pages.push('图片预览', el('div', { className: 'yy-mobile-brief-page yy-mobile-image-preview' },
    el('strong', { text: file.name }), frame, detail))
}

async function showWorkspace(reselect = false) {
  const parent = pages.active
  const root = !workspace || reselect ? await invoke<string | null>('android_pick_workspace') : workspace
  if (!root || pages.active !== parent) return
  const entries = await loadWorkspace(root, true)
  if (pages.active !== parent) return
  workspace = root
  scheduleCheckpoint()
  const search = el('input', { className: 'yy-mobile-search', type: 'search', attrs: { 'aria-label': '筛选或检索工作区', placeholder: '文件名或正文' } })
  const searchText = el('button', { className: 'yy-mobile-row', type: 'button', text: '全文检索' })
  const results = el('div', { className: 'yy-mobile-workspace-rows yy-mobile-file-list', attrs: { 'data-page-scroll': '' } })
  const notice = el('p', { className: 'yy-mobile-workspace-notice', attrs: { role: 'status' } })
  const content = el('div', { className: 'yy-mobile-workspace yy-mobile-file-page' },
    el('div', { className: 'yy-mobile-workspace-tools' }, search, searchText), notice, results,
    el('div', { className: 'yy-mobile-file-actions' }, launchButton('更换文件夹', icons.folderOpen, () => operate(() => showWorkspace(true)))))
  const row = (file: WorkspaceFile, preview?: string, line?: number) => {
    const label = preview ? `${file.path} · ${preview}` : file.path
    const button = el('button', { className: 'yy-mobile-row', type: 'button' }, el('span', { text: label }))
    if (file.kind === 'image') {
      button.prepend(el('span', { className: 'yy-mobile-row-icon', html: icons.image }))
      button.addEventListener('click', () => previewWorkspaceImage(file))
    } else button.addEventListener('click', () => operate(async () => {
      if (await openUri(file.uri, line) && content.isConnected) pages.closeAll()
    }))
    return button
  }
  let searching = false
  function filter() {
    if (searching) return
    const term = search.value.trim().toLocaleLowerCase()
    const matches = entries.filter(file => file.path.toLocaleLowerCase().includes(term))
    results.replaceChildren(...matches.map(file => row(file)))
    notice.textContent = matches.length ? `${matches.length} 个文件` : '没有匹配的文件'
  }
  function runSearch() {
    const term = search.value.trim().toLocaleLowerCase()
    if (!term || searching) return
    searching = true
    search.disabled = searchText.disabled = true
    notice.textContent = '正在检索工作区'
    results.replaceChildren()
    void (async () => {
      let matches = 0
      let skipped = 0
      for (const file of entries) {
        if (!content.isConnected || matches >= 100) break
        if (file.kind === 'image') continue
        const value = await read(file.uri).catch(() => null)
        if (!value) { skipped++; continue }
        const lines = value.text.split(/\r\n|[\r\n]/)
        const index = lines.findIndex(line => line.toLocaleLowerCase().includes(term))
        if (index >= 0) { results.append(row(file, lines[index].trim().slice(0, 80), index + 1)); matches++ }
      }
      notice.textContent = `${matches} 个匹配文档${skipped ? `，${skipped} 个无法读取` : ''}`
    })().catch(report).finally(() => { searching = search.disabled = searchText.disabled = false })
  }
  search.addEventListener('input', filter)
  search.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) runSearch() })
  searchText.addEventListener('click', runSearch)
  filter()
  if (reselect) pages.replace('工作区', content)
  else pages.push('工作区', content)
}

function showThemes() {
  showListPage('文档主题', [{ id: 'default', name: '跟随系统' }, ...builtinThemes].map(item => ({
    label: item.name, checked: item.id === theme,
    action: () => {
      setTheme(item.id)
      scheduleCheckpoint()
      pages.back()
    },
  })))
}

function showActions() {
  const returnToEditor = (action: () => Promise<unknown>) => () => {
    pages.closeAll()
    operate(action)
  }
  showListPage('文档操作', [
    { label: '新建文档', icon: icons.filePlus, action: returnToEditor(newDocument) },
    { label: '最近打开', icon: icons.history, action: showRecents },
    { label: '工作区', icon: icons.folder, action: () => operate(showWorkspace) },
    ...(hasDocument ? [
      { label: '另存副本', icon: icons.copy, action: returnToEditor(() => writeDocument(true)) },
      { label: 'Markdown 格式', icon: icons.edit, action: () => showListPage('Markdown 格式', formats.map(([format, label]) => ({
        label, action: () => { pages.closeAll(); editor.format(format); editor.focus() },
      }))) },
      { label: '阅读与编辑', icon: icons.settings, action: showPresentation },
      { label: '字数统计', icon: icons.outline, action: () => {
        const stats = count(editor.getMarkdown())
        pages.push('字数统计', el('dl', { className: 'yy-mobile-brief-page yy-mobile-stats' },
          el('dt', { text: '词数' }), el('dd', { text: String(stats.words) }),
          el('dt', { text: '字符数' }), el('dd', { text: String(stats.characters) })))
      } },
      { label: '导出与打印', icon: icons.save, action: () => showListPage('导出与打印', [
        { label: '导出 HTML', action: returnToEditor(() => exportDocument('html')) },
        { label: '打印或保存 PDF', action: returnToEditor(() => exportDocument('pdf')) },
      ]) },
    ] : []),
    ...(recoveries.length ? [{ label: '恢复草稿', icon: icons.undo, action: showRecoveries }] : []),
    { label: 'AI 写作', icon: icons.sparkles, action: () => operate(() => openService('ai')) },
    { label: 'MCP 工具', icon: icons.plug, action: () => operate(() => openService('mcp')) },
    { label: '插件市场', icon: icons.settings, action: () => operate(() => openService('plugins')) },
    { label: '界面动画', icon: icons.settings, checked: animations, action: button => {
      setAnimations(!animations)
      setRowChecked(button, animations)
      scheduleCheckpoint()
    } },
    { label: '检查更新', icon: icons.refresh, action: showMobileUpdate },
  ])
}

async function start() {
  const session = await invoke<Session | null>('android_load_session').catch(() => null)
  setTheme(session?.theme ?? 'default')
  setAnimations(session?.animations !== false)
  autoCheckUpdates = session?.autoCheckUpdates === true
  setMode(session?.mode === 'source' ? 'source' : 'live')
  if (session?.presentation) setPresentation(session.presentation)
  workspace = session?.workspace
  serviceSettings = session?.services ?? {}
  if (Array.isArray(session?.recent)) {
    const seen = new Set<string>()
    recent = session.recent.filter(item => {
      if (typeof item?.uri !== 'string' || !item.uri.startsWith('content://') || typeof item.name !== 'string' || !item.name || seen.has(item.uri)) return false
      seen.add(item.uri)
      return true
    }).slice(0, recentLimit)
  }
  renderRecent(landingList)
  // 首页只恢复入口与记录，由用户主动挑选文件或恢复草稿。
  recoveries = [...(session?.recoveries ?? []), ...(session?.draft ? [session.draft] : [])]
  refresh()
  void showAutomaticUpdate(findMobileUpdate, mobileUpdatePreferences, {
    open: (title, contents) => { if (!pages.active) pages.push(title, contents) },
  })
}

setMode('live')
setAnimations(false)
operate(start)
reducedMotion.addEventListener('change', () => {
  if (!motion.enabled()) motion.reset()
  syncBackNavigation()
})
window.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.key !== 'Escape' || document.querySelector('dialog[open]')) return
  if (event.target instanceof Element && event.target.closest('[role="combobox"][aria-expanded="true"]')) return
  if (pages.back()) event.preventDefault()
})
function previewBack() {
  if (document.querySelector('dialog[open]')) return null
  if (pages.active) return pages.previewBack()
  if (finder.visible) return { element: finder.element, restore() {} }
  // 有未保存的编辑时，提交后先询问。手势不预览丢弃后的首页。
  if (!hasDocument || dirty || busy) return null
  homeScreen.inert = true
  homeScreen.hidden = false
  return {
    element: editorScreen,
    restore() {
      homeScreen.hidden = hasDocument
      homeScreen.inert = false
    },
  }
}

window.addEventListener('yeyu:android-back-gesture', event => {
  const gesture = (event as CustomEvent<BackGesture>).detail
  if (gesture.phase === 'start') motion.startBack(previewBack, gesture.edge)
  else if (gesture.phase === 'progress') motion.progressBack(gesture.progress)
  else if (gesture.phase === 'cancel') motion.cancelBack()
})

function backAction(): (() => void) | null {
  const modal = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).at(-1)
  if (modal) return () => { if (modal.open) cancelDialog(modal) }
  const page = pages.active
  if (page) return () => { if (pages.active === page) pages.back() }
  if (finder.visible) return () => { if (!pages.active) finder.close() }
  if (!hasDocument && !busy) return null
  const id = documentId
  return () => {
    if (pages.active || id !== documentId) return
    operate(async () => {
      if (!await canLeave()) return
      showDocument(null, undefined, false)
      await checkpoint()
    })
  }
}

window.addEventListener('yeyu:android-back', event => {
  const action = backAction()
  if (!action) return
  event.preventDefault()
  motion.commitBack(action)
})
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return
  motion.reset()
  if (dirty || timer) void checkpoint().catch(report)
})
