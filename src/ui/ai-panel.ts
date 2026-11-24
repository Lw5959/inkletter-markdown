import type { AiIntent, AiScope, AiView, ShellAction, Suggestion } from '../contracts'
import { el, groupDiffParts } from './helpers'
import { icons } from './icons'

export const AI_INTENTS: readonly { id: AiIntent; label: string; placeholder: string }[] = [
  { id: 'chat', label: '对话', placeholder: '输入问题或写作需求… (⌘/Ctrl+Enter 发送)' },
  { id: 'outline', label: '大纲', placeholder: '补充主题、读者或章节要求（可留空直接生成大纲）…' },
  { id: 'draft', label: '起草', placeholder: '描述要起草的段落主题与要点…' },
  { id: 'continue', label: '续写', placeholder: '指定续写方向或语气（可留空沿当前上下文续写）…' },
  { id: 'rewrite', label: '改写', placeholder: '指定改写风格或目标（如更精炼、更正式）…' },
  { id: 'polish', label: '润色', placeholder: '补充润色偏好（可留空直接润色语言表达）…' },
  { id: 'summary', label: '摘要', placeholder: '指定摘要长度或重点（可留空直接提炼要点）…' },
  { id: 'translate', label: '翻译', placeholder: '指定目标语言与术语偏好（例如：译为英文）…' },
  { id: 'proofread', label: '校对', placeholder: '补充校对重点（错别字、标点、逻辑一致性等）…' },
]

export const AI_SCOPES: readonly { id: AiScope; label: string }[] = [
  { id: 'selection', label: '当前选区' },
  { id: 'paragraph', label: '当前段落' },
  { id: 'document', label: '全文' },
  { id: 'files', label: '指定文件' },
]

export interface AiPanelOptions {
  dispatch: (action: ShellAction) => void
  onSuggestionFocus?: () => void
}

export class AiPanel {
  readonly element: HTMLElement
  private view: AiView = {
    settings: { endpoint: '', model: '', hasKey: false },
    context: null,
    messages: [],
    stream: '',
    pending: false,
    error: '',
    suggestion: null,
    canRetry: false,
  }

  private selectedIntent: AiIntent = 'chat'
  private configOpen = false
  private contextExpanded = true
  private activeSuggestionId: string | null = null
  private selectedHunks = new Set<number>()

  // DOM refs
  private configToggleBtn!: HTMLButtonElement
  private configStatusEl!: HTMLElement
  private configForm!: HTMLFormElement
  private endpointInput!: HTMLInputElement
  private modelInput!: HTMLInputElement
  private keyInput!: HTMLInputElement
  private keyHintEl!: HTMLElement

  private scopeButtons = new Map<AiScope, HTMLButtonElement>()
  private contextPreviewWrap!: HTMLElement
  private intentButtons = new Map<AiIntent, HTMLButtonElement>()
  private errorBanner!: HTMLElement
  private suggestionWrap!: HTMLElement
  private messagesWrap!: HTMLElement
  private promptInput!: HTMLTextAreaElement
  private sendBtn!: HTMLButtonElement
  private cancelBtn!: HTMLButtonElement
  private retryBtn!: HTMLButtonElement
  private clearBtn!: HTMLButtonElement

  constructor(private options: AiPanelOptions) {
    this.element = el('div', {
      className: 'yy-pane yy-ai-pane',
      attrs: { role: 'tabpanel', 'aria-label': 'AI 写作助手' },
    })

    const header = this.buildHeader()
    const configSection = this.buildConfigSection()
    const contextSection = this.buildContextSection()
    const intentsSection = this.buildIntentsSection()

    this.errorBanner = el('div', { className: 'yy-alert yy-alert-error', attrs: { role: 'alert', hidden: '' } })
    this.suggestionWrap = el('div', { className: 'yy-suggestion-host', attrs: { hidden: '' } })
    this.messagesWrap = el('div', {
      className: 'yy-scroll-area yy-ai-messages',
      attrs: { 'aria-live': 'polite', 'aria-label': 'AI 会话记录' },
    })
    const composer = this.buildComposer()

    this.element.append(
      header,
      configSection,
      contextSection,
      intentsSection,
      this.errorBanner,
      this.suggestionWrap,
      this.messagesWrap,
      composer,
    )
    this.render()
  }

  private buildHeader(): HTMLElement {
    const row = el('div', { className: 'yy-subbar' })
    this.configStatusEl = el('div', { className: 'yy-ai-model-badge', text: '未配置模型' })

    const right = el('div', { className: 'yy-row-gap' })
    this.clearBtn = el('button', {
      className: 'yy-btn yy-btn-xs yy-btn-ghost',
      type: 'button',
      text: '清空会话',
    })
    this.clearBtn.addEventListener('click', () => this.options.dispatch({ type: 'ai-clear' }))

    this.configToggleBtn = el('button', {
      className: 'yy-btn yy-btn-xs',
      type: 'button',
      attrs: { 'aria-expanded': 'false' },
    })
    this.configToggleBtn.append(el('span', { className: 'yy-icon', html: icons.settings }), el('span', { text: '接口配置' }))
    this.configToggleBtn.addEventListener('click', () => {
      this.configOpen = !this.configOpen
      this.syncConfigVisibility()
    })

    right.append(this.clearBtn, this.configToggleBtn)
    row.append(this.configStatusEl, right)
    return row
  }

  private buildConfigSection(): HTMLElement {
    this.configForm = el('form', { className: 'yy-card yy-config-card', attrs: { hidden: '' } })

    const epLabel = el('label', { className: 'yy-field' })
    epLabel.append(el('span', { className: 'yy-field-label', text: '接口地址 (Endpoint)' }))
    this.endpointInput = el('input', {
      className: 'yy-input yy-input-sm',
      type: 'url',
      attrs: { placeholder: '例如：https://api.openai.com/v1 或 http://127.0.0.1:11434/v1' },
    })
    epLabel.append(this.endpointInput)

    const modelLabel = el('label', { className: 'yy-field' })
    modelLabel.append(el('span', { className: 'yy-field-label', text: '模型名称 (Model)' }))
    this.modelInput = el('input', {
      className: 'yy-input yy-input-sm',
      type: 'text',
      attrs: { placeholder: '例如：gpt-4.1-mini / qwen2.5:14b' },
    })
    modelLabel.append(this.modelInput)

    const keyLabel = el('label', { className: 'yy-field' })
    const keyHead = el('div', { className: 'yy-field-head' })
    keyHead.append(el('span', { className: 'yy-field-label', text: 'API 密钥（可选）' }))
    this.keyHintEl = el('span', { className: 'yy-badge', text: '未设置密钥' })
    keyHead.append(this.keyHintEl)
    this.keyInput = el('input', {
      className: 'yy-input yy-input-sm',
      type: 'password',
      attrs: { placeholder: '本地模型可留空；留空保存则沿用已存密钥', autocomplete: 'off' },
    })
    keyLabel.append(keyHead, this.keyInput)

    const actions = el('div', { className: 'yy-card-actions' })
    const cancelBtn = el('button', { className: 'yy-btn yy-btn-xs', type: 'button', text: '收起' })
    cancelBtn.addEventListener('click', () => {
      this.configOpen = false
      this.syncConfigVisibility()
    })
    const saveBtn = el('button', { className: 'yy-btn yy-btn-xs yy-btn-primary', type: 'submit', text: '保存配置' })
    actions.append(cancelBtn, saveBtn)

    this.configForm.addEventListener('submit', event => {
      event.preventDefault()
      const endpoint = this.endpointInput.value.trim()
      const model = this.modelInput.value.trim()
      const key = this.keyInput.value.trim()
      this.options.dispatch({
        type: 'ai-config',
        endpoint,
        model,
        ...(key ? { key } : {}),
      })
      this.keyInput.value = ''
      this.configOpen = false
      this.syncConfigVisibility()
    })

    this.configForm.append(epLabel, modelLabel, keyLabel, actions)
    return this.configForm
  }

  private buildContextSection(): HTMLElement {
    const section = el('section', { className: 'yy-section', attrs: { 'aria-label': 'AI 上下文范围' } })
    const head = el('div', { className: 'yy-section-head' })
    head.append(el('span', { className: 'yy-section-title', text: '上下文范围' }))

    const scopeBar = el('div', { className: 'yy-chip-row' })
    for (const scope of AI_SCOPES) {
      const btn = el('button', {
        className: 'yy-chip',
        type: 'button',
        text: scope.label,
        attrs: { 'data-ai-scope': scope.id, 'aria-pressed': 'false' },
      })
      btn.addEventListener('click', () => {
        this.options.dispatch({ type: 'ai-context', scope: scope.id })
      })
      this.scopeButtons.set(scope.id, btn)
      scopeBar.append(btn)
    }

    this.contextPreviewWrap = el('div', { className: 'yy-context-preview-host' })
    section.append(head, scopeBar, this.contextPreviewWrap)
    return section
  }

  private buildIntentsSection(): HTMLElement {
    const section = el('section', { className: 'yy-section', attrs: { 'aria-label': 'AI 操作类型' } })
    const head = el('div', { className: 'yy-section-head' })
    head.append(el('span', { className: 'yy-section-title', text: '写作操作（九类）' }))

    const grid = el('div', { className: 'yy-intent-grid' })
    for (const intent of AI_INTENTS) {
      const btn = el('button', {
        className: `yy-intent-btn${intent.id === this.selectedIntent ? ' is-active' : ''}`,
        type: 'button',
        text: intent.label,
        attrs: { 'data-ai-intent': intent.id, 'aria-pressed': String(intent.id === this.selectedIntent) },
      })
      btn.addEventListener('click', () => {
        this.selectedIntent = intent.id
        this.syncIntents()
        this.promptInput.focus()
      })
      this.intentButtons.set(intent.id, btn)
      grid.append(btn)
    }
    section.append(head, grid)
    return section
  }

  private buildComposer(): HTMLElement {
    const form = el('form', { className: 'yy-ai-composer' })
    this.promptInput = el('textarea', {
      className: 'yy-textarea',
      attrs: {
        rows: '3',
        placeholder: AI_INTENTS[0].placeholder,
        'aria-label': 'AI 指令输入',
      },
    })
    this.promptInput.addEventListener('keydown', event => {
      if (event.isComposing) return
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        this.submitPrompt()
      }
    })

    const bar = el('div', { className: 'yy-composer-bar' })
    const leftBtns = el('div', { className: 'yy-row-gap' })
    this.cancelBtn = el('button', {
      className: 'yy-btn yy-btn-sm yy-btn-danger',
      type: 'button',
      attrs: { hidden: '' },
    })
    this.cancelBtn.append(el('span', { className: 'yy-icon', html: icons.stop }), el('span', { text: '取消' }))
    this.cancelBtn.addEventListener('click', () => this.options.dispatch({ type: 'ai-cancel' }))

    this.retryBtn = el('button', {
      className: 'yy-btn yy-btn-sm',
      type: 'button',
      attrs: { hidden: '' },
    })
    this.retryBtn.append(el('span', { className: 'yy-icon', html: icons.refresh }), el('span', { text: '重试' }))
    this.retryBtn.addEventListener('click', () => this.options.dispatch({ type: 'ai-retry' }))
    leftBtns.append(this.cancelBtn, this.retryBtn)

    this.sendBtn = el('button', { className: 'yy-btn yy-btn-sm yy-btn-primary', type: 'submit' })
    this.sendBtn.append(el('span', { className: 'yy-icon', html: icons.send }), el('span', { text: '发送' }))

    bar.append(leftBtns, this.sendBtn)
    form.addEventListener('submit', event => {
      event.preventDefault()
      this.submitPrompt()
    })
    form.append(this.promptInput, bar)
    return form
  }

  private submitPrompt() {
    if (this.view.pending) return
    const prompt = this.promptInput.value.trim()
    if (!prompt && this.selectedIntent === 'chat') {
      this.promptInput.focus()
      return
    }
    this.options.dispatch({ type: 'ai-send', intent: this.selectedIntent, prompt })
    this.promptInput.value = ''
  }

  private syncConfigVisibility() {
    this.configForm.toggleAttribute('hidden', !this.configOpen)
    this.configToggleBtn.setAttribute('aria-expanded', String(this.configOpen))
    if (this.configOpen) {
      this.endpointInput.value = this.view.settings.endpoint
      this.modelInput.value = this.view.settings.model
      this.keyInput.value = ''
      queueMicrotask(() => this.endpointInput.focus())
    }
  }

  private syncIntents() {
    for (const def of AI_INTENTS) {
      const btn = this.intentButtons.get(def.id)
      const active = def.id === this.selectedIntent
      btn?.classList.toggle('is-active', active)
      btn?.setAttribute('aria-pressed', String(active))
      if (active) this.promptInput.placeholder = def.placeholder
    }
  }

  setView(view: AiView) {
    const prevSuggestionId = this.activeSuggestionId
    this.view = view
    if (view.suggestion) {
      if (view.suggestion.id !== prevSuggestionId) {
        this.activeSuggestionId = view.suggestion.id
        const { hunkIds } = groupDiffParts(view.suggestion)
        this.selectedHunks = new Set(hunkIds)
        this.options.onSuggestionFocus?.()
      }
    } else {
      this.activeSuggestionId = null
      this.selectedHunks.clear()
    }
    this.render()
  }

  private render() {
    const { settings, context, messages, stream, pending, error, suggestion, canRetry } = this.view

    // Settings summary
    if (settings.model || settings.endpoint) {
      this.configStatusEl.textContent = settings.model || settings.endpoint
      this.configStatusEl.title = `${settings.endpoint || '未设地址'} · ${settings.model || '未设模型'}`
    } else {
      this.configStatusEl.textContent = '未配置模型接口'
      this.configStatusEl.title = '点击右侧接口配置填写地址与模型'
    }
    this.keyHintEl.textContent = settings.hasKey ? '已配置密钥' : '未设置密钥'
    this.keyHintEl.classList.toggle('is-success', settings.hasKey)
    if (!this.configOpen) {
      this.endpointInput.value = settings.endpoint
      this.modelInput.value = settings.model
    }

    // Context scope active chips & full-text preview
    for (const scope of AI_SCOPES) {
      const btn = this.scopeButtons.get(scope.id)
      const active = context?.scope === scope.id
      btn?.classList.toggle('is-active', active)
      btn?.setAttribute('aria-pressed', String(active))
    }
    this.renderContextPreview()

    // Error banner
    this.errorBanner.textContent = error
    this.errorBanner.toggleAttribute('hidden', !error)

    // Diff suggestion card
    this.renderSuggestion(suggestion)

    // Messages + Stream
    this.messagesWrap.replaceChildren()
    if (messages.length === 0 && !stream && !pending) {
      this.messagesWrap.append(
        el('div', {
          className: 'yy-empty-box yy-ai-empty',
          text: '选择上下文与写作操作，或直接输入指令开始协作。支持全部或逐段应用修改差异。',
        }),
      )
    } else {
      for (const msg of messages) {
        const bubble = el('article', { className: `yy-msg yy-msg-${msg.role}` })
        bubble.append(
          el('div', { className: 'yy-msg-role', text: msg.role === 'user' ? '你' : '页屿 AI' }),
          el('div', { className: 'yy-msg-body', text: msg.text }),
        )
        this.messagesWrap.append(bubble)
      }
      if (pending || stream) {
        const streaming = el('article', { className: 'yy-msg yy-msg-assistant is-streaming' })
        streaming.append(
          el('div', { className: 'yy-msg-role', text: pending ? '页屿 AI · 生成中…' : '页屿 AI' }),
          el('div', { className: 'yy-msg-body', text: stream || '正在思考与生成…' }),
        )
        this.messagesWrap.append(streaming)
      }
      this.messagesWrap.scrollTop = this.messagesWrap.scrollHeight
    }

    // Composer controls
    this.cancelBtn.toggleAttribute('hidden', !pending)
    this.retryBtn.toggleAttribute('hidden', pending || !canRetry)
    this.sendBtn.disabled = pending
    this.clearBtn.disabled = pending || (messages.length === 0 && !stream)
  }

  private renderContextPreview() {
    this.contextPreviewWrap.replaceChildren()
    const ctx = this.view.context
    if (!ctx) return

    const card = el('div', { className: 'yy-context-card' })
    const head = el('div', { className: 'yy-context-head' })
    const scopeName = AI_SCOPES.find(s => s.id === ctx.scope)?.label ?? ctx.scope
    const titleGroup = el('div', { className: 'yy-context-meta' })
    titleGroup.append(
      el('span', { className: 'yy-badge is-accent', text: scopeName }),
      el('span', { className: 'yy-context-label', text: ctx.label, title: ctx.label }),
      el('span', { className: 'yy-muted-note', text: `${ctx.text.length} 字符` }),
    )

    const controls = el('div', { className: 'yy-row-gap' })
    const toggleBtn = el('button', {
      className: 'yy-btn yy-btn-xs yy-btn-ghost',
      type: 'button',
      text: this.contextExpanded ? '收起全文' : '展开全文',
    })
    toggleBtn.addEventListener('click', () => {
      this.contextExpanded = !this.contextExpanded
      this.renderContextPreview()
    })

    const clearBtn = el('button', {
      className: 'yy-icon-btn yy-icon-btn-xs',
      type: 'button',
      html: icons.close,
      title: '清除上下文',
      attrs: { 'aria-label': '清除上下文' },
    })
    clearBtn.addEventListener('click', () => this.options.dispatch({ type: 'ai-context-clear' }))

    controls.append(toggleBtn, clearBtn)
    head.append(titleGroup, controls)
    card.append(head)

    if (this.contextExpanded) {
      const preview = el('pre', {
        className: 'yy-context-fulltext',
        text: ctx.text || '（上下文内容为空）',
        attrs: { 'aria-label': '上下文全文预览' },
      })
      card.append(preview)
    }

    this.contextPreviewWrap.append(card)
  }

  private renderSuggestion(suggestion: Suggestion | null) {
    this.suggestionWrap.replaceChildren()
    this.suggestionWrap.toggleAttribute('hidden', !suggestion)
    if (!suggestion) return

    const { blocks, hunkIds } = groupDiffParts(suggestion)
    const card = el('section', {
      className: 'yy-card yy-diff-card',
      attrs: { 'aria-label': '差异审阅建议' },
    })

    const head = el('div', { className: 'yy-diff-head' })
    const titleWrap = el('div', { className: 'yy-diff-title-wrap' })
    titleWrap.append(
      el('span', {
        className: `yy-badge ${suggestion.source === 'mcp' ? 'is-mcp' : 'is-accent'}`,
        text: suggestion.source === 'mcp' ? 'MCP 建议' : 'AI 建议',
      }),
      el('strong', { className: 'yy-diff-title', text: suggestion.title }),
      el('span', { className: 'yy-muted-note', text: `共 ${hunkIds.length} 段差异` }),
    )
    head.append(titleWrap)

    const diffBody = el('div', { className: 'yy-diff-body' })
    for (const block of blocks) {
      if (block.kind === 'context') {
        const text = block.parts.map(p => p.text).join('')
        if (text) {
          diffBody.append(el('pre', { className: 'yy-diff-keep', text }))
        }
        continue
      }
      const hunkId = block.hunkId ?? 0
      const hunkCard = el('div', {
        className: `yy-diff-hunk${this.selectedHunks.has(hunkId) ? ' is-selected' : ''}`,
        attrs: { 'data-hunk': String(hunkId) },
      })
      const hunkHead = el('div', { className: 'yy-diff-hunk-head' })
      const checkLabel = el('label', { className: 'yy-diff-check' })
      const checkbox = el('input', {
        type: 'checkbox',
        attrs: { 'aria-label': `选中第 ${hunkId + 1} 段差异` },
      })
      checkbox.checked = this.selectedHunks.has(hunkId)
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) this.selectedHunks.add(hunkId)
        else this.selectedHunks.delete(hunkId)
        this.renderSuggestion(suggestion)
      })
      checkLabel.append(checkbox, el('span', { text: `差异段 #${hunkId + 1}` }))

      const applySingleBtn = el('button', {
        className: 'yy-btn yy-btn-xs',
        type: 'button',
        text: '仅应用此段',
        attrs: { 'data-apply-hunk': String(hunkId) },
      })
      applySingleBtn.addEventListener('click', () => {
        this.options.dispatch({ type: 'suggestion-apply', id: suggestion.id, hunks: [hunkId] })
      })

      hunkHead.append(checkLabel, applySingleBtn)

      const hunkLines = el('div', { className: 'yy-diff-hunk-lines' })
      for (const part of block.parts) {
        const prefix = part.kind === 'add' ? '+ ' : part.kind === 'remove' ? '- ' : '  '
        hunkLines.append(
          el('pre', {
            className: `yy-diff-part yy-diff-${part.kind}`,
            text: prefix + part.text,
          }),
        )
      }
      hunkCard.append(hunkHead, hunkLines)
      diffBody.append(hunkCard)
    }

    const footer = el('div', { className: 'yy-diff-actions' })
    const selectedList = hunkIds.filter(id => this.selectedHunks.has(id))

    const applyAllBtn = el('button', {
      className: 'yy-btn yy-btn-xs yy-btn-primary',
      type: 'button',
      text: '全部应用',
      attrs: { 'data-suggestion-action': 'apply-all' },
    })
    applyAllBtn.addEventListener('click', () => {
      this.options.dispatch({ type: 'suggestion-apply', id: suggestion.id, hunks: hunkIds })
    })

    const applySelectedBtn = el('button', {
      className: 'yy-btn yy-btn-xs',
      type: 'button',
      text: `应用所选 (${selectedList.length})`,
      attrs: { 'data-suggestion-action': 'apply-selected' },
    })
    applySelectedBtn.disabled = selectedList.length === 0
    applySelectedBtn.addEventListener('click', () => {
      if (selectedList.length > 0) {
        this.options.dispatch({ type: 'suggestion-apply', id: suggestion.id, hunks: selectedList })
      }
    })

    const dismissBtn = el('button', {
      className: 'yy-btn yy-btn-xs yy-btn-ghost',
      type: 'button',
      text: '忽略',
      attrs: { 'data-suggestion-action': 'dismiss' },
    })
    dismissBtn.addEventListener('click', () => {
      this.options.dispatch({ type: 'suggestion-dismiss', id: suggestion.id })
    })

    footer.append(applyAllBtn, applySelectedBtn, dismissBtn)
    card.append(head, diffBody, footer)
    this.suggestionWrap.append(card)
  }

  focusInput() {
    queueMicrotask(() => this.promptInput.focus())
  }
}
