import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { el } from './helpers'

type Options = {
  title: string
  width: number
  height: number
  modal?: boolean
  onClose: () => void
}

let modalWindows = 0
let wasInert = false

/** 在同源的原生子窗口挂载面板，继续使用发起窗口的文档状态和事件处理。 */
export function openDesktopWindow(content: HTMLElement, options: Options) {
  if (!Reflect.get(window, '__YEYU_DESKTOP_WINDOWS__')) return null
  const width = Math.min(options.width, screen.availWidth)
  const height = Math.min(options.height, screen.availHeight)
  const label = 'panel-' + crypto.randomUUID()
  const kind = options.modal ? 'yeyu-modal' : 'yeyu-tool'
  // WebKitGTK 不提供 window.open 的宽高，尺寸与窗口标识一并传给原生入口。
  const child = window.open(`about:blank#${kind}/${label}/${width}/${height}`, '_blank', 'popup')
  if (!child) return null
  const destroy = () => void invoke('desktop_panel_close', { label }).catch(() => {
    if (!child.closed) child.close()
  })
  const doc = child.document
  if (!doc.body) { destroy(); return null }
  doc.title = options.title
  doc.documentElement.lang = document.documentElement.lang || 'zh-CN'
  doc.documentElement.classList.add('yy-native-panel')
  for (const style of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
    const copy = doc.importNode(style, true)
    if (style instanceof HTMLLinkElement) (copy as HTMLLinkElement).href = style.href
    doc.head.append(copy)
  }
  const syncTheme = () => {
    const root = document.documentElement
    doc.documentElement.style.cssText = root.style.cssText
    for (const name of ['data-yeyu-theme', 'data-yeyu-appearance', 'data-yeyu-motion']) {
      const value = root.getAttribute(name)
      if (value === null) doc.documentElement.removeAttribute(name)
      else doc.documentElement.setAttribute(name, value)
    }
  }
  syncTheme()
  const observer = new MutationObserver(syncTheme)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [
    'style', 'data-yeyu-theme', 'data-yeyu-appearance', 'data-yeyu-motion',
  ] })
  const host = el('div', { className: 'yy-shell yy-native-panel-host' }, content)
  doc.body.replaceChildren(host)
  const owner = options.modal ? document.getElementById('app') : null
  if (owner) {
    if (!modalWindows) wasInert = owner.inert
    modalWindows++
    owner.inert = true
  }
  let closed = false
  let unlisten: (() => void) | undefined
  const end = (notify: boolean) => {
    if (closed) return
    closed = true
    observer.disconnect()
    unlisten?.()
    window.clearInterval(watcher)
    child.removeEventListener('pagehide', nativeClose)
    if (owner && --modalWindows === 0) owner.inert = wasInert
    destroy()
    if (notify) options.onClose()
  }
  const nativeClose = () => end(true)
  const watcher = window.setInterval(() => { if (child.closed) nativeClose() }, 300)
  child.addEventListener('pagehide', nativeClose, { once: true })
  // 系统关闭按钮从原生窗口事件回传，恢复编辑区焦点和弹窗状态。
  void getCurrentWindow().listen<string>('yeyu:panel-closed', ({ payload }) => {
    if (payload === label) nativeClose()
  }).then(stop => { if (closed) stop(); else unlisten = stop }).catch(() => {})
  return {
    child,
    host,
    close: () => end(false),
    setHeight: (height: number) => {
      if (!closed) void invoke('desktop_panel_resize', { label, height }).catch(() => {})
    },
  }
}
