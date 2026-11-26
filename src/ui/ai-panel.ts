import { aiIntents, aiTasks } from '../ai-prompts'
import type { AiContext, AiIntent, AiMessage, AiScope, AiSelection, AiSettings, AiView, ShellAction, ShellActions, Suggestion } from '../contracts'
import { openModelSettings, openPromptSettings } from './ai-settings'
import { ChoicePicker } from './choice-picker'
import type { DialogPresenter } from './dialogs'
import { el, groupDiffParts } from './helpers'
import { icons } from './icons'

const scopes: Record<AiScope, string> = {
  selection: '当前选区',
  paragraph: '当前段落',
  document: '全文',
  files: '指定文件',
}

interface AiPanelOptions {
  dispatch: ShellActions['dispatch']
  listAiModels?: ShellActions['listAiModels']
  modals: DialogPresenter
  onSuggestionFocus?: () => void
}

export class AiPanel {
  readonly element = el('div', {
    className: 'yy-pane yy-ai-pane',
    attrs: { role: 'tabpanel', 'aria-label': 'AI 写作助手' },
  })
  private view: AiView = {
    settings: { providers: [], active: null },
    prompts: {}, context: null, messages: [], stream: '', pending: false, error: '', suggestion: null, canRetry: false,
  }
  private shownMessages: AiMessage[] | null = null
  private shownSettings: AiSettings | null = null
  private shownContext: AiContext | null = null
  private activeSuggestionId: string | null = null
  private selectedHunks = new Set<number>()
  private submitting = false
  private actionError = ''
  private intent: AiIntent = 'chat'
  private changingModel = false

  private modelButton = el('button', {
    className: 'yy-btn yy-btn-sm yy-btn-ghost', type: 'button', text: '模型配置',
  })
  private clearButton = iconButton('清空会话', icons.trash)
  private retryButton = iconButton('重试上次请求', icons.refresh)
  private conversation = el('div', {
    className: 'yy-scroll-area yy-ai-conversation', attrs: { 'aria-label': 'AI 会话记录' },
  })
  private empty = el('div', { className: 'yy-ai-empty' })
  private emptyHint = el('p')
  private messages = el('div', { className: 'yy-ai-messages', attrs: { role: 'log' } })
  private generation = el('article', { className: 'yy-msg yy-msg-assistant', attrs: { hidden: '' } })
  private stream = el('div', { className: 'yy-msg-body' })
  private suggestionWrap = el('div', { className: 'yy-suggestion-host', attrs: { hidden: '' } })
  private errorBanner = el('div', { className: 'yy-ai-error', attrs: { role: 'alert', hidden: '' } })
  private contextHost = el('div', { className: 'yy-ai-context', attrs: { hidden: '' } })
  private contextDetails = el('details')
  private contextSummary = el('summary')
  private contextLabel = el('span')
  private contextPreview = el('pre', {
    className: 'yy-context-fulltext', attrs: { 'aria-label': '上下文全文预览', tabindex: '0' },
  })
  private promptInput = el('textarea', {
    className: 'yy-ai-input',
    attrs: { rows: '1', placeholder: aiTasks.chat.placeholder, 'aria-label': 'AI 指令输入' },
  })
  private modelOptions = new Map<string, AiSelection>()
  private modelPicker = new ChoicePicker('切换模型', '选择模型', value => { void this.selectModel(value) },
    { className: 'yy-ai-model-switch', minimumWidth: 225 })
  private taskPicker = new ChoicePicker('写作操作', aiTasks.chat.label, value => {
    this.intent = value as AiIntent
    this.taskPicker.setValue(value)
    this.promptInput.placeholder = aiTasks[this.intent].placeholder
    this.updateDraft()
  }, { className: 'yy-composer-picker' })
  private contextPicker = new ChoicePicker('添加上下文', '上下文', value => { void this.selectContext(value as AiScope) },
    { className: 'yy-composer-picker', icon: icons.plus })
  private sendButton = iconButton('发送', icons.arrowUp, 'yy-ai-send', 'submit')
  private cancelButton = iconButton('取消生成', icons.stop, 'yy-ai-send')

  constructor(private options: AiPanelOptions) {
    const header = el('div', { className: 'yy-ai-toolbar' })
    const settings = el('div', { className: 'yy-ai-toolbar-group' })
    const prompts = el('button', {
      className: 'yy-btn yy-btn-sm yy-btn-ghost', type: 'button', text: '默认提示词',
    })
    this.modelButton.addEventListener('click', () => this.openModels())
    prompts.addEventListener('click', () => {
      openPromptSettings(this.options.modals, this.view.prompts, this.intent, this.options.dispatch)
    })
    settings.append(this.modelButton, prompts)
    const actions = el('div', { className: 'yy-ai-toolbar-group' })
    this.clearButton.addEventListener('click', () => { void this.request({ type: 'ai-clear' }) })
    this.retryButton.addEventListener('click', () => { void this.request({ type: 'ai-retry' }) })
    actions.append(this.retryButton, this.clearButton)
    header.append(settings, actions)

    this.empty.append(
      el('span', { className: 'yy-ai-mark', html: icons.sparkles }),
      el('h2', { text: '写作助手' }),
      this.emptyHint,
    )
    this.generation.append(
      el('div', { className: 'yy-msg-role', text: '正在生成…', attrs: { role: 'status' } }),
      this.stream,
    )
    this.conversation.append(this.empty, this.messages, this.generation, this.suggestionWrap)

    const clearContext = iconButton('移除上下文', icons.close)
    clearContext.addEventListener('click', () => { void this.request({ type: 'ai-context-clear' }) })
    this.contextSummary.append(el('span', { className: 'yy-ai-context-arrow yy-icon', html: icons.chevronRight }), this.contextLabel)
    this.contextDetails.append(this.contextSummary, this.contextPreview)
    this.contextHost.append(this.contextDetails, clearContext)
    this.element.append(header, this.modelPicker.button, this.conversation, this.buildComposer())
    this.setView(this.view)
  }

  private openModels() {
    openModelSettings(this.options.modals, () => this.view.settings, this.options.dispatch, this.options.listAiModels)
  }

  private async selectModel(value: string) {
    const selection = this.modelOptions.get(value)
    if (!selection || value === modelKey(this.view.settings.active) || this.changingModel) return
    this.changingModel = true
    this.modelPicker.setDisabled(true)
    await this.request({ type: 'ai-model-select', selection })
    this.changingModel = false
    this.modelPicker.setDisabled(this.view.pending)
  }

  private async selectContext(scope: AiScope) {
    this.contextPicker.setDisabled(true)
    await this.request({ type: 'ai-context', scope })
    this.contextPicker.setDisabled(false)
  }

  private buildComposer() {
    const form = el('form', { className: 'yy-ai-composer' })
    const inputBox = el('div', { className: 'yy-ai-input-box' })
    const bar = el('div', { className: 'yy-composer-bar' })
    const tools = el('div', { className: 'yy-ai-composer-tools' })
    this.taskPicker.setItems(aiIntents.map(value => ({ value, label: aiTasks[value].label })), this.intent)
    this.contextPicker.setItems(Object.entries(scopes).map(([value, label]) => ({ value, label })))
    tools.append(this.taskPicker.button, this.contextPicker.button)
    this.sendButton.setAttribute('aria-keyshortcuts', 'Meta+Enter Control+Enter')
    this.cancelButton.addEventListener('click', () => { void this.request({ type: 'ai-cancel' }) })
    bar.append(tools, this.sendButton, this.cancelButton)
    inputBox.append(this.promptInput, bar)

    this.promptInput.addEventListener('input', () => this.updateDraft())
    this.promptInput.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        void this.submitPrompt()
      }
    })
    form.addEventListener('submit', event => {
      event.preventDefault()
      void this.submitPrompt()
    })
    this.updateDraft()
    form.append(this.errorBanner, this.contextHost, inputBox)
    return form
  }

  private async submitPrompt() {
    if (this.submitting || this.view.pending || this.changingModel) return
    const draft = this.promptInput.value
    if (!draft.trim() && this.intent === 'chat') {
      this.promptInput.focus()
      return
    }
    if (!this.view.settings.active) {
      this.openModels()
      return
    }
    this.submitting = true
    const request = this.request({ type: 'ai-send', intent: this.intent, prompt: draft.trim() })
    const started = this.view.pending
    if (started) this.clearDraft(draft)
    if (await request && !started) this.clearDraft(draft)
    this.submitting = false
  }

  private clearDraft(draft: string) {
    if (this.promptInput.value === draft) this.promptInput.value = ''
    this.updateDraft()
    this.contextDetails.open = false
  }

  private updateDraft() {
    // 重算高度时先清除旧高度，删除多行文字后也能收回一行。
    this.promptInput.style.height = 'auto'
    const { scrollHeight, clientHeight } = this.promptInput
    if (scrollHeight > clientHeight) this.promptInput.style.height = scrollHeight + 'px'
    this.sendButton.disabled = this.intent === 'chat' && !this.promptInput.value.trim()
  }

  private async request(action: ShellAction) {
    this.actionError = ''
    this.renderError()
    try {
      const detail = await this.options.dispatch(action)
      if (detail) throw new Error(detail)
      return true
    } catch (error) {
      this.actionError = error instanceof Error ? error.message : String(error)
      this.renderError()
      return false
    }
  }

  setView(view: AiView) {
    const { settings, context, messages, stream, pending, suggestion, canRetry } = view
    const nearEnd = this.conversation.scrollHeight - this.conversation.clientHeight - this.conversation.scrollTop < 48
    this.view = view
    if (settings !== this.shownSettings) {
      this.shownSettings = settings
      this.modelOptions.clear()
      const items = settings.providers.flatMap(provider => provider.models.map(model => {
        const selection = { providerId: provider.id, model }
        const value = modelKey(selection)
        this.modelOptions.set(value, selection)
        return { value, label: model, detail: provider.name }
      }))
      this.modelPicker.setItems(items, modelKey(settings.active))
      this.modelPicker.button.hidden = !items.length
    }
    this.modelPicker.setDisabled(pending || this.changingModel)
    this.clearButton.hidden = !messages.length
    this.clearButton.disabled = pending
    this.retryButton.hidden = pending || !canRetry
    this.sendButton.hidden = pending
    this.cancelButton.hidden = !pending
    this.empty.hidden = !!(messages.length || pending || suggestion)
    this.emptyHint.textContent = settings.active ? '' : '配置模型后可以开始对话'
    this.emptyHint.hidden = !!settings.active

    // 流式更新只写入正在生成的消息。保留历史消息的选区与上下文的滚动位置。
    if (messages !== this.shownMessages) {
      this.messages.replaceChildren(...messages.map(message => {
        const item = el('article', { className: 'yy-msg yy-msg-' + message.role })
        item.append(
          el('div', { className: 'yy-msg-role', text: message.role === 'user' ? '你' : '页屿 AI' }),
          el('div', { className: 'yy-msg-body', text: message.text }),
        )
        return item
      }))
      this.shownMessages = messages
    }
    if (this.stream.textContent !== stream) this.stream.textContent = stream
    this.generation.hidden = !pending
    if (context !== this.shownContext) {
      this.shownContext = context
      this.contextHost.hidden = !context
      this.contextDetails.open = !!context
      const scope = context ? scopes[context.scope] : ''
      this.contextLabel.textContent = context && context.label !== scope ? scope + ' · ' + context.label : scope
      this.contextPreview.textContent = context?.text ?? ''
    }

    const suggestionId = suggestion?.id ?? null
    if (suggestionId !== this.activeSuggestionId) {
      this.activeSuggestionId = suggestionId
      this.selectedHunks = new Set(suggestion ? groupDiffParts(suggestion).hunkIds : [])
      this.renderSuggestion(suggestion)
      if (suggestion) {
        this.options.onSuggestionFocus?.()
        queueMicrotask(() => {
          if (this.activeSuggestionId === suggestionId) this.suggestionWrap.scrollIntoView({ block: 'nearest' })
        })
      }
    }
    if (nearEnd) this.conversation.scrollTop = this.conversation.scrollHeight
    this.renderError()
  }

  private renderError() {
    this.errorBanner.textContent = this.actionError || this.view.error
    this.errorBanner.hidden = !this.errorBanner.textContent
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
        text: { ai: 'AI 建议', mcp: 'MCP 建议', plugin: '插件建议' }[suggestion.source],
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
      checkLabel.append(checkbox, el('span', { text: `第 ${hunkId + 1} 段` }))

      const applySingleBtn = el('button', {
        className: 'yy-btn yy-btn-xs',
        type: 'button',
        text: '仅应用此段',
        attrs: { 'data-apply-hunk': String(hunkId) },
      })
      applySingleBtn.addEventListener('click', () => {
        void this.request({ type: 'suggestion-apply', id: suggestion.id, hunks: [hunkId] })
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
      void this.request({ type: 'suggestion-apply', id: suggestion.id, hunks: hunkIds })
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
        void this.request({ type: 'suggestion-apply', id: suggestion.id, hunks: selectedList })
      }
    })

    const dismissBtn = el('button', {
      className: 'yy-btn yy-btn-xs yy-btn-ghost',
      type: 'button',
      text: '忽略',
      attrs: { 'data-suggestion-action': 'dismiss' },
    })
    dismissBtn.addEventListener('click', () => {
      void this.request({ type: 'suggestion-dismiss', id: suggestion.id })
    })

    footer.append(applyAllBtn, applySelectedBtn, dismissBtn)
    card.append(head, diffBody, footer)
    this.suggestionWrap.append(card)
  }

  focusInput() {
    queueMicrotask(() => this.promptInput.focus({ preventScroll: true }))
  }

  closePickers() {
    this.modelPicker.close()
    this.taskPicker.close()
    this.contextPicker.close()
  }
}

function iconButton(label: string, html: string, className = '', type = 'button') {
  return el('button', {
    className: `yy-icon-btn ${className}`,
    type,
    html,
    title: label,
    attrs: { 'aria-label': label },
  })
}

function modelKey(selection: AiSelection | null) {
  return selection ? selection.providerId + '\n' + selection.model : ''
}
