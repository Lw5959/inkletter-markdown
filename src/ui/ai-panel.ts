import { aiIntents, aiTasks } from '../ai-prompts'
import { activeModel, effortLabels, modelDisplayName, modelEfforts, optionsForModel } from '../ai-models'
import { attachmentError } from '../ai-attachments'
import type { AiAgentActivity, AiAgentApproval, AiAgentApprovalMode, AiAgentEntry, AiAttachment, AiContext, AiIntent, AiMessage, AiReasoningEffort, AiScope, AiSelection, AiSettings, AiView, ShellAction, ShellActions, Suggestion } from '../contracts'
import { invoke, reason } from '../native'
import { renderReply, replyBody, StreamingReply } from './ai-markdown'
import { markdownLink } from './markdown-content'
import { contextSummary, openConversations } from './ai-conversations'
import { AiCommands, type AiCommand } from './ai-commands'
import { AiBudget } from './ai-budget'
import { openModelSettings, openPromptSettings } from './ai-settings'
import { openSkills } from './ai-skills'
import { ChoicePicker } from './choice-picker'
import type { DialogPresenter } from './dialogs'
import { copyTextToClipboard, el, groupDiffParts } from './helpers'
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
  private messageNodes = new WeakMap<AiMessage, HTMLElement>()
  private shownSettings: AiSettings | null = null
  private shownContext: AiContext | null = null
  private shownAttachments?: AiAttachment[]
  private shownPrompts?: AiView['prompts']
  private budgetCovered?: number
  private shownTrace: readonly AiAgentEntry[] = []
  private shownApproval: AiAgentApproval | undefined
  private refreshChats?: () => void
  private shownChat?: string | null
  private drafts = new Map<string, string>()
  private activeSuggestionId: string | null = null
  private selectedHunks = new Set<number>()
  private submitting = false
  private actionError = ''
  private selectedSkill: string | undefined
  private commandsBlocked = false
  private intent: AiIntent = 'chat'
  private changingModel = false
  private changingApproval = false
  private agentMode = false
  private readingAttachments = false

  private modelButton = el('button', {
    className: 'yy-btn yy-btn-sm yy-btn-ghost', type: 'button', text: '模型配置',
  })
  private chatLabel = el('span', { text: '对话' })
  private chatButton = el('button', { className: 'yy-btn yy-btn-sm yy-btn-ghost yy-ai-chat-switch', type: 'button',
    attrs: { 'aria-label': '对话管理' } }, el('span', { className: 'yy-icon', html: icons.history }), this.chatLabel)
  private clearButton = iconButton('清空会话', icons.trash)
  private retryButton = iconButton('重试上次请求', icons.refresh)
  private conversation = el('div', {
    className: 'yy-scroll-area yy-ai-conversation', attrs: { 'aria-label': 'AI 会话记录' },
  })
  private empty = el('div', { className: 'yy-ai-empty' })
  private emptyHint = el('p')
  private messages = el('div', { className: 'yy-ai-messages', attrs: { role: 'log' } })
  private compaction = contextSummary()
  private liveTrace = el('div', { className: 'yy-ai-trace', attrs: { role: 'log', 'aria-label': '本轮智能体活动' } })
  private agentEnd = el('div', { className: 'yy-msg-role yy-ai-agent-end', attrs: { role: 'status', hidden: '' } })
  private approval = el('section', { className: 'yy-ai-approval', attrs: { 'aria-label': '智能体工具审批', hidden: '' } })
  private generation = el('article', { className: 'yy-msg yy-msg-assistant', attrs: { hidden: '' } })
  private generationStatus = el('div', { className: 'yy-msg-role', attrs: { role: 'status' }, text: '正在生成…' })
  private reasoningStream = new StreamingReply()
  private reasoning = reasoningDetails(this.reasoningStream.element)
  private stream = new StreamingReply()
  private suggestionWrap = el('div', { className: 'yy-suggestion-host', attrs: { hidden: '' } })
  private errorBanner = el('div', { className: 'yy-ai-error', attrs: { role: 'alert', hidden: '' } })
  private contextHost = el('div', { className: 'yy-ai-context', attrs: { hidden: '' } })
  private contextDetails = el('details')
  private contextSummary = el('summary')
  private contextLabel = el('span')
  private contextPreview = el('pre', {
    className: 'yy-context-fulltext', attrs: { 'aria-label': '上下文全文预览', tabindex: '0' },
  })
  private attachmentHost = el('div', { className: 'yy-ai-attachments', attrs: { 'aria-label': 'AI 附件', hidden: '' } })
  private attachmentStatus = el('div', { className: 'yy-ai-attachment-status', attrs: { role: 'status', hidden: '' } })
  private attachButton = iconButton('添加文件或图片', icons.filePlus)
  private promptInput = el('textarea', {
    className: 'yy-ai-input',
    attrs: {
      rows: '1', placeholder: aiTasks.chat.placeholder, 'aria-label': 'AI 指令输入',
      spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off', autocomplete: 'off',
    },
  })
  private commands = new AiCommands(this.promptInput, () => this.view.skills ?? [], command => { void this.runCommand(command) })
  private skillButton = el('button', { className: 'yy-btn yy-btn-sm yy-btn-ghost', type: 'button', text: '技能', attrs: { 'aria-label': '写作技能' } })
  private skillLabel = el('span')
  private removeSkill = iconButton('移除本轮技能', icons.close, 'yy-icon-btn-sm')
  private skillChip = el('div', { className: 'yy-ai-skill-chip', attrs: { hidden: '' } }, this.skillLabel, this.removeSkill)
  private modelOptions = new Map<string, AiSelection>()
  private modelPicker = new ChoicePicker('切换模型', '选择模型', value => { void this.selectModel(value) },
    { className: 'yy-ai-model-switch', minimumWidth: 225 })
  private effortPicker = new ChoicePicker('思考强度', '思考 · 默认', value => { void this.selectEffort(value) },
    { className: 'yy-ai-model-switch yy-ai-effort-switch', minimumWidth: 126 })
  private budget = new AiBudget(() => this.request({ type: 'ai-model-detect' }))
  private modelControls = el('div', { className: 'yy-ai-model-controls' }, this.modelPicker.button, this.effortPicker.button, this.budget.element)
  private taskPicker = new ChoicePicker('写作操作', aiTasks.chat.label, value => {
    this.intent = value as AiIntent
    this.taskPicker.setValue(value)
    this.updateDraft()
  }, { className: 'yy-composer-picker' })
  private contextPicker = new ChoicePicker('添加上下文', '上下文', value => { void this.selectContext(value as AiScope) },
    { className: 'yy-composer-picker', icon: icons.plus })
  private agentToggle = el('button', { className: 'yy-btn yy-btn-sm yy-btn-ghost yy-ai-agent-toggle', type: 'button',
    attrs: { 'aria-pressed': 'false', title: '多轮搜索和读取上下文，提出修改建议' } },
    el('span', { className: 'yy-icon', html: icons.sparkles }), '智能体')
  private approvalPicker = new ChoicePicker('工具审批方式', '自动审核', value => { void this.selectAgentApproval(value as AiAgentApprovalMode) },
    { className: 'yy-composer-picker' })
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
      openPromptSettings(this.options.modals, this.view.prompts, this.intent, this.options.dispatch, this.agentMode,
        this.view.skills?.find(skill => skill.name === this.selectedSkill))
    })
    this.chatButton.addEventListener('click', () => {
      this.refreshChats = openConversations(this.options.modals, () => this.view, this.options.dispatch,
        () => { this.refreshChats = undefined })
    })
    settings.append(this.chatButton, this.modelButton, prompts)
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
      this.generationStatus,
      this.reasoning,
      this.stream.element,
    )
    this.conversation.append(this.empty, this.messages, this.compaction.element, this.liveTrace, this.generation, this.agentEnd, this.suggestionWrap)
    this.conversation.addEventListener('click', event => {
      const url = markdownLink(event)
      if (url) void invoke('visit_link', { url }).catch(error => {
        this.actionError = reason(error)
        this.renderError()
      })
    })

    const clearContext = iconButton('移除上下文', icons.close)
    clearContext.addEventListener('click', () => { void this.request({ type: 'ai-context-clear' }) })
    this.contextSummary.append(el('span', { className: 'yy-ai-context-arrow yy-icon', html: icons.chevronRight }), this.contextLabel)
    this.contextDetails.append(this.contextSummary, this.contextPreview)
    this.contextHost.append(this.contextDetails, clearContext)
    this.element.append(header, this.modelControls, this.conversation, this.approval, this.buildComposer())
    this.setView(this.view)
  }

  private openModels() {
    openModelSettings(this.options.modals, () => this.view.settings, this.options.dispatch, this.options.listAiModels)
  }

  private async selectModel(value: string) {
    const selection = this.modelOptions.get(value)
    if (selection && value !== modelKey(this.view.settings.active)) await this.changeSelection(selection)
  }

  private async selectEffort(value: string) {
    const selection = this.view.settings.active
    const reasoningEffort = value === 'default' ? undefined : value as AiReasoningEffort
    if (selection && selection.reasoningEffort !== reasoningEffort) await this.changeSelection({ ...selection, reasoningEffort }, true)
  }

  private async changeSelection(selection: AiSelection, updateEffort = false) {
    if (this.changingModel) return
    this.changingModel = true
    this.syncModelPickers()
    await this.request({ type: 'ai-model-select', selection, ...(updateEffort ? { updateEffort } : {}) })
    this.changingModel = false
    this.syncModelPickers()
  }

  private syncModelPickers() {
    const disabled = this.view.pending || this.changingModel
    this.modelPicker.setDisabled(disabled)
    this.effortPicker.setDisabled(disabled)
  }

  private async selectAgentApproval(mode: AiAgentApprovalMode) {
    if (mode === (this.view.agentApprovalMode ?? 'auto') || this.changingApproval) return
    this.changingApproval = true
    this.approvalPicker.setDisabled(true)
    await this.request({ type: 'ai-agent-approval-mode', mode })
    this.changingApproval = false
    this.approvalPicker.setDisabled(this.view.pending)
  }

  private async selectContext(scope: AiScope) {
    this.contextPicker.setDisabled(true)
    await this.request({ type: 'ai-context', scope })
    this.contextPicker.setDisabled(false)
  }

  private selectSkill(name?: string) {
    this.selectedSkill = name
    const skill = this.view.skills?.find(item => item.name === name)
    this.skillChip.hidden = !skill
    this.skillLabel.textContent = skill ? (skill.label ?? skill.name) : ''
    this.updateDraft()
  }

  private openSkills() {
    openSkills(this.options.modals, () => this.view.skills ?? [], this.options.dispatch, name => {
      this.selectSkill(name)
      this.focusInput()
    })
  }

  private buildComposer() {
    const form = el('form', { className: 'yy-ai-composer' })
    const inputBox = el('div', { className: 'yy-ai-input-box' })
    const bar = el('div', { className: 'yy-composer-bar' })
    const tools = el('div', { className: 'yy-ai-composer-tools' })
    this.taskPicker.setItems(aiIntents.map(value => ({ value, label: aiTasks[value].label })), this.intent)
    this.contextPicker.setItems(Object.entries(scopes).map(([value, label]) => ({ value, label })))
    this.approvalPicker.setItems([
      { value: 'auto', label: '自动审核' }, { value: 'ask', label: '请求批准' },
    ], 'auto')
    this.approvalPicker.button.hidden = true
    this.agentToggle.addEventListener('click', () => {
      this.agentMode = !this.agentMode
      this.agentToggle.setAttribute('aria-pressed', String(this.agentMode))
      this.approvalPicker.button.hidden = !this.agentMode
      this.updateDraft()
    })
    this.skillButton.onclick = () => this.openSkills()
    this.removeSkill.onclick = () => { this.selectSkill(); this.focusInput() }
    this.attachButton.onclick = () => { void this.addAttachments() }
    tools.append(this.attachButton, this.agentToggle, this.approvalPicker.button, this.taskPicker.button, this.contextPicker.button, this.skillButton)
    this.sendButton.setAttribute('aria-keyshortcuts', 'Meta+Enter Control+Enter')
    this.cancelButton.addEventListener('click', () => { void this.request({ type: 'ai-cancel' }) })
    bar.append(tools, this.sendButton, this.cancelButton)
    inputBox.append(this.skillChip, this.promptInput, bar)

    this.promptInput.addEventListener('input', () => {
      this.updateDraft()
      this.commands.refresh(this.view.pending, true)
    })
    this.promptInput.addEventListener('focus', () => this.commands.refresh(this.view.pending))
    this.promptInput.addEventListener('paste', event => {
      const images = [...(event.clipboardData?.files ?? [])].filter(file => file.type.startsWith('image/'))
      if (!images.length) return
      event.preventDefault()
      void this.addAttachments(images)
    })
    this.promptInput.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return
      if (this.commands.keydown(event)) return
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        if (event.repeat) return
        void this.submitPrompt()
      }
    })
    form.addEventListener('submit', event => {
      event.preventDefault()
      void this.submitPrompt()
    })
    this.updateDraft()
    form.append(this.errorBanner, this.contextHost, this.attachmentHost, this.attachmentStatus, this.commands.element, inputBox)
    return form
  }

  private async addAttachments(images?: File[]) {
    if (this.readingAttachments || this.view.pending) return
    if (!this.view.settings.active) {
      this.openModels()
      return
    }
    this.readingAttachments = true
    this.renderAttachments()
    this.updateDraft()
    try { await this.request({ type: 'ai-attach', images }) }
    finally {
      this.readingAttachments = false
      this.renderAttachments()
      this.updateDraft()
      this.promptInput.focus()
    }
  }

  private renderAttachments() {
    const files = this.view.attachments
    const pending = this.view.pending || this.readingAttachments
    this.attachmentHost.hidden = !files?.length
    if (files !== this.shownAttachments) {
      this.shownAttachments = files
      this.attachmentHost.replaceChildren(...(files ?? []).map(file => {
        const image = file.kind === 'binary' && file.mediaType.startsWith('image/')
        const icon = image ? el('img', { attrs: { src: `data:${file.mediaType};base64,${file.data}`, alt: '' } })
          : el('span', { className: 'yy-icon', html: icons.filePlus })
        const summary = el('summary', { title: file.name }, icon, el('span', { text: file.name }))
        const remove = iconButton('移除 ' + file.name, icons.close, 'yy-icon-btn-sm')
        remove.onclick = () => { void this.request({ type: 'ai-attachment-remove', id: file.id }) }
        const preview = file.kind === 'text'
          ? el('pre', { className: 'yy-context-fulltext', text: file.text, attrs: { tabindex: '0', 'aria-label': file.name + ' 预览' } })
          : image ? el('img', { className: 'yy-ai-attachment-image', attrs: { src: `data:${file.mediaType};base64,${file.data}`, alt: file.name } })
            : null
        return el('div', { className: 'yy-ai-attachment' },
          preview ? el('details', {}, summary, preview) : el('span', { className: 'yy-ai-attachment-name', title: file.name }, icon, el('span', { text: file.name })), remove)
      }))
    }
    this.attachmentHost.querySelectorAll('button').forEach(button => { button.disabled = pending })
  }

  private async submitPrompt() {
    if (this.submitting || this.view.pending || this.changingModel || this.changingApproval || this.readingAttachments) return
    const draft = this.promptInput.value
    const command = this.commands.exact(draft)
    if (command) { await this.runCommand(command); return }
    if (/^\/skill(?:[ \t]+\S+)?$/i.test(draft.trim())) {
      this.actionError = '未找到指定技能。输入 /skills 可查看可用技能。'
      this.renderError()
      return
    }
    if (!this.draftReady()) {
      this.promptInput.focus()
      return
    }
    if (!this.view.settings.active) {
      this.openModels()
      return
    }
    this.submitting = true
    const skill = this.selectedSkill
    const request = this.request({ type: 'ai-send', intent: this.intent, prompt: draft.trim(),
      ...(this.agentMode ? { agent: true } : {}), ...(skill ? { skill } : {}) })
    const started = this.view.pending
    if (started) this.clearDraft(draft, skill)
    if (await request && !started) this.clearDraft(draft, skill)
    this.submitting = false
  }

  private async runCommand(command: AiCommand) {
    if (this.submitting || this.view.pending || this.changingModel || this.changingApproval || this.readingAttachments) return
    // 斜杠命令由应用直接处理，避免进入用户消息或发送到模型。
    this.promptInput.value = command.action === 'help' ? '/' : ''
    this.updateDraft()
    this.commands.refresh(false, true)
    this.actionError = ''
    this.renderError()
    switch (command.action) {
      case 'help': this.focusInput(); break
      case 'model':
        if (this.modelOptions.size) this.modelPicker.button.click()
        else this.openModels()
        break
      case 'context': this.contextPicker.button.click(); break
      case 'attach': await this.addAttachments(); break
      case 'skills': this.openSkills(); break
      case 'skill': this.selectSkill(command.skill); this.focusInput(); break
      case 'compact': case 'new':
        this.submitting = true
        await this.request({ type: command.action === 'compact' ? 'ai-compress' : 'ai-chat-new' })
        this.submitting = false
        this.focusInput()
        break
    }
  }

  private clearDraft(draft: string, skill: string | undefined) {
    if (this.promptInput.value === draft) this.promptInput.value = ''
    if (skill && skill === this.selectedSkill) this.selectSkill()
    this.commands.refresh(this.view.pending, true)
    this.updateDraft()
    this.contextDetails.open = false
  }

  private updateDraft() {
    this.promptInput.placeholder = this.agentMode && this.intent === 'chat' ? '想让智能体查找或修改什么？' : aiTasks[this.intent].placeholder
    // 重算高度时先清除旧高度，删除多行文字后也能收回一行。
    this.promptInput.style.height = 'auto'
    const { scrollHeight, clientHeight } = this.promptInput
    if (scrollHeight > clientHeight) this.promptInput.style.height = scrollHeight + 'px'
    this.attachButton.disabled = this.view.pending || this.readingAttachments
    const model = activeModel(this.view.settings)
    const error = model ? attachmentError(this.view.attachments ?? [], model.provider.protocol, model.options) : ''
    this.attachmentStatus.textContent = this.readingAttachments ? '正在添加附件…' : error
    this.attachmentStatus.hidden = !this.attachmentStatus.textContent
    this.sendButton.disabled = this.readingAttachments || !!error || !this.draftReady()
    this.budget.update(this.view, this.promptInput.value, this.intent, this.agentMode,
      this.view.skills?.find(skill => skill.name === this.selectedSkill))
  }

  private draftReady() {
    return !!(this.promptInput.value.trim() || this.view.attachments?.length || (this.view.context && (this.intent !== 'chat' || this.selectedSkill)))
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

  private replyActions(message: AiMessage) {
    const copyLabel = el('span', { text: '复制 Markdown' })
    const copy = el('button', { className: 'yy-btn yy-btn-sm yy-btn-ghost', type: 'button' },
      el('span', { className: 'yy-icon', html: icons.copy }), copyLabel)
    let copiedTimer = 0
    copy.addEventListener('click', async () => {
      if (await copyTextToClipboard(message.text)) {
        copyLabel.textContent = '已复制'
        window.clearTimeout(copiedTimer)
        copiedTimer = window.setTimeout(() => { copyLabel.textContent = '复制 Markdown' }, 1600)
      } else {
        this.actionError = '复制失败，可选中文本后复制'
        this.renderError()
      }
    })
    const insert = el('button', { className: 'yy-btn yy-btn-sm yy-btn-ghost', type: 'button' },
      el('span', { className: 'yy-icon', html: icons.filePlus }), '插入文档')
    insert.addEventListener('click', () => { void this.request({ type: 'ai-insert-reply', message }) })
    const footer = el('footer', { className: 'yy-ai-reply-actions' }, copy, insert)
    const measured = message.usage?.filter(item => item.cachedTokens !== undefined)
    if (measured?.length) {
      const hits = measured.reduce((sum, item) => sum + item.cachedTokens!, 0)
      footer.append(el('small', { className: 'yy-ai-cache', text: `缓存命中 ${hits.toLocaleString('zh-CN')} Token`,
        title: measured.map((item, index) => `统计 ${index + 1} · 命中 ${item.cachedTokens} Token`).join('\n') }))
    }
    return footer
  }

  setView(view: AiView) {
    const { settings, context, messages, stream, reasoning, pending, suggestion, canRetry, canRegenerate, agent, conversations, compacting } = view
    const refreshComposer = messages !== this.shownMessages || context !== this.shownContext || view.attachments !== this.shownAttachments ||
      settings !== this.shownSettings || this.shownPrompts !== view.prompts || pending !== this.commandsBlocked || this.budgetCovered !== conversations?.covered
    this.shownPrompts = view.prompts
    this.budgetCovered = conversations?.covered
    const nearEnd = this.conversation.scrollHeight - this.conversation.clientHeight - this.conversation.scrollTop < 48
    this.view = view
    const active = conversations?.active
    if (active !== this.shownChat) {
      if (this.shownChat) this.drafts.set(this.shownChat, this.promptInput.value)
      this.shownChat = active
      this.selectSkill()
      this.promptInput.value = active ? this.drafts.get(active) ?? '' : ''
      this.commands.refresh(pending, true)
    }
    if (this.selectedSkill && !view.skills?.some(skill => skill.name === this.selectedSkill)) this.selectSkill()
    if (pending !== this.commandsBlocked) {
      this.commandsBlocked = pending
      this.commands.refresh(pending)
    }
    const title = conversations?.items.find(item => item.id === active)?.title ?? '对话'
    if (this.chatLabel.textContent !== title) this.chatLabel.textContent = title
    this.chatButton.title = title
    this.refreshChats?.()
    this.compaction.update(conversations)
    if (settings !== this.shownSettings) {
      this.shownSettings = settings
      this.modelOptions.clear()
      const items = settings.providers.flatMap(provider => provider.models.map(model => {
        const selection = { providerId: provider.id, model }
        const value = modelKey(selection)
        this.modelOptions.set(value, selection)
        const label = modelDisplayName(model, optionsForModel(provider, model))
        const detail = label === model ? provider.name : `${provider.name} · ${model}`
        return { value, label, detail, triggerLabel: `${provider.name} · ${label}` }
      }))
      this.modelPicker.setItems(items, modelKey(settings.active))
      const activeModel = settings.active?.model ?? ''
      const provider = settings.providers.find(provider => provider.id === settings.active?.providerId)
      const options = modelEfforts(activeModel, provider && optionsForModel(provider, activeModel))
      this.effortPicker.setItems(options.map(value => ({ value, label: '思考 · ' + effortLabels[value] })), settings.active?.reasoningEffort ?? 'default')
      this.effortPicker.button.hidden = !settings.active || options.length === 1
      this.modelControls.hidden = !items.length
    }
    this.syncModelPickers()
    this.agentToggle.disabled = pending
    this.skillButton.disabled = pending
    this.removeSkill.disabled = pending
    this.approvalPicker.setValue(view.agentApprovalMode ?? 'auto')
    this.approvalPicker.setDisabled(pending || this.changingApproval)
    this.clearButton.hidden = !messages.length
    this.clearButton.disabled = pending
    this.retryButton.hidden = pending || !canRetry
    const retryLabel = canRegenerate ? '重新生成上条回复' : '重试上次请求'
    if (retryLabel !== this.retryButton.title) {
      this.retryButton.title = retryLabel
      this.retryButton.setAttribute('aria-label', retryLabel)
    }
    this.sendButton.hidden = pending
    this.cancelButton.hidden = !pending
    this.empty.hidden = !!(messages.length || pending || suggestion)
    this.emptyHint.textContent = settings.active ? '' : '配置模型后可以开始对话'
    this.emptyHint.hidden = !!settings.active

    // 流式更新只写入正在生成的消息。保留历史消息的选区与上下文的滚动位置。
    if (messages !== this.shownMessages) {
      this.messages.replaceChildren(...messages.map(message => {
        const existing = this.messageNodes.get(message)
        if (existing) return existing
        const item = el('article', { className: 'yy-msg yy-msg-' + message.role })
        const body = message.role === 'assistant' ? replyBody() : el('div', { className: 'yy-msg-body', text: message.text })
        item.append(el('div', { className: 'yy-msg-role', text: message.role === 'user' ? '你' + (message.skill ? ' · ' + message.skill : '') : '墨笺 AI' }))
        if (message.attachments?.length) item.append(el('div', { className: 'yy-ai-sent-attachments', text: message.attachments.join(' · ') }))
        if (message.role === 'assistant') {
          if (message.reasoning) {
            const thought = replyBody()
            item.append(reasoningDetails(thought))
            void renderReply(thought, message.reasoning)
          }
          void renderReply(body, message.text)
        }
        item.append(body)
        if (message.role === 'assistant' && message.text.trim()) item.append(this.replyActions(message))
        let entry: HTMLElement = item
        if (message.agentTrace?.length) {
          const steps = message.agentTrace === this.shownTrace ? [...this.liveTrace.children] : message.agentTrace.map(traceEntry)
          entry = el('div', { className: 'yy-ai-exchange' }, el('div', { className: 'yy-ai-trace' }, ...steps), item)
        }
        this.messageNodes.set(message, entry)
        return entry
      }))
      this.shownMessages = messages
    }
    this.renderAttachments()
    const archived = !!agent && messages.at(-1)?.agentTrace === agent.trace
    const generating = pending && (!archived || compacting)
    const hasReasoning = generating && !!reasoning?.trim()
    if (hasReasoning && this.reasoning.hidden) this.reasoning.open = true
    this.reasoning.hidden = !hasReasoning
    this.reasoningStream.set(hasReasoning ? reasoning! : '')
    this.stream.set(generating ? stream : '')
    this.generationStatus.textContent = compacting ? '正在压缩上下文…' : hasReasoning && !stream ? '正在思考…'
      : agent?.round ? `智能体 · 第 ${agent.round} 轮` : '正在生成…'
    this.generation.hidden = !generating
    this.renderAgent(agent, archived)
    if (context !== this.shownContext) {
      this.shownContext = context
      this.contextHost.hidden = !context
      this.contextDetails.open = !!context
      const scope = context ? scopes[context.scope] : ''
      this.contextLabel.textContent = context && context.label !== scope ? scope + ' · ' + context.label : scope
      this.contextPreview.textContent = context?.text ?? ''
      this.updateDraft()
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
    if (refreshComposer) this.updateDraft()
    this.renderError()
  }

  private renderAgent(agent: AiAgentActivity | undefined, archived: boolean) {
    const entries = archived ? [] : agent?.trace ?? []
    // 工具逐条追加，已展开的思考或计划在后续轮次保留展开状态。
    if (entries !== this.shownTrace) {
      if (this.shownTrace.every((entry, index) => entries[index] === entry)) {
        this.liveTrace.append(...entries.slice(this.shownTrace.length).map(traceEntry))
      } else this.liveTrace.replaceChildren(...entries.map(traceEntry))
      this.shownTrace = entries
    }
    if (agent?.approval !== this.shownApproval) {
      this.shownApproval = agent?.approval
      this.renderApproval(this.shownApproval)
    }
    const status = agent?.status === 'cancelled' ? '智能体已取消' : agent?.status === 'failed' ? '智能体任务中断' : ''
    this.agentEnd.textContent = status
    this.agentEnd.hidden = !status
  }

  private renderApproval(approval: AiAgentApproval | undefined) {
    this.approval.hidden = !approval
    this.approval.replaceChildren()
    if (!approval) return
    const controls = el('div', { className: 'yy-ai-approval-actions' })
    for (const [allow, label] of [[false, '拒绝本轮'], [true, '批准本轮']] as const) {
      const button = el('button', { className: 'yy-btn yy-btn-sm' + (allow ? ' yy-btn-primary' : ''), type: 'button', text: label })
      button.addEventListener('click', () => { void this.request({ type: 'ai-agent-approval', id: approval.id, allow }) })
      controls.append(button)
    }
    const tools = el('ul', { className: 'yy-ai-approval-tools' }, ...approval.tools.map(tool => {
      const item = el('li', {}, el('strong', { text: tool.title }), el('div', { text: tool.detail }))
      if (tool.markdown !== undefined) {
        item.append(el('details', {}, el('summary', { text: '预览建议内容' }),
          el('pre', { className: 'yy-context-fulltext', text: tool.markdown || '空白内容' })))
      }
      return item
    }))
    this.approval.append(el('div', { className: 'yy-msg-role', text: `第 ${approval.round} 轮工具等待批准`, attrs: { role: 'status' } }), tools, controls)
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
    this.effortPicker.close()
    this.approvalPicker.close()
    this.taskPicker.close()
    this.contextPicker.close()
    this.commands.hide()
  }
}

function reasoningDetails(body: HTMLElement) {
  return el('details', { className: 'yy-ai-reasoning' }, el('summary', { text: '思考过程' }), body)
}

function traceEntry(entry: AiAgentEntry) {
  if (entry.kind !== 'tool') {
    const body = replyBody()
    void renderReply(body, entry.text)
    return entry.kind === 'reasoning' ? reasoningDetails(body) : body
  }
  const content = el('div', {}, el('strong', { text: entry.title }), el('div', { text: entry.detail }))
  if (entry.plan?.length) content.append(el('ol', { className: 'yy-ai-agent-plan', attrs: { role: 'list', 'aria-label': '执行计划' } },
    ...entry.plan.map(item => el('li', {}, el('span', { className: 'yy-muted-note',
      text: { pending: '待处理', in_progress: '进行中', completed: '已完成' }[item.status] }), el('span', { text: item.step })))))
  return el('div', { className: 'yy-ai-trace-tool' + (entry.failed ? ' is-failed' : '') },
    el('span', { className: 'yy-icon', html: entry.failed ? icons.close : icons.check, attrs: { 'aria-hidden': 'true' } }), content)
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
