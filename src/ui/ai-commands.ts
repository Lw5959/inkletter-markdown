import type { AiSkill } from '../contracts'
import { el } from './helpers'

const commands = [
  { name: '/compact', label: '压缩上下文', action: 'compact' },
  { name: '/new', label: '新建对话', action: 'new' },
  { name: '/model', label: '切换模型', action: 'model' },
  { name: '/context', label: '添加上下文', action: 'context' },
  { name: '/attach', label: '添加文件或图片', action: 'attach' },
  { name: '/skills', label: '写作技能', action: 'skills' },
  { name: '/help', label: '查看命令', action: 'help' },
] as const
export type AiCommand = (typeof commands)[number] | { name: string; label: string; action: 'skill'; skill: string }

export class AiCommands {
  readonly element = el('div', { className: 'yy-ai-commands', attrs: { id: 'yy-ai-command-list', role: 'listbox', 'aria-label': 'AI 命令', hidden: '' } })
  private matches: AiCommand[] = []
  private highlighted = 0
  private dismissed = false

  constructor(private input: HTMLTextAreaElement, private skills: () => AiSkill[], private choose: (command: AiCommand) => void) {
    input.setAttribute('aria-controls', this.element.id)
    input.setAttribute('aria-autocomplete', 'list')
  }

  private items(): AiCommand[] {
    return [...commands, ...this.skills().map(skill => ({
      name: '/skill ' + skill.name, label: skill.label ?? skill.description, action: 'skill' as const, skill: skill.name,
    }))]
  }

  exact(text: string) {
    const query = text.trim().toLowerCase()
    return query.startsWith('/') ? this.items().find(item => item.name === query) : undefined
  }

  refresh(blocked: boolean, reset = false) {
    if (reset) this.dismissed = false
    const query = this.input.value.trim().toLowerCase()
    this.matches = blocked || this.dismissed || !query.startsWith('/') || query.includes('\n')
      ? [] : this.items().filter(item => item.name.startsWith(query))
    this.element.hidden = !this.matches.length
    this.element.replaceChildren(...this.matches.map((item, index) => {
      const option = el('button', { type: 'button', className: 'yy-ai-command',
        attrs: { role: 'option', tabindex: '-1', id: this.element.id + '-' + index } },
      el('code', { text: item.name }), el('span', { text: item.label }))
      option.addEventListener('mousedown', event => event.preventDefault())
      option.addEventListener('click', () => this.choose(item))
      return option
    }))
    this.highlight(0)
  }

  hide() {
    this.dismissed = true
    this.refresh(false)
  }

  keydown(event: KeyboardEvent) {
    if (!this.matches.length || event.shiftKey || event.altKey) return false
    if (event.key === 'Escape') this.hide()
    else if (event.key === 'Enter') {
      if (!event.repeat) this.choose(this.matches[this.highlighted])
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const distance = event.key === 'ArrowUp' ? -1 : 1
      this.highlight((this.highlighted + distance + this.matches.length) % this.matches.length)
      this.element.children[this.highlighted]?.scrollIntoView({ block: 'nearest' })
    } else return false
    event.preventDefault()
    event.stopPropagation()
    return true
  }

  private highlight(index: number) {
    this.highlighted = index
    const selected = this.element.children[index]
    if (!selected) this.input.removeAttribute('aria-activedescendant')
    else this.input.setAttribute('aria-activedescendant', selected.id)
    for (const item of this.element.children) item.setAttribute('aria-selected', String(item === selected))
  }
}
