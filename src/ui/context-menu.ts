import { copyTextToClipboard, el } from './helpers'
import { icons } from './icons'

export type ContextCommand = {
  label: string
  icon?: string
  disabled?: boolean
} & ({ run: () => void } | { items: readonly ContextItem[] })
export type ContextItem = ContextCommand | null

const openMenus = new WeakMap<Document, (restore?: boolean) => void>()

export function closeContextMenu(document: Document, restore = false) {
  openMenus.get(document)?.(restore)
}

export function isContextMenuTarget(target: EventTarget | null) {
  return !!(target as Element | null)?.closest?.('.yy-context-menu')
}

function isContextMenuKey(event: KeyboardEvent) {
  return !event.isComposing && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
}

export function buttonCommand(label: string, button: HTMLButtonElement): ContextCommand {
  return {
    label, disabled: button.disabled,
    run: () => { if (button.isConnected && !button.closest('[hidden], [inert]')) button.click() },
  }
}

export function copyCommand(label: string, value: string, area: HTMLElement, notify?: (message: string) => void): ContextCommand {
  return {
    label, icon: icons.copy,
    run: async () => {
      const copied = await copyTextToClipboard(value, area.ownerDocument)
      notify?.(copied ? '已复制' : '复制失败，请重试')
    },
  }
}

export function selectedText(area: HTMLElement) {
  const selection = area.ownerDocument.getSelection()
  return selection?.anchorNode && selection.focusNode && area.contains(selection.anchorNode) && area.contains(selection.focusNode)
    ? selection.toString() : ''
}

export function bindContextMenu(
  area: HTMLElement,
  label: string,
  commands: (target: Element, point?: { x: number; y: number }) => readonly ContextItem[],
  trigger: HTMLElement | ((target: Element) => HTMLElement) = area,
  keyboard?: { target: HTMLElement; selected: () => Element | null },
) {
  function open(event: Event, point?: { x: number; y: number }, target = event.target as Element | null) {
    if (event.defaultPrevented || !target?.closest || target.closest('input, textarea, select, [inert], .yy-mobile')) return
    const items = commands(target, point)
    if (!items.some(Boolean)) return
    event.preventDefault()
    event.stopPropagation()
    const document = area.ownerDocument
    const window = document.defaultView!
    closeContextMenu(document)

    // 菜单跟随原生子窗口或弹窗，在视口内定位，避免被列表的滚动区裁掉。
    const host = area.closest('dialog[open], .app-dialog, .yy-modal') ?? area.closest('.yy-shell') ?? document.body
    const menu = el('div', { className: 'yy-context-menu yy-chrome', attrs: { role: 'menu', 'aria-label': label, tabindex: '-1' } })
    const events = new AbortController()
    const { signal } = events
    const observer = new MutationObserver(() => {
      if (!area.isConnected || area.closest('[hidden], [inert]')) close()
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'inert'] })
    const anchor = typeof trigger === 'function' ? trigger(target) : trigger
    const rect = (point ? anchor : target).getBoundingClientRect()
    const active = document.activeElement as HTMLElement | null
    let focusable: HTMLButtonElement[] = []
    let branch: ContextCommand | undefined

    function close(restore = false) {
      if (signal.aborted) return
      events.abort()
      observer.disconnect()
      openMenus.delete(document)
      menu.remove()
      if (anchor.getAttribute('aria-haspopup') === 'menu') anchor.removeAttribute('aria-expanded')
      if (!restore) return
      const to = !point && active && (area.contains(active) || keyboard?.target === active) ? active
        : anchor.matches('button:not(:disabled), summary, [tabindex], [contenteditable="true"]') ? anchor : active
      if (to?.isConnected) to.focus({ preventScroll: true })
    }

    function back() {
      const from = branch
      branch = undefined
      render(items, from)
    }

    function render(entries: readonly ContextItem[], focused?: ContextCommand) {
      focusable = []
      let focus: HTMLButtonElement | undefined
      menu.replaceChildren(...entries.map(command => {
        if (!command) return el('div', { className: 'yy-menu-sep', attrs: { role: 'separator' } })
        const item = el('button', {
          className: 'yy-menu-item', type: 'button', attrs: { role: 'menuitem', tabindex: '-1' },
        }, el('span', { className: 'yy-menu-label', text: command.label }))
        if (command.icon) item.prepend(el('span', { className: 'yy-menu-check', html: command.icon }))
        if ('items' in command) {
          item.setAttribute('aria-haspopup', 'menu')
          item.append(el('span', { className: 'yy-icon', html: icons.chevronRight }))
        }
        item.disabled = !!command.disabled
        if (!item.disabled) focusable.push(item)
        if (command === focused) focus = item
        item.addEventListener('click', () => {
          if ('items' in command) {
            branch = command
            render([{ label: '返回', icon: icons.chevronLeft, run: back }, null, ...command.items])
          } else if (command.run === back) {
            back()
          } else {
            close(true)
            command.run()
          }
        })
        return item
      }))
      const edge = 8
      menu.style.left = `${Math.max(edge, Math.min(point?.x ?? rect.left, window.innerWidth - menu.offsetWidth - edge))}px`
      menu.style.top = `${Math.max(edge, Math.min(point?.y ?? rect.bottom, window.innerHeight - menu.offsetHeight - edge))}px`
      menu.scrollTop = 0
      const first = focus ?? focusable[branch ? 1 : 0] ?? focusable[0] ?? menu
      first.focus({ preventScroll: true })
    }

    openMenus.set(document, close)
    host.append(menu)
    if (anchor.getAttribute('aria-haspopup') === 'menu') anchor.setAttribute('aria-expanded', 'true')
    function outside(event: Event) {
      if (!menu.contains(event.target as Node)) close()
    }
    document.addEventListener('pointerdown', outside, { capture: true, signal })
    document.addEventListener('focusin', outside, { signal })
    document.addEventListener('scroll', event => {
      if ((event.target as Node | null)?.contains?.(area)) close(true)
    }, { capture: true, signal })
    window.addEventListener('resize', () => close(true), { signal })
    window.addEventListener('blur', () => close(), { signal })
    menu.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation() })
    menu.addEventListener('keydown', event => {
      const index = focusable.indexOf(document.activeElement as HTMLButtonElement)
      let next = -1
      switch (event.key) {
        case 'Tab': close(true); return
        case 'Escape': branch ? back() : close(true); break
        case 'ArrowLeft': if (branch) back(); break
        case 'ArrowRight':
          if (focusable[index]?.getAttribute('aria-haspopup') === 'menu') focusable[index].click()
          break
        case 'Home': next = 0; break
        case 'End': next = focusable.length - 1; break
        case 'ArrowDown': next = (index + 1) % focusable.length; break
        case 'ArrowUp': next = index <= 0 ? focusable.length - 1 : index - 1; break
        default: return
      }
      event.preventDefault()
      event.stopPropagation()
      focusable[next]?.focus()
    })
    render(items)
  }

  area.addEventListener('contextmenu', event => open(event, event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined))
  area.addEventListener('keydown', event => { if (isContextMenuKey(event)) open(event) })
  keyboard?.target.addEventListener('keydown', event => {
    if (isContextMenuKey(event)) open(event, undefined, keyboard.selected())
  })
}
