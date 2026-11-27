import type { ModalManager } from './dialogs'
import { el } from './helpers'

export function createImagePreview(name: string, load: () => Promise<string>) {
  const status = el('p', { text: '正在载入图片…', attrs: { role: 'status' } })
  const image = el('img', { attrs: { alt: name, hidden: '' } })
  const frame = el('div', { className: 'yy-image-preview-frame' }, status, image)
  const detail = el('span', { className: 'yy-muted-note', attrs: { role: 'status' } })
  function failed() { status.textContent = '无法预览此图片，请确认文件可访问且格式受支持。' }
  image.addEventListener('load', () => {
    image.hidden = false
    status.hidden = true
    detail.textContent = `${image.naturalWidth} × ${image.naturalHeight}`
  })
  image.addEventListener('error', failed)
  void load().then(src => {
    if (!frame.isConnected) return
    if (src) image.src = src
    else failed()
  }, failed)
  return { frame, detail }
}

export function showImagePreview(modals: ModalManager, name: string, load: () => Promise<string>, reveal?: () => void) {
  const close = el('button', {
    className: 'yy-btn yy-btn-sm', type: 'button', text: '关闭', attrs: { 'aria-label': '关闭图片预览' },
  })
  close.addEventListener('click', () => modals.close())
  const { frame, detail } = createImagePreview(name, load)
  const footer = el('div', { className: 'yy-image-preview-footer' }, detail)
  const actions = el('div', { className: 'yy-image-preview-actions' })
  if (reveal) {
    const locate = el('button', { className: 'yy-btn yy-btn-sm', type: 'button', text: '在文件管理器中显示' })
    locate.addEventListener('click', reveal)
    actions.append(locate)
  }
  actions.append(close)
  footer.append(actions)
  const dialog = el('section', {
    className: 'yy-modal yy-image-preview', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '图片预览' },
  }, el('header', { className: 'yy-modal-header' }, el('h2', { text: name, title: name })), frame, footer)
  const document = dialog.ownerDocument
  modals.open(dialog, { initialFocus: dialog, size: [900, 680] })
  // 原生子窗口接管关闭操作。留在主窗口时使用弹窗底部的入口。
  if (dialog.ownerDocument !== document) close.remove()
}
