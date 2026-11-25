import { invoke } from '@tauri-apps/api/core'
import { builtinThemes } from './builtin-themes'
import type { EditorFormat, EditorMode, Presentation, Selection } from './contracts'
import { choose } from './dialogs'
import { count, find, lineOffset } from './document-tools'
import { createEditor } from './editor'
import { installMobileViewport } from './mobile-viewport'
import { checkPublishedPackage, offerUpdate } from './release-updates'
import { createAppearance } from './ui/appearance'
import { cancelDialog, dismissOnBackdrop } from './ui/dialog-dismiss'
import { FindBar } from './ui/find-bar'
import { el } from './ui/helpers'
import { icons } from './ui/icons'
import './ui/shell.css'
import './ui/motion.css'
import './mobile.css'

type Origin = { uri: string; name: string; bom: boolean; version: string; writable: boolean }
type Document = Origin & { text: string }
type Draft = { origin: Origin | null; text: string; selection: Selection }
type WorkspaceFile = { uri: string; name: string; path: string }
type Session = { theme: string; animations: boolean; mode: EditorMode; draft?: Draft; recoveries?: Draft[];
  workspace?: string; presentation?: Presentation }
type SheetRow = { label: string; icon?: string; checked?: boolean; action: () => void | Promise<void> }

let origin: Origin | null = null
let saved = ''
let mode: EditorMode = 'live'
let theme = 'default'
let animations = true
let hasDocument = false
let recoveries: Draft[] = []
let workspace: string | undefined
let presentation: Presentation = { focus: false, typewriter: false, spellcheck: false }
let dirty = false
let replacing = false
let busy = false
let revision = 0
let timer = 0
let pending = Promise.resolve()

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
})

const fileOpen = iconButton('打开文件', icons.folderOpen, () => operate(openFile))
const fileSave = iconButton('保存文档', icons.save, () => operate(() => writeDocument(false)))
const themes = iconButton('文档主题', icons.palette, showThemes)
const more = iconButton('更多操作', icons.more, showActions)
const header = el('header', { className: 'yy-mobile-header yy-chrome' },
  el('div', { className: 'yy-mobile-heading' }, title, detail),
  el('nav', { className: 'yy-mobile-tools', attrs: { 'aria-label': '文件操作' } }, fileOpen, fileSave, themes, more))
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
const landing = el('main', { className: 'yy-mobile-landing yy-chrome', attrs: { 'aria-label': '文件入口' } },
  el('div', { className: 'yy-mobile-launch-actions' }, chooseFile, createFile, workspaceButton, recoverFiles))
const fileActions = [fileOpen, fileSave, themes, more, chooseFile, createFile, workspaceButton, recoverFiles]
document.body.classList.add('yy-android')
document.querySelector('#app')!.replaceChildren(el('div', { className: 'yy-shell yy-mobile' }, header, stage, landing, footer))
installMobileViewport(paper)

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
  const name = origin?.name ?? (hasDocument ? '未命名.md' : '页屿')
  const status = message ?? (dirty ? '有未保存的编辑' : origin ? (origin.writable ? '已保存' : '只读文件') : hasDocument ? '尚未保存' : '')
  if (title.textContent !== name) title.textContent = name
  if (detail.textContent !== status) detail.textContent = status
  detail.hidden = !status
  fileOpen.hidden = fileSave.hidden = stage.hidden = footer.hidden = !hasDocument
  landing.hidden = hasDocument
  recoverFiles.hidden = !recoveries.length
  for (const button of fileActions) button.disabled = busy
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
}

function showDocument(value: Document | null, draft?: Draft, opened = true) {
  replacing = true
  try {
    finder.close()
    if (value) {
      const { text, ...metadata } = value
      origin = metadata
      saved = text
    } else {
      origin = null
      saved = ''
    }
    if (draft) origin = draft.origin
    editor.setMarkdown(draft?.text ?? saved)
    if (draft) editor.select(draft.selection, false)
    dirty = !!draft
    hasDocument = opened
    revision++
  } finally { replacing = false }
  refresh()
}

function checkpoint() {
  window.clearTimeout(timer)
  timer = 0
  const session: Session = { theme, animations, mode, recoveries, workspace, presentation }
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
    for (const button of fileActions) button.disabled = false
  })
}

const read = (uri: string) => invoke<Document>('android_read', { uri })
const pick = (name?: string, mime?: string) => invoke<string | null>('android_pick', { name, mime })

async function canLeave() {
  if (!dirty || editor.getMarkdown() === saved) return true
  const answer = await choose('未保存的编辑', '离开当前文档前要保存吗？', [
    { label: '继续编辑', value: 'cancel' }, { label: '放弃更改', value: 'discard' }, { label: '保存', value: 'save', primary: true },
  ])
  return answer === 'discard' || (answer === 'save' && await writeDocument(false))
}

async function openFile() {
  const uri = await pick()
  if (uri) await openUri(uri)
}

async function openUri(uri: string, line?: number) {
  if (uri === origin?.uri && !line) return
  if (uri === origin?.uri || await canLeave()) {
    if (uri !== origin?.uri) showDocument(await read(uri))
    if (line) {
      const offset = lineOffset(editor.getMarkdown(), line)
      editor.select({ anchor: offset, head: offset })
    }
    await checkpoint()
  }
}

async function newDocument() {
  if (!await canLeave()) return
  showDocument(null)
  await checkpoint()
}

async function recoverDraft(draft: Draft) {
  if (!await canLeave()) return
  const original = draft.origin ? await read(draft.origin.uri).catch(() => null) : null
  recoveries = recoveries.filter(item => item !== draft)
  if (original?.text === draft.text) showDocument(original)
  else showDocument(original?.version === draft.origin?.version ? original : null, { ...draft, origin: original ? draft.origin : null })
  await checkpoint()
}

function showRecoveries() {
  showSheet('恢复草稿', recoveries.map(draft => ({ label: draft.origin?.name ?? '未命名.md', icon: icons.file,
    action: () => operate(() => recoverDraft(draft)) })))
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
    saved = savedText
    dirty = request !== revision
    refresh(dirty ? '已保存上一版，仍有新编辑' : '已保存')
    await checkpoint().catch(report)
    return true
  } catch (error) {
    if (!existing || (error as { kind?: string })?.kind !== 'conflict') throw error
    const answer = await choose('文件已被其他应用修改', '可以载入磁盘上的版本，或把当前编辑另存为副本。', [
      { label: '继续编辑', value: 'cancel' }, { label: '载入磁盘', value: 'reload' }, { label: '另存副本', value: 'copy', primary: true },
    ])
    if (answer === 'copy') return writeDocument(true)
    if (answer === 'reload') {
      showDocument(await read(uri))
      await checkpoint()
    }
    return false
  }
}

function sheet(label: string) {
  const dialog = el('dialog', { className: 'yy-mobile-sheet', attrs: { 'aria-label': label } })
  dismissOnBackdrop(dialog)
  dialog.append(el('div', { className: 'yy-mobile-sheet-title' }, el('h2', { text: label }), iconButton('关闭', icons.close, () => dialog.close())))
  dialog.addEventListener('close', () => dialog.remove(), { once: true })
  return dialog
}

function present(dialog: HTMLDialogElement) {
  document.body.append(dialog)
  dialog.showModal()
}

function showSheet(label: string, rows: SheetRow[]) {
  const dialog = sheet(label)
  for (const row of rows) {
    const button = el('button', { className: 'yy-mobile-row', type: 'button' },
      ...(row.icon ? [el('span', { className: 'yy-mobile-row-icon', html: row.icon })] : []),
      el('span', { text: row.label }))
    if (row.checked !== undefined) {
      button.setAttribute('aria-pressed', String(row.checked))
      if (row.checked) button.append(el('span', { className: 'yy-mobile-row-check', html: icons.check }))
    }
    button.addEventListener('click', () => {
      dialog.close()
      void row.action()
    })
    dialog.append(button)
  }
  present(dialog)
}

function showOutline() {
  const entries = editor.getOutline()
  if (!entries.length) { refresh('大纲为空'); return }
  showSheet('文档大纲', entries.map(entry => ({ label: entry.title, icon: icons.outline, action: () => {
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
  showSheet('阅读与编辑', ([['focus', '专注'], ['typewriter', '打字机'], ['spellcheck', '拼写检查'], ['readonly', '只读']] as const)
    .map(([key, label]) => ({ label, checked: !!presentation[key], action: () => {
      setPresentation({ ...presentation, [key]: !presentation[key] })
      scheduleCheckpoint()
    } })))
}

async function exportDocument(format: 'html' | 'pdf') {
  const { exportHtml } = await import('./export')
  const name = origin?.name.replace(/\.[^.]+$/, '') ?? '未命名'
  const html = await exportHtml(editor.getMarkdown(), name, {}, builtinThemes.find(item => item.id === theme), false, appearance.get())
  if (format === 'pdf') await invoke('android_print', { name, html })
  else {
    const uri = await pick(name + '.html', 'text/html')
    if (!uri) return
    await invoke('android_write', { uri, text: html, bom: false, expected: null })
    refresh('已导出 HTML')
  }
}

async function showWorkspace(reselect = false) {
  const root = !workspace || reselect ? await invoke<string | null>('android_pick_workspace') : workspace
  if (!root) return
  const { entries } = await invoke<{ entries: WorkspaceFile[] }>('android_workspace', { uri: root })
  workspace = root
  scheduleCheckpoint()
  const dialog = sheet('工作区')
  dialog.classList.add('yy-mobile-workspace')
  const search = el('input', { className: 'yy-mobile-search', type: 'search', attrs: { 'aria-label': '筛选或检索工作区', placeholder: '文件名或正文' } })
  const searchText = el('button', { className: 'yy-mobile-row', type: 'button', text: '全文检索' })
  const results = el('div', { className: 'yy-mobile-workspace-rows' })
  const notice = el('p', { className: 'yy-mobile-workspace-notice', attrs: { role: 'status' } })
  const row = (file: WorkspaceFile, preview?: string, line?: number) => {
    const button = el('button', { className: 'yy-mobile-row', type: 'button', text: preview ? `${file.path} · ${preview}` : file.path })
    button.addEventListener('click', () => { dialog.close(); operate(() => openUri(file.uri, line)) })
    return button
  }
  let searching = false
  function filter() {
    if (searching) return
    const term = search.value.trim().toLocaleLowerCase()
    const matches = entries.filter(file => file.path.toLocaleLowerCase().includes(term))
    results.replaceChildren(...matches.map(file => row(file)))
    notice.textContent = matches.length ? `${matches.length} 个文档` : '没有匹配的 Markdown 文件'
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
        if (!dialog.open || matches >= 100) break
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
  dialog.append(el('div', { className: 'yy-mobile-workspace-tools' }, search, searchText), notice, results,
    launchButton('更换文件夹', icons.folderOpen, () => { dialog.close(); operate(() => showWorkspace(true)) }))
  filter()
  present(dialog)
}

function showThemes() {
  showSheet('文档主题', [{ id: 'default', name: '跟随系统' }, ...builtinThemes].map(item => ({
    label: item.name, checked: item.id === theme,
    action: () => { setTheme(item.id); scheduleCheckpoint() },
  })))
}

function showActions() {
  showSheet('文档操作', [
    { label: '新建文档', icon: icons.filePlus, action: () => operate(newDocument) },
    { label: '工作区', icon: icons.folder, action: () => operate(showWorkspace) },
    ...(hasDocument ? [
      { label: '另存副本', icon: icons.copy, action: () => operate(() => writeDocument(true)) },
      { label: 'Markdown 格式', icon: icons.edit, action: () => showSheet('Markdown 格式', formats.map(([format, label]) => ({
        label, action: () => { editor.format(format); editor.focus() },
      }))) },
      { label: '阅读与编辑', icon: icons.settings, action: showPresentation },
      { label: '字数统计', icon: icons.outline, action: () => {
        const stats = count(editor.getMarkdown())
        return choose('字数统计', `${stats.words} 词 · ${stats.characters} 字符`, [{ label: '关闭', value: 'close' }]).then(() => {})
      } },
      { label: '导出与打印', icon: icons.save, action: () => showSheet('导出与打印', [
        { label: '导出 HTML', action: () => operate(() => exportDocument('html')) },
        { label: '打印或保存 PDF', action: () => operate(() => exportDocument('pdf')) },
      ]) },
    ] : []),
    ...(recoveries.length ? [{ label: '恢复草稿', icon: icons.undo, action: showRecoveries }] : []),
    { label: '界面动画', icon: icons.settings, checked: animations, action: () => { setAnimations(!animations); scheduleCheckpoint() } },
    { label: '检查更新', icon: icons.refresh, action: () => operate(async () => {
      refresh('正在检查 GitHub Releases')
      const release = await checkPublishedPackage('android-arm64.apk')
      if (release && await offerUpdate(release, '下载更新') === 'apply') await invoke('android_open_update', { url: release.url })
      refresh(release ? undefined : '已是最新版本')
    }) },
  ])
}

async function start() {
  const session = await invoke<Session | null>('android_load_session').catch(() => null)
  setTheme(session?.theme ?? 'default')
  setAnimations(session?.animations !== false)
  setMode(session?.mode === 'source' ? 'source' : 'live')
  if (session?.presentation) setPresentation(session.presentation)
  workspace = session?.workspace
  // 启动时总是由用户选文件。旧会话里的未保存草稿保留在入口中，直到用户主动恢复。
  recoveries = [...(session?.recoveries ?? []), ...(session?.draft ? [session.draft] : [])]
  refresh()
  await openFile()
}

setMode('live')
setAnimations(false)
operate(start)
window.addEventListener('yeyu:android-back', event => {
  const modal = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).at(-1)
  if (modal) {
    event.preventDefault()
    cancelDialog(modal)
  } else if (finder.visible) {
    event.preventDefault()
    finder.close()
  } else if (hasDocument || busy) {
    event.preventDefault()
    operate(async () => {
      if (!await canLeave()) return
      showDocument(null, undefined, false)
      await checkpoint()
    })
  }
})
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && (dirty || timer)) void checkpoint().catch(report)
})
