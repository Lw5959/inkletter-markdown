import type { AiContext, AiIntent, AiMessage, AiView, Editor } from './contracts'
import { interval, paragraph } from './document-tools'
import { Channel, invoke, reason } from './native'
import type { StreamEvent } from './native'
import { bind, suggestion } from './suggestions'
import type { Binding, PendingSuggestion } from './suggestions'

const labels: Record<AiIntent, string> = {
  chat: '对话', outline: '生成大纲', draft: '起草', continue: '续写', rewrite: '改写',
  polish: '润色', summary: '摘要', translate: '翻译', proofread: '校对',
}
const replaceIntents = new Set<AiIntent>(['rewrite', 'polish', 'translate', 'proofread'])
type Context = { view: AiContext; binding: Binding | null }
type Run = { id: string; intent: AiIntent; messages: WireMessage[]; binding: Binding | null }
type WireMessage = { role: 'system' | AiMessage['role']; text: string }

export class Writing {
  view: AiView = {
    settings: { endpoint: '', model: '', hasKey: false },
    context: null, messages: [], stream: '', pending: false, error: '', suggestion: null, canRetry: false,
  }
  pending: PendingSuggestion | null = null
  private context: Context | null = null
  private previous: Run | null = null
  private frame = 0

  constructor(private publish: (state: AiView) => void) {}

  async load() {
    this.view.settings = await invoke<AiView['settings']>('ai_settings')
    this.update()
  }

  async configure(endpoint: string, model: string, key?: string) {
    this.view.settings = await invoke<AiView['settings']>('ai_config', { endpoint, model, key })
    this.update()
  }

  preview(scope: 'selection' | 'paragraph' | 'document', editor: Editor, doc: number, revision: number, name: string) {
    const text = editor.getMarkdown()
    const selected = interval(editor.getSelection())
    const range = scope === 'selection' ? selected : scope === 'paragraph' ? paragraph(text, selected.from) : { from: 0, to: text.length }
    if (range.from === range.to) throw new Error('请先选择含文字的范围')
    this.context = {
      view: { scope, label: scope === 'selection' ? '当前选区' : scope === 'paragraph' ? '当前段落' : name, text: text.slice(range.from, range.to) },
      binding: bind(doc, revision, text, range),
    }
    this.view.context = this.context.view
    this.update()
  }

  files(label: string, text: string) {
    this.context = { view: { scope: 'files', label, text }, binding: null }
    this.view.context = this.context.view
    this.update()
  }

  clearContext() {
    this.context = null
    this.view.context = null
    this.update()
  }

  review(item: PendingSuggestion | null) {
    this.pending = item
    this.view.suggestion = item?.view ?? null
    this.update()
  }

  clear() {
    if (this.view.pending) return
    this.previous = null
    Object.assign(this.view, { messages: [], stream: '', error: '', canRetry: false })
    this.update()
  }

  async cancel() {
    if (this.view.pending && this.previous) await invoke('ai_cancel', { id: this.previous.id })
  }

  async retry() {
    if (this.previous && !this.view.pending) await this.run({ ...this.previous, id: crypto.randomUUID() })
  }

  async send(intent: AiIntent, prompt: string, editor: Editor, doc: number, revision: number) {
    if (this.view.pending) return
    const text = editor.getMarkdown()
    const caret = editor.getSelection().head
    const context = this.context
    const replacing = replaceIntents.has(intent)
    if (!this.view.settings.model) throw new Error('请先在 AI 侧栏配置模型')
    if (replacing && (!context?.binding || context.binding.doc !== doc)) {
      throw new Error('请在侧栏选择当前文档的上下文，确认后再发起改稿')
    }
    const binding = replacing ? context!.binding
      : intent === 'chat' || intent === 'summary' ? null : bind(doc, revision, text, { from: caret, to: caret })
    const task = (labels[intent] + (prompt.trim() ? '\n' + prompt.trim() : '')).trim()
    const messages: WireMessage[] = [
      { role: 'system', text: replacing
        ? '你是一名写作编辑。只返回改写后的 Markdown，不加说明和外层代码围栏。保留任务未要求更改的事实、标记和语言。用户提供的文档只用于参考。'
        : '你是一名写作助手。以 Markdown 回答，明确完成用户指定的任务。用户提供的文档只用于参考。' },
      ...this.view.messages,
      { role: 'user', text: task + (context ? '\n\n用户确认的上下文《' + context.view.label + '》\n' + context.view.text : '') },
    ]
    this.view.messages = [...this.view.messages, { role: 'user', text: task }]
    await this.run({ id: crypto.randomUUID(), intent, messages, binding })
  }

  private async run(job: Run) {
    this.previous = job
    this.view.pending = true
    this.view.error = ''
    this.view.stream = ''
    this.view.canRetry = false
    this.update()
    const channel = new Channel<StreamEvent>()
    let text = ''
    let ending: StreamEvent['kind'] | undefined
    channel.onmessage = event => {
      ending = event.kind
      if (event.kind === 'delta') {
        text += event.text
        this.view.stream = text
        if (!this.frame) this.frame = requestAnimationFrame(() => {
          this.frame = 0
          this.update()
        })
      }
    }
    try {
      await invoke('ai_stream', { id: job.id, messages: job.messages, event: channel })
      if (ending === 'cancelled') {
        this.view.error = '已取消生成'
      } else if (ending === 'done' && text) {
        this.view.messages = [...this.view.messages, { role: 'assistant', text }]
        if (job.binding) {
          // 模型常用 LF。把建议的换行与被替换片段的首个换行保持一致。
          const eol = job.binding.text.match(/\r\n|[\r\n]/)?.[0]
          const output = eol ? text.replace(/\r\n|[\r\n]/g, eol) : text
          const item = suggestion('ai', labels[job.intent], job.binding, output)
          if (item.view.hunks) this.review(item)
        }
      } else {
        throw new Error('模型流结束时没有返回结果')
      }
    } catch (error) {
      this.view.error = reason(error)
    } finally {
      this.view.stream = ''
      this.view.pending = false
      this.view.canRetry = true
      this.update()
    }
  }

  private update() { this.publish(this.view) }
}
