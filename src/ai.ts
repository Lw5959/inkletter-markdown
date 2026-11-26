import type { AiContext, AiIntent, AiMessage, AiModelDiscovery, AiPrompts, AiSettings, AiSelection, AiView, Editor, ShellAction } from './contracts'
import { aiTasks, systemPrompt } from './ai-prompts'
import { interval, paragraph } from './document-tools'
import { Channel, invoke, reason } from './native'
import type { StreamEvent } from './native'
import { bind, suggestion } from './suggestions'
import type { Binding, PendingSuggestion } from './suggestions'

type Context = { view: AiContext; binding: Binding | null }
type Run = { id: string; selection: AiSelection; intent: AiIntent; messages: WireMessage[]; binding: Binding | null }
type WireMessage = { role: 'system' | AiMessage['role']; text: string }
type ModelAction = Extract<ShellAction, { type: 'ai-provider-save' | 'ai-provider-remove' | 'ai-model-select' }>

export const listAiModels = (request: AiModelDiscovery) => invoke<string[]>('ai_list_models', { request })

export class Writing {
  view: AiView = {
    settings: { providers: [], active: null },
    prompts: {}, context: null, messages: [], stream: '', pending: false, error: '', suggestion: null, canRetry: false,
  }
  pending: PendingSuggestion | null = null
  private context: Context | null = null
  private previous: Run | null = null
  private frame = 0
  private configuring = false
  private conversations = new Map<string, AiMessage[]>()

  constructor(private publish: (state: AiView) => void) {}

  async load() {
    this.setSettings(await invoke<AiSettings>('ai_settings'))
  }

  async configure(action: ModelAction) {
    if (this.view.pending) throw new Error('请等待本次生成结束，或取消后再更改模型')
    if (this.configuring) throw new Error('模型配置正在保存')
    this.configuring = true
    try {
      const next = action.type === 'ai-provider-save'
        ? await invoke<AiSettings>('ai_provider_save', { provider: action.provider, key: action.key })
        : action.type === 'ai-provider-remove'
          ? await invoke<AiSettings>('ai_provider_remove', { id: action.id })
          : await invoke<AiSettings>('ai_model_select', { selection: action.selection })
      this.previous = null
      this.view.canRetry = false
      this.setSettings(next)
      return next.notice
    } finally {
      this.configuring = false
    }
  }

  private setSettings(next: AiSettings) {
    const prior = conversationKey(this.view.settings)
    const current = conversationKey(next)
    if (prior !== current) {
      // 换供应商或服务地址时使用独立会话，避免上传先前服务的对话内容。
      if (prior) this.conversations.set(prior, this.view.messages)
      this.view.messages = this.conversations.get(current) ?? []
      this.view.error = ''
    }
    const available = new Set(next.providers.map(provider => provider.id + '\n' + provider.endpoint))
    for (const key of this.conversations.keys()) {
      if (!available.has(key)) this.conversations.delete(key)
    }
    this.view.settings = next
    this.update()
  }

  setPrompts(prompts: AiPrompts) {
    this.view.prompts = prompts
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
    if (this.configuring) throw new Error('模型配置正在保存')
    if (this.previous && !this.view.pending) await this.run({ ...this.previous, id: crypto.randomUUID() })
  }

  async send(intent: AiIntent, prompt: string, editor: Editor, doc: number, revision: number) {
    if (this.view.pending) return
    if (this.configuring) throw new Error('模型配置正在保存')
    const text = editor.getMarkdown()
    const caret = editor.getSelection().head
    const context = this.context
    const replacing = aiTasks[intent].replaces
    const selection = this.view.settings.active
    if (!selection) throw new Error('请先在 AI 侧栏配置模型')
    if (replacing && (!context?.binding || context.binding.doc !== doc)) {
      throw new Error('请在侧栏选择当前文档的上下文，确认后再发起改稿')
    }
    const binding = replacing ? context!.binding
      : intent === 'chat' || intent === 'summary' ? null : bind(doc, revision, text, { from: caret, to: caret })
    const task = prompt.trim() || aiTasks[intent].label
    // 生成时固定提示词与已预览的文档快照，供本次请求和重试共用。
    const messages: WireMessage[] = [
      { role: 'system', text: systemPrompt(intent, this.view.prompts) },
      ...this.view.messages,
      { role: 'user', text: aiTasks[intent].label + (prompt.trim() ? '\n' + task : '') + (context ? '\n\n用户确认的上下文《' + context.view.label + '》\n' + context.view.text : '') },
    ]
    this.view.messages = [...this.view.messages, { role: 'user', text: task }]
    await this.run({ id: crypto.randomUUID(), selection, intent, messages, binding })
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
      await invoke('ai_stream', { id: job.id, selection: job.selection, messages: job.messages, event: channel })
      if (ending === 'cancelled') {
        this.view.error = '已取消生成'
      } else if (ending === 'done' && text) {
        this.view.messages = [...this.view.messages, { role: 'assistant', text }]
        if (job.binding) {
          // 模型常用 LF。把建议的换行与被替换片段的首个换行保持一致。
          const eol = job.binding.text.match(/\r\n|[\r\n]/)?.[0]
          const output = eol ? text.replace(/\r\n|[\r\n]/g, eol) : text
          const item = suggestion('ai', aiTasks[job.intent].label, job.binding, output)
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

function conversationKey(settings: AiSettings) {
  const provider = settings.providers.find(item => item.id === settings.active?.providerId)
  return provider ? provider.id + '\n' + provider.endpoint : ''
}
