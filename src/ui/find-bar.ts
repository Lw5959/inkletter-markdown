import type { FindQuery, ShellAction } from '../contracts'
import { el } from './helpers'
import { icons } from './icons'

export interface FindBarOptions {
  dispatch: (action: ShellAction) => void
  onClose: () => void
}

export class FindBar {
  readonly element: HTMLElement
  private findInput: HTMLInputElement
  private replaceInput: HTMLInputElement
  private replaceRow: HTMLElement
  private expandReplaceBtn: HTMLButtonElement
  private caseBtn: HTMLButtonElement
  private wordBtn: HTMLButtonElement
  private regexBtn: HTMLButtonElement

  private isOpen = false
  private replaceVisible = false
  private matchCase = false
  private wholeWord = false
  private regex = false

  constructor(private options: FindBarOptions) {
    this.element = el('section', {
      className: 'yy-findbar yy-chrome',
      attrs: { role: 'region', 'aria-label': '文内查找与替换', hidden: '' },
    })

    const topRow = el('div', { className: 'yy-find-row' })
    this.expandReplaceBtn = el('button', {
      className: 'yy-icon-btn yy-icon-btn-sm',
      type: 'button',
      html: icons.chevronRight,
      title: '展开 / 收起替换',
      attrs: { 'aria-expanded': 'false', 'aria-label': '切换替换输入框' },
    })
    this.expandReplaceBtn.addEventListener('click', () => {
      this.setReplaceVisible(!this.replaceVisible)
      if (this.replaceVisible) this.replaceInput.focus()
    })

    this.findInput = el('input', {
      className: 'yy-input yy-input-sm yy-find-input',
      type: 'text',
      attrs: { placeholder: '查找内容…', 'aria-label': '查找文本' },
    })

    this.caseBtn = this.makeToggle('Aa', '区分大小写', () => {
      this.matchCase = !this.matchCase
      return this.matchCase
    })
    this.wordBtn = this.makeToggle('W', '全词匹配', () => {
      this.wholeWord = !this.wholeWord
      return this.wholeWord
    })
    this.regexBtn = this.makeToggle('.*', '正则表达式', () => {
      this.regex = !this.regex
      return this.regex
    })

    const prevBtn = el('button', {
      className: 'yy-icon-btn yy-icon-btn-sm',
      type: 'button',
      html: icons.chevronUp,
      title: '上一个匹配 (Shift+Enter)',
      attrs: { 'aria-label': '查找上一个' },
    })
    prevBtn.addEventListener('click', () => this.run('previous'))

    const nextBtn = el('button', {
      className: 'yy-icon-btn yy-icon-btn-sm',
      type: 'button',
      html: icons.chevronDown,
      title: '下一个匹配 (Enter)',
      attrs: { 'aria-label': '查找下一个' },
    })
    nextBtn.addEventListener('click', () => this.run('next'))

    const closeBtn = el('button', {
      className: 'yy-icon-btn yy-icon-btn-sm',
      type: 'button',
      html: icons.close,
      title: '关闭 (Esc)',
      attrs: { 'aria-label': '关闭查找替换' },
    })
    closeBtn.addEventListener('click', () => this.close())

    topRow.append(
      this.expandReplaceBtn,
      this.findInput,
      this.caseBtn,
      this.wordBtn,
      this.regexBtn,
      prevBtn,
      nextBtn,
      closeBtn,
    )

    this.replaceRow = el('div', { className: 'yy-find-row yy-replace-row', attrs: { hidden: '' } })
    this.replaceInput = el('input', {
      className: 'yy-input yy-input-sm yy-find-input',
      type: 'text',
      attrs: { placeholder: '替换为…', 'aria-label': '替换文本' },
    })
    const replaceBtn = el('button', {
      className: 'yy-btn yy-btn-sm',
      type: 'button',
      text: '替换',
    })
    replaceBtn.addEventListener('click', () => this.run('replace'))

    const replaceAllBtn = el('button', {
      className: 'yy-btn yy-btn-sm',
      type: 'button',
      text: '全部替换',
    })
    replaceAllBtn.addEventListener('click', () => this.run('replace-all'))

    this.replaceRow.append(el('span', { className: 'yy-find-spacer' }), this.replaceInput, replaceBtn, replaceAllBtn)

    this.findInput.addEventListener('keydown', event => {
      if (event.isComposing) return
      if (event.key === 'Enter') {
        event.preventDefault()
        this.run(event.shiftKey ? 'previous' : 'next')
      } else if (event.key === 'Escape') {
        event.preventDefault()
        this.close()
      }
    })

    this.replaceInput.addEventListener('keydown', event => {
      if (event.isComposing) return
      if (event.key === 'Enter') {
        event.preventDefault()
        this.run(event.metaKey || event.ctrlKey ? 'replace-all' : 'replace')
      } else if (event.key === 'Escape') {
        event.preventDefault()
        this.close()
      }
    })

    this.element.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        this.close()
      }
    })

    this.element.append(topRow, this.replaceRow)
  }

  private makeToggle(label: string, title: string, toggle: () => boolean): HTMLButtonElement {
    const btn = el('button', {
      className: 'yy-toggle-chip',
      type: 'button',
      text: label,
      title,
      attrs: { 'aria-pressed': 'false', 'aria-label': title },
    })
    btn.addEventListener('click', event => {
      const next = toggle()
      btn.classList.toggle('is-active', next)
      btn.setAttribute('aria-pressed', String(next))
      if (event.detail > 0) this.findInput.focus()
    })
    return btn
  }

  private getQuery(): FindQuery {
    return {
      text: this.findInput.value,
      replacement: this.replaceInput.value,
      regex: this.regex,
      matchCase: this.matchCase,
      wholeWord: this.wholeWord,
    }
  }

  private run(operation: 'next' | 'previous' | 'replace' | 'replace-all') {
    const query = this.getQuery()
    if (!query.text) {
      this.findInput.focus()
      return
    }
    this.options.dispatch({ type: 'find', query, operation })
  }

  private setReplaceVisible(visible: boolean) {
    this.replaceVisible = visible
    this.replaceRow.toggleAttribute('hidden', !visible)
    this.expandReplaceBtn.innerHTML = visible ? icons.chevronDown : icons.chevronRight
    this.expandReplaceBtn.setAttribute('aria-expanded', String(visible))
  }

  open(withReplace = false) {
    this.isOpen = true
    this.element.removeAttribute('hidden')
    this.setReplaceVisible(withReplace || this.replaceVisible)
    queueMicrotask(() => {
      this.findInput.focus()
      this.findInput.select()
    })
  }

  close() {
    if (!this.isOpen) return
    this.isOpen = false
    this.element.setAttribute('hidden', '')
    this.options.onClose()
  }

  get visible(): boolean {
    return this.isOpen
  }
}
