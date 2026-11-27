import { activeModel, detectedInputTokens, modelImageInput } from '../ai-models'
import { systemPrompt } from '../ai-prompts'
import type { AiIntent, AiSkill, AiView } from '../contracts'
import { el } from './helpers'

const number = new Intl.NumberFormat('zh-CN')
const tokens = (count: number) => number.format(count) + ' Token'

function estimate(text: string) {
  let ascii = 0
  let other = 0
  for (const character of text) {
    if (character.charCodeAt(0) < 128) ascii++
    else other++
  }
  return Math.ceil(ascii / 4) + other
}

export class AiBudget {
  private ring = el('span', { className: 'yy-ai-budget-ring', attrs: { 'aria-hidden': 'true' } })
  private label = el('span')
  private trigger = el('summary', { attrs: { 'aria-label': '上下文窗口' } }, this.ring, this.label)
  private values = el('div', { className: 'yy-ai-budget-values' })
  private detect = el('button', { type: 'button', className: 'yy-btn yy-btn-sm yy-btn-ghost', text: '获取模型规格' })
  private counts = new WeakMap<object, number>()
  readonly element = el('details', { className: 'yy-ai-budget', attrs: { hidden: '' } }, this.trigger,
    el('div', { className: 'yy-ai-budget-popover' }, el('strong', { text: '上下文窗口' }), this.values, this.detect))

  constructor(detect: () => Promise<unknown>) {
    this.detect.onclick = async () => {
      this.detect.disabled = true
      try { await detect() }
      finally { this.detect.disabled = false }
    }
    this.element.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this.element.open) {
        this.element.open = false
        this.trigger.focus()
        event.stopPropagation()
      }
    })
    this.element.addEventListener('focusout', event => {
      if (event.relatedTarget && !this.element.contains(event.relatedTarget as Node)) this.element.open = false
    })
  }

  private count(item: { text: string }) {
    let value = this.counts.get(item)
    if (value === undefined) {
      value = estimate(item.text) + 4
      this.counts.set(item, value)
    }
    return value
  }

  update(view: AiView, draft: string, intent: AiIntent, agent: boolean, skill?: AiSkill) {
    const model = activeModel(view.settings)
    this.element.hidden = !model
    if (!model) return
    const { options, selection } = model
    const summary = view.conversations?.summary
    const history = intent === 'actions' ? [] : view.messages.slice(view.conversations?.covered ?? 0)
    const binary = view.attachments?.filter(file => file.kind === 'binary').length ?? 0
    let used = estimate(draft) + estimate(systemPrompt(intent, view.prompts, agent, skill)) + 8
    // 智能体只在首轮传近期问答和材料目录，实际工具读到的内容由供应商计量。
    used += agent
      ? history.slice(-6).reduce((sum, item) => sum + estimate(item.text.slice(0, 2500)) + 4, 0)
      : history.reduce((sum, item) => sum + this.count(item), 0)
    if (summary && intent !== 'actions') used += this.count(summary)
    if (!agent || intent === 'actions') {
      if (view.context) used += this.count(view.context)
      for (const file of view.attachments ?? []) if (file.kind === 'text') used += this.count(file)
    }
    const input = options?.inputTokens ?? (options && detectedInputTokens(options))
    const output = options?.outputTokens ?? options?.detected?.outputTokens
    const total = options?.detected?.contextTokens
    const latest = view.messages.slice().reverse().find(item => item.usageModel === selection.model && item.usage?.length)
      ?.usage?.slice().reverse().find(item => item.inputTokens !== undefined)
    const fraction = input ? Math.min(1, used / input) : 0
    const remaining = input === undefined ? undefined : Math.max(0, input - used)
    const percent = input ? Math.round(used / input * 100) : null
    this.label.textContent = percent === null ? '容量' : percent + '%'
    this.ring.style.setProperty('--yy-context-fill', (fraction * 360) + 'deg')
    this.element.classList.toggle('yy-ai-budget-full', !!input && used >= input)
    const lines = [
      input ? `预计已用 ${tokens(used)} / ${tokens(input)}` : `预计已用 ${tokens(used)}，输入上限未知`,
      ...(remaining === undefined ? [] : [`预计剩余 ${tokens(remaining)}`]),
      ...(total ? [`模型总窗口 ${tokens(total)}`] : []),
      ...(output ? [`单次输出上限 ${tokens(output)}`] : []),
      ...(latest?.inputTokens === undefined ? [] : [`最近请求实测输入 ${tokens(latest.inputTokens)}`]),
      ...(binary || agent ? ['图片、文档版面和工具轮次的实际用量由模型服务统计。'] : []),
    ]
    this.trigger.title = lines[0]
    this.values.replaceChildren(...lines.map(text => el('span', { text })))
    this.detect.hidden = !!input && !!output && modelImageInput(options) !== undefined
  }
}
