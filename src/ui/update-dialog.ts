import { getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import '../dialogs.css'
import './update-dialog.css'
import { el } from './helpers'
import { dismissOnBackdrop } from './dialog-dismiss'
import { openDesktopWindow } from './desktop-window'
import { markdownLink, renderMarkdownContent } from './markdown-content'
import type { createPages } from './pages'

export type UpdateProgress =
  | { kind: 'download'; downloaded: number; total: number | null }
  | { kind: 'verify' }
  | { kind: 'install' }

export type PackageLaunch = 'installer' | 'permission' | 'save'
export type UpdateSource = 'auto' | 'github' | 'gitee'

const preferenceKey = 'yeyu.update.source.v1'
const sources = { auto: '自动', github: 'GitHub', gitee: 'Gitee' } as const
const updateWindows = new WeakMap<Document, HTMLDialogElement>()
const updateHeight = 250

function preferredSource(): UpdateSource {
  try {
    const saved = localStorage.getItem(preferenceKey)
    if (saved === 'github' || saved === 'gitee') return saved
  } catch { /* 无持久存储时仍可选择本次更新源。 */ }
  return 'auto'
}

type PackageOffer = {
  kind: 'package'
  apply: (report: (progress: UpdateProgress) => void) => Promise<void>
  install: () => Promise<PackageLaunch>
  save?: () => Promise<string | null>
}

export type UpdateOffer = { version: string; notes: string } & (
  // 返回 false 表示用户取消了保存或安装确认，可以回到文档。
  | { kind: 'install'; apply: (report: (progress: UpdateProgress) => void) => Promise<void | false> }
  | PackageOffer
)

function formatBytes(bytes: number) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + ' KiB'
  return (bytes / 1024 ** 2).toFixed(1) + ' MiB'
}

/** 打开更新界面并立即检查，用户点击确认后才调用 apply。 */
export function showUpdate(check: (source: UpdateSource) => Promise<UpdateOffer | null>, pages?: Pick<ReturnType<typeof createPages>, 'open'>) {
  if (!pages && updateWindows.has(document)) {
    updateWindows.get(document)?.ownerDocument.defaultView?.focus()
    return
  }

  const dialog = pages ? null : el('dialog', { className: 'app-dialog yy-update-dialog', attrs: { 'aria-label': '软件更新' } })
  const panel = dialog ?? el('div', { className: 'yy-mobile-brief-page yy-update-page' })
  let popup: ReturnType<typeof openDesktopWindow> = null
  let dismissed = false
  const active = () => !dismissed && (dialog?.open ?? panel.isConnected)
  const closeDialog = () => {
    if (!dialog || dismissed) return
    dismissed = true
    updateWindows.delete(document)
    if (popup) {
      popup.close()
    } else {
      if (dialog.open) dialog.close()
      dialog.remove()
    }
  }
  const current = el('p', { className: 'yy-update-version', text: '正在读取当前版本…' })
  let source = preferredSource()
  const choices = el('div', { className: 'yy-update-sources', attrs: { role: 'group', 'aria-label': '更新源' } })
  const sourceButtons = (Object.keys(sources) as UpdateSource[]).map(id => {
    const button = el('button', { type: 'button', text: sources[id], attrs: { 'aria-pressed': String(source === id) } })
    button.onclick = () => {
      if (applying || source === id) return
      source = id
      try { localStorage.setItem(preferenceKey, id) } catch { /* 保留本次选择。 */ }
      for (const choice of sourceButtons) choice.setAttribute('aria-pressed', String(choice === button))
      void checkForUpdate(false)
    }
    choices.append(button)
    return button
  })
  const headline = el('h3', { attrs: { tabindex: '-1' } })
  const detail = el('p', { className: 'yy-update-detail', attrs: { hidden: '' } })
  const status = el('div', { className: 'yy-update-status', attrs: { role: 'status' } }, headline, detail)
  const notesBody = el('div', { className: 'yy-update-notes-body yy-markdown-content', attrs: { tabindex: '0' } })
  const notes = el('section', { className: 'yy-update-notes', attrs: { hidden: '', 'aria-label': '发布说明' } },
    el('h3', { text: '发布说明' }), notesBody)
  const meter = el('progress', { attrs: { 'aria-label': '下载进度' } })
  const bytes = el('div', { className: 'yy-update-bytes' })
  const download = el('div', { className: 'yy-update-download', attrs: { hidden: '' } }, meter, bytes)
  const dismiss = el('button', { type: 'button', text: '关闭', attrs: { autofocus: '' } })
  const primary = el('button', { type: 'button', className: 'app-dialog-primary', attrs: { hidden: '' } })
  if (dialog) dialog.append(el('h2', { text: '软件更新' }))
  dismiss.hidden = !dialog
  panel.append(current, el('div', { className: 'yy-update-source-row' }, el('span', { text: '更新源' }), choices), status, notes, download,
    el('div', { className: 'app-dialog-actions' }, dismiss, primary))

  let installedVersion: string | undefined
  let applying = false
  let checkId = 0

  function showStatus(title: string, message = '') {
    headline.textContent = title
    detail.textContent = message
    detail.hidden = !message
  }

  function showAction(label: string, action: () => Promise<void>) {
    primary.textContent = label
    primary.onclick = () => { void action() }
    primary.hidden = false
  }

  function report(progress: UpdateProgress) {
    if (!applying || !active()) return
    if (progress.kind !== 'download') {
      download.hidden = true
      showStatus(progress.kind === 'install' ? '正在校验签名并安装…' : '正在校验安装包…')
      return
    }
    if (download.hidden) showStatus('正在下载更新…')
    download.hidden = false
    const received = formatBytes(progress.downloaded)
    if (progress.total) {
      meter.max = progress.total
      meter.value = Math.min(progress.downloaded, progress.total)
      const percent = Math.floor(meter.value * 100 / meter.max)
      bytes.textContent = received + ' / ' + formatBytes(progress.total) + ' · ' + percent + '%'
    } else {
      meter.removeAttribute('value')
      bytes.textContent = '已下载 ' + received
    }
  }

  async function runAction(title: string, action: () => Promise<void>) {
    if (applying || !active()) return
    applying = true
    primary.hidden = true
    dismiss.disabled = true
    for (const choice of sourceButtons) choice.disabled = true
    showStatus(title)
    headline.focus()

    try {
      await action()
    } catch {
      if (!active()) return
      // 原生及网络错误可能带有下载 URL，界面只展示可操作的提示。
      showStatus('更新未完成', '请重新检查更新后重试。')
      showAction('重试', checkForUpdate)
    } finally {
      applying = false
      download.hidden = true
      dismiss.disabled = false
      for (const choice of sourceButtons) choice.disabled = false
      if (active() && dialog) dismiss.focus()
    }
  }

  function installPackage(release: PackageOffer) {
    return runAction('正在打开安装包…', async () => {
      const result = await release.install()
      if (!active()) return
      if (result === 'permission') {
        showStatus('需要安装授权', '请在系统设置中允许页屿安装应用，返回后再点「安装更新」。')
      } else if (result === 'installer') {
        showStatus('已打开安装包', '请在系统界面确认安装。')
      } else {
        const save = release.save
        if (!save) throw new Error('未找到系统安装器')
        showStatus('更新已下载', '当前系统没有可用的安装程序，可以将安装包保存到本地。')
        showAction('保存安装包', () => savePackage(save))
        return
      }
      showAction(release.save ? '打开安装包' : '安装更新', () => installPackage(release))
    })
  }

  function savePackage(save: NonNullable<PackageOffer['save']>) {
    return runAction('正在保存安装包…', async () => {
      const path = await save()
      if (!active()) return
      showStatus(path ? '安装包已保存' : '更新已下载', path ?? '可以将安装包保存到本地。')
      showAction('保存安装包', () => savePackage(save))
    })
  }

  function apply(release: UpdateOffer) {
    return runAction('正在准备更新…', async () => {
      const result = await release.apply(report)
      if (!active()) return
      if (result === false) {
        closeDialog()
      } else if (release.kind === 'install') {
        showStatus('更新已安装', '页屿正在重新启动。')
      } else {
        showStatus('更新已下载', '安装包已校验，可以开始安装。')
        showAction(release.save ? '打开安装包' : '安装更新', () => installPackage(release))
      }
    })
  }

  async function checkForUpdate(focus = true) {
    const id = ++checkId
    const selected = source
    const currentCheck = () => active() && id === checkId
    if (focus && dialog) dismiss.focus()
    primary.hidden = true
    notes.hidden = true
    if (!installedVersion) current.textContent = '正在读取当前版本…'
    showStatus('正在检查更新…')
    try {
      installedVersion ??= await getVersion()
      if (!currentCheck()) return
      current.textContent = '当前版本 ' + installedVersion
      const release = await check(selected)
      // 更换更新源或离开界面后，旧请求不能覆盖当前结果。
      if (!currentCheck()) return
      if (!release) {
        showStatus('已是最新版本')
        popup?.setHeight(updateHeight)
        return
      }
      const installs = release.kind === 'install'
      showStatus('发现新版本 ' + release.version, installs
        ? '确认后将下载并校验安装包，安装完成后重启页屿。'
        : '更新将在页屿内下载并校验，完成后可打开安装包。')
      showAction(installs ? '安装更新' : '下载更新', () => apply(release))
      const rendered = release.notes.trim() ? await renderMarkdownContent(release.notes) : '暂无发布说明。'
      if (!currentCheck()) return
      notesBody.replaceChildren(rendered)
      notesBody.scrollTop = 0
      notes.hidden = false
      popup?.setHeight(472)
    } catch {
      if (!currentCheck()) return
      if (!installedVersion) current.textContent = '无法读取当前版本'
      showStatus('检查更新失败', '请检查网络连接，或稍后重试。')
      showAction('重试', checkForUpdate)
      popup?.setHeight(updateHeight)
    }
  }

  notesBody.addEventListener('click', event => {
    const url = markdownLink(event)
    if (url) void invoke('visit_link', { url }).catch(() => {
      if (active() && !applying && !notes.hidden) showStatus('无法打开链接', '请检查系统浏览器设置。')
    })
  })
  if (dialog) {
    dismiss.onclick = closeDialog
    dialog.addEventListener('keydown', event => event.stopPropagation())
    dialog.addEventListener('cancel', event => {
      event.preventDefault()
      if (!applying) closeDialog()
    })
    popup = openDesktopWindow(dialog, { title: '软件更新', width: 460, height: updateHeight, modal: true, onClose: closeDialog })
    if (!popup) {
      dismissOnBackdrop(dialog)
      document.body.append(dialog)
    }
    updateWindows.set(document, dialog)
    dialog.addEventListener('close', closeDialog, { once: true })
    dialog.showModal()
  } else pages?.open('软件更新', panel)
  void checkForUpdate()
}
