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
  const child = window.open('about:blank', '_blank', `popup,width=${width},height=${height}`)
  if (!child) return null
  const doc = child.document
  if (!doc.body) { child.close(); return null }
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
  const end = (notify: boolean) => {
    if (closed) return
    closed = true
    observer.disconnect()
    window.clearInterval(watcher)
    child.removeEventListener('pagehide', nativeClose)
    if (owner && --modalWindows === 0) owner.inert = wasInert
    if (notify) options.onClose()
    if (!child.closed) child.close()
  }
  const nativeClose = () => end(true)
  const watcher = window.setInterval(() => { if (child.closed) nativeClose() }, 300)
  child.addEventListener('pagehide', nativeClose, { once: true })
  return { child, host, close: () => end(false) }
}
