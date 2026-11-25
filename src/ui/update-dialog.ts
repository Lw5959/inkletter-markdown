import { getVersion } from '@tauri-apps/api/app'
import '../dialogs.css'
import './update-dialog.css'
import { el } from './helpers'

export type UpdateProgress =
  | { kind: 'download'; downloaded: number; total: number | null }
  | { kind: 'install' }

export type UpdateOffer = { version: string; notes: string } & (
  // 返回 false 表示用户取消了保存或安装确认，可以回到文档。
  | { kind: 'install'; apply: (report: (progress: UpdateProgress) => void) => Promise<void | false> }
  | { kind: 'external'; apply: () => Promise<void> }
)

function formatBytes(bytes: number) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + ' KiB'
  return (bytes / 1024 ** 2).toFixed(1) + ' MiB'
}

/** 打开更新窗口并立即检查，用户点击确认后才调用 apply。 */
export function showUpdateDialog(check: (installedVersion: string) => Promise<UpdateOffer | null>) {
  if (document.querySelector('dialog.yy-update-dialog[open]')) return

  const dialog = el('dialog', { className: 'app-dialog yy-update-dialog', attrs: { 'aria-label': '软件更新' } })
  const current = el('p', { className: 'yy-update-version', text: '正在读取当前版本…' })
  const headline = el('h3', { attrs: { tabindex: '-1' } })
  const detail = el('p', { className: 'yy-update-detail', attrs: { hidden: '' } })
  const status = el('div', { className: 'yy-update-status', attrs: { role: 'status' } }, headline, detail)
  const notesBody = el('div', { className: 'yy-update-notes-body', attrs: { tabindex: '0' } })
  const notes = el('section', { className: 'yy-update-notes', attrs: { hidden: '', 'aria-label': '发布说明' } },
    el('h3', { text: '发布说明' }), notesBody)
  const meter = el('progress', { attrs: { 'aria-label': '下载进度' } })
  const bytes = el('div', { className: 'yy-update-bytes' })
  const download = el('div', { className: 'yy-update-download', attrs: { hidden: '' } }, meter, bytes)
  const dismiss = el('button', { type: 'button', text: '关闭', attrs: { autofocus: '' } })
  const primary = el('button', { type: 'button', className: 'app-dialog-primary', attrs: { hidden: '' } })
  dialog.append(el('h2', { text: '软件更新' }), current, status, notes, download,
    el('div', { className: 'app-dialog-actions' }, dismiss, primary))

  let installedVersion: string | undefined
  let applying = false

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
    if (!applying || !dialog.open) return
    if (progress.kind === 'install') {
      download.hidden = true
      showStatus('正在校验签名并安装…')
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

  async function apply(release: UpdateOffer) {
    if (applying || !dialog.open) return
    applying = true
    primary.hidden = true
    dismiss.disabled = true
    showStatus(release.kind === 'install' ? '正在准备更新…' : '正在打开下载链接…')
    headline.focus()

    try {
      if (release.kind === 'install') {
        if (await release.apply(report) === false) {
          dialog.close()
          return
        }
        if (dialog.open) showStatus('更新已安装', '页屿正在重新启动。')
      } else {
        await release.apply()
        if (dialog.open) showStatus('已将下载链接交给系统', '请在浏览器或系统下载界面查看进度。')
      }
    } catch {
      if (!dialog.open) return
      // 原生及网络错误可能带有下载 URL，界面只展示可操作的提示。
      showStatus(release.kind === 'install' ? '更新未完成' : '无法打开下载链接', '请重新检查更新后重试。')
      showAction('重试', checkForUpdate)
    } finally {
      applying = false
      download.hidden = true
      dismiss.disabled = false
      if (dialog.open) dismiss.focus()
    }
  }

  async function checkForUpdate() {
    dismiss.focus()
    primary.hidden = true
    notes.hidden = true
    if (!installedVersion) current.textContent = '正在读取当前版本…'
    showStatus('正在检查更新…')
    try {
      installedVersion ??= await getVersion()
      if (!dialog.open) return
      current.textContent = '当前版本 ' + installedVersion
      const release = await check(installedVersion)
      // IPC 的检查可能在用户关窗后才返回，只允许本次打开的窗口消费结果。
      if (!dialog.open) return
      if (!release) {
        showStatus('已是最新版本')
        return
      }
      const installs = release.kind === 'install'
      showStatus('发现新版本 ' + release.version, installs
        ? '确认后将下载并校验安装包，安装完成后重启页屿。'
        : '确认后将在应用外打开下载链接。')
      notesBody.textContent = release.notes.trim() || '暂无发布说明。'
      notesBody.scrollTop = 0
      notes.hidden = false
      showAction(installs ? '安装更新' : '下载更新', () => apply(release))
    } catch {
      if (!dialog.open) return
      if (!installedVersion) current.textContent = '无法读取当前版本'
      showStatus('检查更新失败', '请检查网络连接，或稍后重试。')
      showAction('重试', checkForUpdate)
    }
  }

  dismiss.onclick = () => dialog.close()
  dialog.addEventListener('keydown', event => event.stopPropagation())
  dialog.addEventListener('cancel', event => { if (applying) event.preventDefault() })
  dialog.addEventListener('close', () => dialog.remove(), { once: true })
  document.body.append(dialog)
  dialog.showModal()
  void checkForUpdate()
}
