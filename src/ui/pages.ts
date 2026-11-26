import type { DialogPresenter } from './dialogs'
import { el } from './helpers'
import { icons } from './icons'

type Page = { section: HTMLElement; backButton: HTMLButtonElement; focus: Element | null; dispose?: () => void }
type Navigation = (current: HTMLElement | null, direction: 'forward' | 'back') => void

export function createPages(editor: HTMLElement, restoreFocus?: () => void, onNavigation?: Navigation) {
  const element = el('div', { className: 'yy-tool-pages', attrs: { hidden: '' } })
  const stack: Page[] = []

  function render(direction: 'forward' | 'back') {
    const current = stack.at(-1)
    element.hidden = !current
    // 保持编辑器挂载，返回后保留滚动、选区和未保存的正文。
    editor.inert = !!current
    editor.classList.toggle('yy-editor-covered', !!current)
    if (current) current.section.inert = false
    element.replaceChildren(...(current ? [current.section] : []))
    onNavigation?.(current?.section ?? null, direction)
  }

  function push(label: string, content: HTMLElement, dispose?: () => void) {
    const backButton = el('button', {
      type: 'button', className: 'yy-tool-page-back yy-icon-btn', html: icons.chevronLeft,
      attrs: { 'aria-label': '返回', title: '返回' },
    })
    const section = el('section', { className: 'yy-tool-page yy-chrome', attrs: { 'aria-label': label } },
      el('header', { className: 'yy-tool-page-header' }, backButton, el('h2', { text: label })),
      el('div', { className: 'yy-tool-page-body' }, content))
    backButton.addEventListener('click', back)
    stack.push({ section, backButton, focus: document.activeElement, dispose })
    render('forward')
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
    render('back')
    page.dispose?.()
    if (page.focus instanceof HTMLElement && page.focus.isConnected) page.focus.focus({ preventScroll: true })
    if (!editor.contains(document.activeElement) && !element.contains(document.activeElement)) {
      if (stack.length) stack.at(-1)!.backButton.focus({ preventScroll: true })
      else restoreFocus?.()
    }
    return true
  }

  function previewBack() {
    const current = stack.at(-1)
    if (!current) return null
    const previous = stack.at(-2)?.section
    // 手势期间只显示上一层的内容，焦点和点击仍留在当前页。
    if (previous) {
      previous.inert = true
      element.prepend(previous)
    } else editor.classList.remove('yy-editor-covered')
    return {
      element: current.section,
      restore() {
        if (stack.at(-1) !== current) return
        previous?.remove()
        editor.classList.add('yy-editor-covered')
      },
    }
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

  return { element, open, push, back, present, previewBack, get active() { return stack.at(-1)?.section ?? null } }
}
