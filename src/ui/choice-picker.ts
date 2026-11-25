import { el } from './helpers'
import { icons } from './icons'

export type ChoiceItem = { value: string; label: string; detail?: string }

let sequence = 0

export class ChoicePicker {
  private id = 'yy-options-' + ++sequence
  private label = el('span', { className: 'yy-picker-label', attrs: { id: this.id + '-value' } })
  private list = el('div', {
    className: 'yy-picker-list yy-chrome', attrs: { id: this.id, role: 'listbox' },
  })
  private items: ChoiceItem[] = []
  private active = -1
  private selection = ''
  readonly button: HTMLButtonElement

  constructor(
    label: string,
    private placeholder: string,
    private choose: (value: string) => void,
    { className = '', icon, minimumWidth = 180 }: { className?: string; icon?: string; minimumWidth?: number } = {},
  ) {
    this.minimumWidth = minimumWidth
    this.button = el('button', {
      type: 'button', className: 'yy-picker-trigger ' + className,
      attrs: {
        role: 'combobox', 'aria-label': label, 'aria-haspopup': 'listbox',
        'aria-controls': this.id, 'aria-expanded': 'false', 'aria-autocomplete': 'none',
        'aria-describedby': this.id + '-value',
      },
    })
    this.list.setAttribute('aria-label', label)
    if (icon) this.button.append(el('span', { className: 'yy-icon', html: icon, attrs: { 'aria-hidden': 'true' } }))
    this.button.append(this.label, el('span', { className: 'yy-icon yy-picker-arrow', html: icons.chevronDown, attrs: { 'aria-hidden': 'true' } }))
    this.renderLabel()
    this.button.addEventListener('click', () => this.list.isConnected ? this.close() : this.open())
    this.button.addEventListener('keydown', this.onKey)
    this.button.addEventListener('blur', () => this.close())
    // 下拉列表保留触发器的键盘焦点，用 aria-activedescendant 通知当前选项。
    this.list.addEventListener('pointerdown', event => event.preventDefault())
    this.list.addEventListener('click', event => {
      if (!(event.target instanceof Element)) return
      const item = event.target.closest<HTMLElement>('[role="option"]')
      if (item) this.accept(Number(item.dataset.index))
    })
  }

  private minimumWidth: number

  setItems(items: ChoiceItem[], selection = '') {
    this.close()
    this.items = items
    this.setValue(selection)
  }

  setValue(value: string) {
    this.selection = value
    this.renderLabel()
  }

  setDisabled(disabled: boolean) {
    this.button.setAttribute('aria-disabled', String(disabled))
    if (disabled) this.close()
  }

  private renderLabel() {
    const item = this.items.find(option => option.value === this.selection)
    const text = item ? [item.detail, item.label].filter(Boolean).join(' · ') : this.placeholder
    this.label.textContent = text
    this.button.title = text
  }

  private open(last = false) {
    if (this.button.matches(':disabled, [aria-disabled="true"]') || !this.items.length) return
    const root = this.button.closest('.yy-modal') ?? this.button.closest('.yy-shell')
    if (!root) return
    this.button.focus({ preventScroll: true })
    const selected = this.items.findIndex(item => item.value === this.selection)
    this.list.replaceChildren(...this.items.map((item, index) => {
      const text = el('span', { className: 'yy-picker-option-text' }, el('span', { text: item.label }))
      if (item.detail) text.append(el('small', { text: item.detail }))
      return el('div', {
        className: 'yy-picker-option',
        attrs: { id: this.id + '-' + index, role: 'option', 'aria-selected': String(index === selected), 'data-index': String(index) },
      }, text, el('span', { className: 'yy-icon', html: icons.check, attrs: { 'aria-hidden': 'true' } }))
    }))
    // 固定定位避开滚动容器的裁切，弹窗中的选项仍属于该弹窗的无障碍树。
    root.append(this.list)
    this.button.setAttribute('aria-expanded', 'true')
    this.position()
    this.highlight(selected < 0 ? (last ? this.items.length - 1 : 0) : selected, true)
    document.addEventListener('pointerdown', this.outside, true)
    window.addEventListener('resize', this.position)
    window.addEventListener('scroll', this.position, true)
  }

  close() {
    if (!this.list.isConnected) return
    this.list.remove()
    this.button.setAttribute('aria-expanded', 'false')
    this.button.removeAttribute('aria-activedescendant')
    document.removeEventListener('pointerdown', this.outside, true)
    window.removeEventListener('resize', this.position)
    window.removeEventListener('scroll', this.position, true)
  }

  private outside = (event: Event) => {
    if (!(event.target instanceof Node) || this.button.contains(event.target) || this.list.contains(event.target)) return
    this.close()
  }

  private position = () => {
    if (!this.button.isConnected || this.button.closest('[inert], [hidden]')) {
      this.close()
      return
    }
    const anchor = this.button.getBoundingClientRect()
    const edge = 8
    const gap = 5
    const width = Math.min(window.innerWidth - edge * 2, Math.max(this.minimumWidth, anchor.width))
    const below = window.innerHeight - anchor.bottom - gap - edge
    const above = anchor.top - gap - edge
    const needed = Math.min(280, this.list.scrollHeight)
    const upward = below < needed && above > below
    this.list.style.width = `${width}px`
    this.list.style.left = `${Math.max(edge, Math.min(anchor.left, window.innerWidth - width - edge))}px`
    this.list.style.maxHeight = `${Math.max(0, Math.min(280, upward ? above : below))}px`
    this.list.style.top = upward ? '' : `${anchor.bottom + gap}px`
    this.list.style.bottom = upward ? `${window.innerHeight - anchor.top + gap}px` : ''
  }

  private highlight(index: number, scroll = false) {
    this.list.children[this.active]?.removeAttribute('data-highlighted')
    this.active = index
    const item = this.list.children[index]
    if (!item) return
    item.setAttribute('data-highlighted', '')
    this.button.setAttribute('aria-activedescendant', item.id)
    if (scroll) item.scrollIntoView({ block: 'nearest' })
  }

  private accept(index: number) {
    const item = this.items[index]
    this.close()
    if (item) this.choose(item.value)
  }

  private onKey = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey) return
    const open = this.list.isConnected
    const key = event.key
    if (!open) {
      if (key !== 'ArrowDown' && key !== 'ArrowUp') return
      event.preventDefault()
      event.stopPropagation()
      this.open(key === 'ArrowUp')
      return
    }
    if (key === 'Tab') { this.close(); return }
    const last = this.items.length - 1
    let next = this.active
    switch (key) {
      case 'Escape': this.close(); break
      case 'Enter':
      case ' ': this.accept(next); break
      case 'Home': next = 0; break
      case 'End': next = last; break
      case 'ArrowDown': next = Math.min(last, next + 1); break
      case 'ArrowUp': next = Math.max(0, next - 1); break
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
    if (next !== this.active && this.list.isConnected) this.highlight(next, true)
  }
}
