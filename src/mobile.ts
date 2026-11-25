import { invoke } from '@tauri-apps/api/core'
import { builtinThemes } from './builtin-themes'
import type { EditorMode, Selection } from './contracts'
import { choose } from './dialogs'
import { createEditor } from './editor'
import { checkPublishedPackage, offerUpdate } from './release-updates'
import { createAppearance } from './ui/appearance'
import { el } from './ui/helpers'
import { icons } from './ui/icons'
import './ui/shell.css'
import './ui/motion.css'
import './mobile.css'

type Origin = { uri: string; name: string; bom: boolean; version: string; writable: boolean }
type Document = Origin & { text: string }
type Draft = { origin: Origin | null; text: string; selection: Selection }
type Session = { uri: string | null; theme: string; animations: boolean; mode: EditorMode; draft?: Draft }
type SheetRow = { label: string; icon?: string; checked?: boolean; action: () => void | Promise<void> }

let origin: Origin | null = null
let saved = ''
let mode: EditorMode = 'live'
let theme = 'default'
let animations = true
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
  resolveImage: () => '',
})

const fileOpen = iconButton('打开文件', icons.folderOpen, () => operate(openFile))
const fileSave = iconButton('保存文档', icons.save, () => operate(() => writeDocument(false)))
const more = iconButton('更多操作', icons.more, showActions)
const header = el('header', { className: 'yy-mobile-header yy-chrome' },
  el('div', { className: 'yy-mobile-heading' }, title, detail),
  el('nav', { className: 'yy-mobile-tools', attrs: { 'aria-label': '文件操作' } }, fileOpen, fileSave, more))
const appearance = createAppearance(paper, syncSystemBars)

const live = modeButton('实时', 'live')
const source = modeButton('源码', 'source')
const footer = el('footer', { className: 'yy-mobile-footer yy-chrome' },
  el('div', { className: 'yy-mobile-modes', attrs: { role: 'group', 'aria-label': '编辑模式' } }, live, source),
  el('div', { className: 'yy-mobile-tools', attrs: { role: 'group', 'aria-label': '编辑历史' } },
    iconButton('撤销', icons.undo, () => editor.undo()), iconButton('重做', icons.redo, () => editor.redo())))
document.querySelector('#app')!.replaceChildren(el('div', { className: 'yy-shell yy-mobile' }, header, paper, footer))

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
  const status = message ?? (dirty ? '有未保存的编辑' : origin ? (origin.writable ? '已保存' : '只读文件') : '尚未保存')
  if (title.textContent !== name) title.textContent = name
  if (detail.textContent !== status) detail.textContent = status
  if (fileSave.disabled !== busy) fileOpen.disabled = fileSave.disabled = more.disabled = busy
}

function reason(error: unknown) {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

function report(error: unknown) { refresh(reason(error)) }

function syncSystemBars() {
  const channels = getComputedStyle(header).backgroundColor.match(/\d+/g)
  if (!channels || channels.length < 3) return
  const color = '#' + channels.slice(0, 3).map(value => Number(value).toString(16).padStart(2, '0')).join('')
  void invoke('android_appearance', { light: document.documentElement.dataset.yeyuAppearance !== 'dark', color }).catch(() => {})
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

function showDocument(value: Document | null, draft?: Draft) {
  replacing = true
  try {
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
    revision++
  } finally { replacing = false }
  refresh()
}

function checkpoint() {
  window.clearTimeout(timer)
  timer = 0
  const session: Session = { uri: origin?.uri ?? null, theme, animations, mode }
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
    fileOpen.disabled = fileSave.disabled = more.disabled = false
  })
}

const read = (uri: string) => invoke<Document>('android_read', { uri })
const pick = (name?: string) => invoke<string | null>('android_pick', { name })

async function canLeave() {
  if (!dirty || editor.getMarkdown() === saved) return true
  const answer = await choose('未保存的编辑', '离开当前文档前要保存吗？', [
    { label: '继续编辑', value: 'cancel' }, { label: '放弃更改', value: 'discard' }, { label: '保存', value: 'save', primary: true },
  ])
  return answer === 'discard' || (answer === 'save' && await writeDocument(false))
}

async function openFile() {
  const uri = await pick()
  if (!uri || uri === origin?.uri) return
  const value = await read(uri)
  if (!await canLeave()) return
  showDocument(value)
  await checkpoint()
}

async function newDocument() {
  if (!await canLeave()) return
  showDocument(null)
  await checkpoint()
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

function showSheet(label: string, rows: SheetRow[]) {
  const dialog = el('dialog', { className: 'yy-mobile-sheet', attrs: { 'aria-label': label } })
  dialog.append(el('div', { className: 'yy-mobile-sheet-title' }, el('h2', { text: label }), iconButton('关闭', icons.close, () => dialog.close())))
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
  dialog.addEventListener('close', () => dialog.remove(), { once: true })
  document.body.append(dialog)
  dialog.showModal()
}

function showActions() {
  showSheet('文档操作', [
    { label: '新建文档', icon: icons.filePlus, action: () => operate(newDocument) },
    { label: '另存副本', icon: icons.copy, action: () => operate(() => writeDocument(true)) },
    { label: '文档主题', icon: icons.palette, action: () => showSheet('文档主题', [
      { id: 'default', name: '跟随系统' }, ...builtinThemes,
    ].map(item => ({ label: item.name, checked: item.id === theme, action: () => { setTheme(item.id); scheduleCheckpoint() } }))) },
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
  const session = await invoke<Session | null>('android_load_session')
  setTheme(session?.theme ?? 'default')
  setAnimations(session?.animations !== false)
  setMode(session?.mode === 'source' ? 'source' : 'live')
  const original = session?.uri ? await read(session.uri).catch(() => null) : null
  if (session?.draft && (!original || session.draft.text !== original.text)) {
    const choice = await choose('恢复未保存文档', '恢复上次保留的编辑稿？', [
      { label: '放弃草稿', value: 'discard' }, { label: '恢复草稿', value: 'recover', primary: true },
    ])
    if (choice !== 'discard') {
      const base = original?.version === session.draft.origin?.version ? original : null
      showDocument(base, session.draft)
      await checkpoint()
      return
    }
  }
  showDocument(original)
  if (session?.uri && !original) refresh('文件访问已失效，请重新打开')
  if (session?.draft) await checkpoint()
}

setMode('live')
setAnimations(false)
operate(start)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && (dirty || timer)) void checkpoint().catch(report)
})
