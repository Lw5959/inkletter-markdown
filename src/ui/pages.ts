import type { DialogPresenter } from './dialogs'
import { el } from './helpers'
import { icons } from './icons'

type Page = { title: string; content: HTMLElement; focus: Element | null; dispose?: () => void }

export function createPages(editor: HTMLElement, restoreFocus?: () => void) {
  const title = el('h2', { attrs: { id: 'yy-tool-page-title' } })
  const backButton = el('button', {
    type: 'button', className: 'yy-tool-page-back yy-icon-btn', html: icons.chevronLeft,
    attrs: { 'aria-label': '返回', title: '返回' },
  })
  const body = el('div', { className: 'yy-tool-page-body' })
  const element = el('section', {
    className: 'yy-tool-page yy-chrome', attrs: { hidden: '', 'aria-labelledby': 'yy-tool-page-title' },
  }, el('header', { className: 'yy-tool-page-header' }, backButton, title), body)
  const stack: Page[] = []

  function render() {
    const current = stack.at(-1)
    element.hidden = !current
    // 保持编辑器挂载，返回后保留滚动、选区和未保存的正文。
    editor.inert = !!current
    editor.classList.toggle('yy-editor-covered', !!current)
    title.textContent = current?.title ?? ''
    body.replaceChildren(...(current ? [current.content] : []))
    body.scrollTop = 0
  }

  function push(label: string, content: HTMLElement, dispose?: () => void) {
    stack.push({ title: label, content, focus: document.activeElement, dispose })
    render()
    // 打开页面时聚焦返回按钮，避免移动端自动弹出软键盘。
    backButton.focus({ preventScroll: true })
  }

  function open(label: string, content: HTMLElement, dispose?: () => void) {
    const focus = stack[0]?.focus ?? document.activeElement
    stack.splice(0).reverse().forEach(page => page.dispose?.())
    push(label, content, dispose)
    stack[0].focus = focus
  }

  function back() {
    const page = stack.pop()
    if (!page) return false
    render()
    page.dispose?.()
    if (page.focus instanceof HTMLElement && page.focus.isConnected) page.focus.focus({ preventScroll: true })
    if (!editor.contains(document.activeElement) && !element.contains(document.activeElement)) {
      if (stack.length) backButton.focus({ preventScroll: true })
      else restoreFocus?.()
    }
    return true
  }

  function present(navigate: 'open' | 'push' = 'open'): DialogPresenter {
    return {
      open(panel, options) {
        const label = panel.getAttribute('aria-label') ?? ''
        panel.removeAttribute('aria-label')
        panel.removeAttribute('role')
        panel.removeAttribute('aria-modal')
        panel.classList.add('yy-tool-page-panel')
        const show = navigate === 'push' ? push : open
        show(label, panel, options?.onClose)
      },
      close: () => { back() },
    }
  }

  backButton.addEventListener('click', back)
  return { element, open, push, back, present }
}
