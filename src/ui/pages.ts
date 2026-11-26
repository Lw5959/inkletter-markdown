import type { DialogPresenter } from './dialogs'
import { el } from './helpers'
import { icons } from './icons'

type Page = {
  section: HTMLElement
  backButton: HTMLButtonElement
  heading: HTMLElement
  body: HTMLElement
  focus: Element | null
  scroll: number
  dispose?: () => void
}
type Navigation = (current: HTMLElement | null, direction: 'forward' | 'back') => void

export function createPages(editor: HTMLElement, restoreFocus?: () => void, onNavigation?: Navigation) {
  const element = el('div', { className: 'yy-tool-pages', attrs: { hidden: '' } })
  const stack: Page[] = []
  const scroller = (page: Page) => page.body.querySelector<HTMLElement>('[data-page-scroll]') ?? page.body

  function render(direction: 'forward' | 'back') {
    const current = stack.at(-1)
    element.hidden = !current
    // 保持编辑器挂载，返回后保留滚动、选区和未保存的正文。
    editor.inert = !!current
    editor.classList.toggle('yy-editor-covered', !!current)
    if (current) current.section.inert = false
    element.replaceChildren(...(current ? [current.section] : []))
    if (current) scroller(current).scrollTop = current.scroll
    onNavigation?.(current?.section ?? null, direction)
  }

  function push(label: string, content: HTMLElement, dispose?: () => void) {
    const parent = stack.at(-1)
    // 二级页面打开前保存菜单滚动位置，返回及手势预览时复用。
    if (parent) parent.scroll = scroller(parent).scrollTop
    const backButton = el('button', {
      type: 'button', className: 'yy-tool-page-back yy-icon-btn', html: icons.chevronLeft,
      attrs: { 'aria-label': '返回', title: '返回' },
    })
    const heading = el('h2', { text: label })
    const body = el('div', { className: 'yy-tool-page-body' }, content)
    const section = el('section', { className: 'yy-tool-page yy-chrome', attrs: { 'aria-label': label } },
      el('header', { className: 'yy-tool-page-header' }, backButton, heading), body)
    backButton.addEventListener('click', back)
    stack.push({ section, backButton, heading, body, focus: document.activeElement, scroll: 0, dispose })
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

  function replace(label: string, content: HTMLElement, dispose?: () => void) {
    const page = stack.at(-1)
    if (!page) return push(label, content, dispose)
    // 加载完成或切换工具内容时更新当前页，复用原来的返回入口。
    page.dispose?.()
    page.dispose = dispose
    page.section.setAttribute('aria-label', label)
    page.heading.textContent = label
    page.body.replaceChildren(content)
    page.scroll = scroller(page).scrollTop = 0
    page.backButton.focus({ preventScroll: true })
  }

  function dismiss(removed: Page[]) {
    const first = removed[0]
    if (!first) return false
    render('back')
    removed.reverse().forEach(page => page.dispose?.())
    if (first.focus instanceof HTMLElement && first.focus.isConnected) first.focus.focus({ preventScroll: true })
    if (!editor.contains(document.activeElement) && !element.contains(document.activeElement)) {
      if (stack.length) stack.at(-1)!.backButton.focus({ preventScroll: true })
      else restoreFocus?.()
    }
    return true
  }

  function back() { return dismiss(stack.splice(-1)) }
  function closeAll() { return dismiss(stack.splice(0)) }

  function previewBack() {
    const current = stack.at(-1)
    if (!current) return null
    const previous = stack.at(-2)
    // 手势期间只显示上一层的内容，焦点和点击仍留在当前页。
    if (previous) {
      previous.section.inert = true
      element.prepend(previous.section)
      scroller(previous).scrollTop = previous.scroll
    } else editor.classList.remove('yy-editor-covered')
    return {
      element: current.section,
      restore() {
        if (stack.at(-1) !== current) return
        previous?.section.remove()
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

  return { element, open, push, replace, back, closeAll, present, previewBack, get active() { return stack.at(-1)?.section ?? null } }
}
