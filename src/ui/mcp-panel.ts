import type { McpConnection, McpItem, McpServer, McpView, ShellAction } from '../contracts'
import {
  buildSchemaStarterArgs,
  copyTextToClipboard,
  el,
  formatCommandArgs,
  parseCommandArgs,
} from './helpers'
import { icons } from './icons'

export interface McpPanelOptions {
  dispatch: (action: ShellAction) => void
  onNotify?: (message: string) => void
  remoteOnly?: boolean
}

const STATUS_LABELS: Record<McpConnection['status'], string> = {
  idle: '未连接',
  connecting: '连接中…',
  connected: '已连接',
  error: '连接异常',
}

const KIND_LABELS: Record<McpItem['kind'], string> = {
  tool: '工具',
  resource: '资源',
  prompt: '提示词',
}

export class McpPanel {
  readonly element: HTMLElement
  private view: McpView = {
    connections: [],
    workspaceAllowed: false,
    command: '',
    proposals: 0,
    result: '',
    error: '',
  }

  private formOpen = false
  private editingId: string | null = null
  private transport: 'stdio' | 'http' = 'stdio'
  private kindFilter: 'all' | McpItem['kind'] = 'all'
  private pendingCall: { server: McpServer; item: McpItem; argsText: string; approved: boolean } | null = null

  // DOM refs
  private authBadge!: HTMLElement
  private authToggleBtn!: HTMLButtonElement
  private commandCodeEl!: HTMLElement
  private copyCommandBtn!: HTMLButtonElement
  private proposalsBtn!: HTMLButtonElement
  private errorBanner!: HTMLElement
  private configForm!: HTMLFormElement
  private addServerBtn!: HTMLButtonElement
  private nameInput!: HTMLInputElement
  private idInput!: HTMLInputElement
  private transportStdioBtn!: HTMLButtonElement
  private transportHttpBtn!: HTMLButtonElement
  private stdioFields!: HTMLElement
  private httpFields!: HTMLElement
  private commandInput!: HTMLInputElement
  private argsInput!: HTMLInputElement
  private urlInput!: HTMLInputElement
  private formErrorEl!: HTMLElement

  private connectionsWrap!: HTMLElement
  private itemsWrap!: HTMLElement
  private callReviewWrap!: HTMLElement
  private resultWrap!: HTMLElement
  private filterButtons = new Map<'all' | McpItem['kind'], HTMLButtonElement>()

  constructor(private options: McpPanelOptions) {
    this.element = el('div', {
      className: 'yy-pane yy-mcp-pane',
      attrs: { role: 'tabpanel', 'aria-label': 'MCP 连接与工具' },
    })

    const scroll = el('div', { className: 'yy-scroll-area yy-mcp-scroll' })

    const bridgeCard = this.buildBridgeCard()
    bridgeCard.hidden = !!options.remoteOnly
    this.errorBanner = el('div', { className: 'yy-alert yy-alert-error', attrs: { role: 'alert', hidden: '' } })
    const serverSection = this.buildServerSection()
    this.callReviewWrap = el('div', { className: 'yy-mcp-review-host', attrs: { hidden: '' } })
    const itemsSection = this.buildItemsSection()
    this.resultWrap = el('div', { className: 'yy-mcp-result-host', attrs: { hidden: '' } })

    scroll.append(bridgeCard, this.errorBanner, serverSection, this.callReviewWrap, itemsSection, this.resultWrap)
    this.element.append(scroll)
    this.render()
  }

  private buildBridgeCard(): HTMLElement {
    const card = el('section', { className: 'yy-card yy-mcp-bridge', attrs: { 'aria-label': '页屿 MCP 服务与授权' } })

    const authRow = el('div', { className: 'yy-bridge-row' })
    const authLeft = el('div', { className: 'yy-row-gap' })
    authLeft.append(el('span', { className: 'yy-icon', html: icons.shield }))
    this.authBadge = el('span', { className: 'yy-badge', text: '工作区未授权' })
    authLeft.append(this.authBadge)

    this.authToggleBtn = el('button', {
      className: 'yy-btn yy-btn-xs',
      type: 'button',
      text: '授权工作区',
      attrs: { 'data-mcp-action': 'authorize' },
    })
    this.authToggleBtn.addEventListener('click', () => {
      this.options.dispatch({ type: 'mcp-authorize', allow: !this.view.workspaceAllowed })
    })
    authRow.append(authLeft, this.authToggleBtn)

    const cmdBlock = el('div', { className: 'yy-cmd-box' })
    const cmdHead = el('div', { className: 'yy-cmd-head' })
    cmdHead.append(el('span', { className: 'yy-field-label', text: '外部客户端启动命令' }))
    this.copyCommandBtn = el('button', {
      className: 'yy-btn yy-btn-xs',
      type: 'button',
      attrs: { 'data-mcp-action': 'copy-command' },
    })
    this.copyCommandBtn.append(el('span', { className: 'yy-icon', html: icons.copy }), el('span', { text: '复制启动命令' }))
    this.copyCommandBtn.addEventListener('click', async () => {
      if (!this.view.command) return
      const ok = await copyTextToClipboard(this.view.command)
      this.options.onNotify?.(ok ? '已复制 MCP 启动命令' : '复制失败，请手动复制')
      const label = this.copyCommandBtn.querySelector('span:last-child')
      if (label) {
        label.textContent = ok ? '已复制' : '复制失败'
        setTimeout(() => {
          label.textContent = '复制启动命令'
        }, 1600)
      }
    })
    cmdHead.append(this.copyCommandBtn)
    this.commandCodeEl = el('code', { className: 'yy-cmd-code', text: '尚未生成启动命令' })
    cmdBlock.append(cmdHead, this.commandCodeEl)

    const proposalRow = el('div', { className: 'yy-bridge-row' })
    this.proposalsBtn = el('button', {
      className: 'yy-btn yy-btn-xs yy-btn-primary yy-btn-full',
      type: 'button',
      text: '打开待审建议 (0)',
      attrs: { 'data-mcp-action': 'open-proposal' },
    })
    this.proposalsBtn.addEventListener('click', () => {
      this.options.dispatch({ type: 'mcp-next' })
    })
    proposalRow.append(this.proposalsBtn)

    card.append(authRow, cmdBlock, proposalRow)
    return card
  }

  private buildServerSection(): HTMLElement {
    const section = el('section', { className: 'yy-section', attrs: { 'aria-label': 'MCP 服务配置与连接' } })
    const head = el('div', { className: 'yy-section-head' })
    head.append(el('span', { className: 'yy-section-title', text: 'MCP 服务列表' }))

    this.addServerBtn = el('button', {
      className: 'yy-btn yy-btn-xs',
      type: 'button',
      attrs: { 'data-mcp-action': 'toggle-form' },
    })
    this.addServerBtn.append(el('span', { className: 'yy-icon', html: icons.plus }), el('span', { text: '添加服务' }))
    this.addServerBtn.addEventListener('click', () => {
      if (this.formOpen) {
        this.closeForm()
      } else {
        this.openForm(null)
      }
    })
    head.append(this.addServerBtn)

    this.configForm = el('form', { className: 'yy-card yy-config-card', attrs: { hidden: '' } })

    const transportRow = el('div', { className: 'yy-seg-mini', attrs: { role: 'group', 'aria-label': '传输方式' } })
    this.transportStdioBtn = el('button', {
      className: 'yy-seg-mini-btn is-active',
      type: 'button',
      text: '本地 stdio',
      attrs: { 'data-transport': 'stdio' },
    })
    this.transportHttpBtn = el('button', {
      className: 'yy-seg-mini-btn',
      type: 'button',
      text: '远端 HTTP',
      attrs: { 'data-transport': 'http' },
    })
    this.transportStdioBtn.addEventListener('click', () => this.setTransport('stdio'))
    this.transportHttpBtn.addEventListener('click', () => this.setTransport('http'))
    transportRow.append(this.transportStdioBtn, this.transportHttpBtn)
    transportRow.hidden = !!this.options.remoteOnly

    const nameField = el('label', { className: 'yy-field' })
    nameField.append(el('span', { className: 'yy-field-label', text: '服务名称' }))
    this.nameInput = el('input', {
      className: 'yy-input yy-input-sm',
      type: 'text',
      attrs: { placeholder: '例如：本地知识库 / 文献检索' },
    })
    nameField.append(this.nameInput)

    const idField = el('label', { className: 'yy-field' })
    idField.append(el('span', { className: 'yy-field-label', text: '服务 ID（可选，默认自动生成）' }))
    this.idInput = el('input', {
      className: 'yy-input yy-input-sm',
      type: 'text',
      attrs: { placeholder: '例如：docs-mcp' },
    })
    idField.append(this.idInput)

    this.stdioFields = el('div', { className: 'yy-stack-sm' })
    const cmdField = el('label', { className: 'yy-field' })
    cmdField.append(el('span', { className: 'yy-field-label', text: '启动命令 (command)' }))
    this.commandInput = el('input', {
      className: 'yy-input yy-input-sm',
      type: 'text',
      attrs: { placeholder: '例如：npx 或 uvx 或 /usr/local/bin/mcp-server' },
    })
    cmdField.append(this.commandInput)

    const argsField = el('label', { className: 'yy-field' })
    argsField.append(el('span', { className: 'yy-field-label', text: '命令参数 (args，空格分隔，支持引号)' }))
    this.argsInput = el('input', {
      className: 'yy-input yy-input-sm',
      type: 'text',
      attrs: { placeholder: '例如：-y @modelcontextprotocol/server-filesystem ./docs' },
    })
    argsField.append(this.argsInput)
    this.stdioFields.append(cmdField, argsField)

    this.httpFields = el('div', { className: 'yy-stack-sm', attrs: { hidden: '' } })
    const urlField = el('label', { className: 'yy-field' })
    urlField.append(el('span', { className: 'yy-field-label', text: '远端 HTTP 地址 (URL)' }))
    this.urlInput = el('input', {
      className: 'yy-input yy-input-sm',
      type: 'url',
      attrs: { placeholder: '例如：http://127.0.0.1:8787/mcp' },
    })
    urlField.append(this.urlInput)
    this.httpFields.append(urlField)

    this.formErrorEl = el('div', { className: 'yy-form-error', attrs: { role: 'alert' } })

    const formActions = el('div', { className: 'yy-card-actions' })
    const cancelBtn = el('button', { className: 'yy-btn yy-btn-xs', type: 'button', text: '取消' })
    cancelBtn.addEventListener('click', () => this.closeForm())
    const saveBtn = el('button', { className: 'yy-btn yy-btn-xs yy-btn-primary', type: 'submit', text: '保存服务' })
    formActions.append(cancelBtn, saveBtn)

    this.configForm.addEventListener('submit', event => {
      event.preventDefault()
      this.submitServerForm()
    })

    this.configForm.append(
      transportRow,
      nameField,
      idField,
      this.stdioFields,
      this.httpFields,
      this.formErrorEl,
      formActions,
    )

    this.connectionsWrap = el('div', { className: 'yy-mcp-conn-list' })
    section.append(head, this.configForm, this.connectionsWrap)
    return section
  }

  private buildItemsSection(): HTMLElement {
    const section = el('section', { className: 'yy-section', attrs: { 'aria-label': 'MCP 工具、资源与提示词' } })
    const head = el('div', { className: 'yy-section-head' })
    head.append(el('span', { className: 'yy-section-title', text: '可用能力' }))

    const filterRow = el('div', { className: 'yy-chip-row' })
    const filters: { id: 'all' | McpItem['kind']; label: string }[] = [
      { id: 'all', label: '全部' },
      { id: 'tool', label: '工具' },
      { id: 'resource', label: '资源' },
      { id: 'prompt', label: '提示词' },
    ]
    for (const f of filters) {
      const btn = el('button', {
        className: `yy-chip${f.id === this.kindFilter ? ' is-active' : ''}`,
        type: 'button',
        text: f.label,
        attrs: { 'data-mcp-filter': f.id, 'aria-pressed': String(f.id === this.kindFilter) },
      })
      btn.addEventListener('click', () => {
        this.kindFilter = f.id
        for (const [id, b] of this.filterButtons) {
          b.classList.toggle('is-active', id === f.id)
          b.setAttribute('aria-pressed', String(id === f.id))
        }
        this.renderItems()
      })
      this.filterButtons.set(f.id, btn)
      filterRow.append(btn)
    }

    this.itemsWrap = el('div', { className: 'yy-mcp-items-list' })
    section.append(head, filterRow, this.itemsWrap)
    return section
  }

  private setTransport(next: 'stdio' | 'http') {
    this.transport = next
    this.transportStdioBtn.classList.toggle('is-active', next === 'stdio')
    this.transportHttpBtn.classList.toggle('is-active', next === 'http')
    this.stdioFields.toggleAttribute('hidden', next !== 'stdio')
    this.httpFields.toggleAttribute('hidden', next !== 'http')
    this.formErrorEl.textContent = ''
  }

  private openForm(server: McpServer | null) {
    this.formOpen = true
    this.editingId = server?.id ?? null
    this.configForm.removeAttribute('hidden')
    this.formErrorEl.textContent = ''
    this.nameInput.value = server?.name ?? ''
    this.idInput.value = server?.id ?? ''
    this.idInput.disabled = Boolean(server)
    this.setTransport(this.options.remoteOnly ? 'http' : server?.transport ?? 'stdio')
    this.commandInput.value = server?.command ?? ''
    this.argsInput.value = formatCommandArgs(server?.args)
    this.urlInput.value = server?.url ?? ''
    queueMicrotask(() => this.nameInput.focus())
  }

  private closeForm() {
    this.formOpen = false
    this.editingId = null
    this.configForm.setAttribute('hidden', '')
    this.formErrorEl.textContent = ''
  }

  private submitServerForm() {
    const name = this.nameInput.value.trim()
    if (!name) {
      this.formErrorEl.textContent = '请填写服务名称'
      this.nameInput.focus()
      return
    }
    const rawId = this.editingId ?? this.idInput.value.trim()
    const id = rawId || `mcp-${Date.now().toString(36)}`

    if (this.transport === 'stdio') {
      const command = this.commandInput.value.trim()
      if (!command) {
        this.formErrorEl.textContent = 'stdio 模式必须填写启动命令'
        this.commandInput.focus()
        return
      }
      const args = parseCommandArgs(this.argsInput.value)
      this.options.dispatch({
        type: 'mcp-config',
        server: { id, name, transport: 'stdio', command, args },
      })
    } else {
      const url = this.urlInput.value.trim()
      if (!url) {
        this.formErrorEl.textContent = 'HTTP 模式必须填写服务地址'
        this.urlInput.focus()
        return
      }
      this.options.dispatch({
        type: 'mcp-config',
        server: { id, name, transport: 'http', url },
      })
    }
    this.closeForm()
  }

  setView(view: McpView) {
    this.view = view
    // Clear pending call if its server was removed or disconnected
    if (this.pendingCall) {
      const conn = view.connections.find(c => c.server.id === this.pendingCall?.server.id)
      if (!conn || conn.status !== 'connected') {
        this.pendingCall = null
      }
    }
    this.render()
  }

  private render() {
    // Workspace auth & bridge
    this.authBadge.textContent = this.view.workspaceAllowed ? '工作区已授权' : '工作区未授权'
    this.authBadge.classList.toggle('is-success', this.view.workspaceAllowed)
    this.authToggleBtn.textContent = this.view.workspaceAllowed ? '撤销授权' : '授权工作区'

    this.commandCodeEl.textContent = this.view.command || '尚未生成启动命令'
    this.copyCommandBtn.disabled = !this.view.command

    this.proposalsBtn.textContent = `打开待审建议 (${this.view.proposals})`
    this.proposalsBtn.disabled = this.view.proposals <= 0

    this.errorBanner.textContent = this.view.error
    this.errorBanner.toggleAttribute('hidden', !this.view.error)

    this.renderConnections()
    this.renderCallReview()
    this.renderItems()
    this.renderResult()
  }

  private renderConnections() {
    this.connectionsWrap.replaceChildren()
    if (this.view.connections.length === 0) {
      this.connectionsWrap.append(
        el('div', { className: 'yy-empty-box', text: '暂未配置 MCP 服务，点击右上角「添加服务」配置本地 stdio 或远端 HTTP 服务。' }),
      )
      return
    }

    for (const conn of this.view.connections) {
      const card = el('div', {
        className: `yy-conn-card is-${conn.status}`,
        attrs: { 'data-mcp-server': conn.server.id },
      })
      const top = el('div', { className: 'yy-conn-top' })
      const titleGroup = el('div', { className: 'yy-conn-info' })
      titleGroup.append(
        el('span', { className: `yy-status-dot is-${conn.status}` }),
        el('strong', { className: 'yy-conn-name', text: conn.server.name }),
        el('span', { className: 'yy-badge', text: conn.server.transport.toUpperCase() }),
      )
      const statusBadge = el('span', {
        className: `yy-conn-status is-${conn.status}`,
        text: STATUS_LABELS[conn.status],
      })
      top.append(titleGroup, statusBadge)

      const endpoint = conn.server.transport === 'stdio'
        ? [conn.server.command ?? '', ...(conn.server.args ?? [])].filter(Boolean).join(' ')
        : (conn.server.url ?? '')
      const detail = el('div', { className: 'yy-conn-endpoint', text: endpoint, title: endpoint })

      card.append(top, detail)
      if (conn.error) {
        card.append(el('div', { className: 'yy-conn-error', text: conn.error }))
      }

      const actions = el('div', { className: 'yy-conn-actions' })
      if (conn.status === 'connected' || conn.status === 'connecting') {
        const disconnectBtn = el('button', {
          className: 'yy-btn yy-btn-xs',
          type: 'button',
          text: '断开',
        })
        disconnectBtn.addEventListener('click', () => {
          this.options.dispatch({ type: 'mcp-disconnect', id: conn.server.id })
        })
        actions.append(disconnectBtn)
      } else {
        const connectBtn = el('button', {
          className: 'yy-btn yy-btn-xs yy-btn-primary',
          type: 'button',
          text: '连接',
        })
        connectBtn.addEventListener('click', () => {
          this.options.dispatch({ type: 'mcp-connect', id: conn.server.id })
        })
        actions.append(connectBtn)
      }

      const editBtn = el('button', { className: 'yy-btn yy-btn-xs yy-btn-ghost', type: 'button', text: '编辑' })
      editBtn.addEventListener('click', () => this.openForm(conn.server))

      const removeBtn = el('button', { className: 'yy-btn yy-btn-xs yy-btn-ghost yy-text-danger', type: 'button', text: '删除' })
      removeBtn.addEventListener('click', () => {
        this.options.dispatch({ type: 'mcp-remove', id: conn.server.id })
      })

      actions.append(editBtn, removeBtn)
      card.append(actions)
      this.connectionsWrap.append(card)
    }
  }

  private renderItems() {
    this.itemsWrap.replaceChildren()
    const pairs: { server: McpServer; item: McpItem }[] = []
    for (const conn of this.view.connections) {
      if (conn.status !== 'connected') continue
      for (const item of conn.items) {
        if (this.kindFilter === 'all' || item.kind === this.kindFilter) {
          pairs.push({ server: conn.server, item })
        }
      }
    }

    if (pairs.length === 0) {
      const hasConnected = this.view.connections.some(c => c.status === 'connected')
      this.itemsWrap.append(
        el('div', {
          className: 'yy-empty-box',
          text: hasConnected ? '当前筛选下暂无工具、资源或提示词' : '连接 MCP 服务后，将在此列出可用的工具、资源和提示词。',
        }),
      )
      return
    }

    for (const { server, item } of pairs) {
      const isSelected = this.pendingCall?.server.id === server.id && this.pendingCall.item.name === item.name
      const card = el('div', {
        className: `yy-mcp-item-card${isSelected ? ' is-selected' : ''}`,
        attrs: { 'data-mcp-item': item.name, 'data-mcp-kind': item.kind },
      })
      const head = el('div', { className: 'yy-mcp-item-head' })
      const meta = el('div', { className: 'yy-mcp-item-meta' })
      meta.append(
        el('span', { className: `yy-badge is-kind-${item.kind}`, text: KIND_LABELS[item.kind] }),
        el('strong', { text: item.title || item.name }),
      )
      const prepareBtn = el('button', {
        className: 'yy-btn yy-btn-xs',
        type: 'button',
        text: isSelected ? '审阅中' : '参数与调用',
      })
      prepareBtn.addEventListener('click', () => {
        const starter = buildSchemaStarterArgs(item.schema)
        this.pendingCall = {
          server,
          item,
          argsText: JSON.stringify(starter, null, 2),
          approved: false,
        }
        this.renderCallReview()
        this.renderItems()
      })
      head.append(meta, prepareBtn)
      card.append(head)
      if (item.title && item.title !== item.name) {
        card.append(el('div', { className: 'yy-muted-mono', text: `${server.name} · ${item.name}` }))
      } else {
        card.append(el('div', { className: 'yy-muted-mono', text: server.name }))
      }
      if (item.description) {
        card.append(el('p', { className: 'yy-mcp-item-desc', text: item.description }))
      }
      this.itemsWrap.append(card)
    }
  }

  private renderCallReview() {
    this.callReviewWrap.replaceChildren()
    const call = this.pendingCall
    this.callReviewWrap.toggleAttribute('hidden', !call)
    if (!call) return

    const card = el('section', {
      className: 'yy-card yy-approval-card',
      attrs: { 'aria-label': 'MCP 调用前参数预览与显式许可' },
    })

    const head = el('div', { className: 'yy-approval-head' })
    const titleWrap = el('div', { className: 'yy-row-gap' })
    titleWrap.append(
      el('span', { className: 'yy-badge is-warning', text: '调用前显式许可' }),
      el('strong', { text: `${call.server.name} / ${call.item.title || call.item.name}` }),
    )
    const closeBtn = el('button', {
      className: 'yy-icon-btn yy-icon-btn-xs',
      type: 'button',
      html: icons.close,
      attrs: { 'aria-label': '取消本次调用' },
    })
    closeBtn.addEventListener('click', () => {
      this.pendingCall = null
      this.renderCallReview()
      this.renderItems()
    })
    head.append(titleWrap, closeBtn)

    const summary = el('div', {
      className: 'yy-muted-note',
      text: `类型：${KIND_LABELS[call.item.kind]} · 标识：${call.item.name}`,
    })

    const argsField = el('label', { className: 'yy-field' })
    argsField.append(el('span', { className: 'yy-field-label', text: '编辑调用参数 (JSON 对象)' }))
    const argsTextarea = el('textarea', {
      className: 'yy-textarea yy-mono',
      attrs: { rows: '4', 'aria-label': 'MCP 调用参数 JSON' },
    })
    argsTextarea.value = call.argsText
    argsField.append(argsTextarea)

    const previewLabel = el('div', { className: 'yy-field-label', text: '即将发送的参数预览' })
    const previewPre = el('pre', { className: 'yy-args-preview', attrs: { 'aria-label': '即将发送的参数预览' } })
    const parseErrEl = el('div', { className: 'yy-form-error', attrs: { role: 'alert' } })

    const consentLabel = el('label', { className: 'yy-consent-check' })
    const consentInput = el('input', {
      type: 'checkbox',
      attrs: { 'data-mcp-consent': 'true' },
    })
    consentInput.checked = call.approved
    consentLabel.append(
      consentInput,
      el('span', { text: '我已核对目标服务与以上参数，明确许可执行此次调用' }),
    )

    const actions = el('div', { className: 'yy-card-actions' })
    const cancelBtn = el('button', { className: 'yy-btn yy-btn-xs', type: 'button', text: '取消' })
    cancelBtn.addEventListener('click', () => {
      this.pendingCall = null
      this.renderCallReview()
      this.renderItems()
    })
    const executeBtn = el('button', {
      className: 'yy-btn yy-btn-xs yy-btn-primary',
      type: 'button',
      text: '确认许可并调用',
      attrs: { 'data-mcp-action': 'confirm-call' },
    })
    actions.append(cancelBtn, executeBtn)

    let parsedArgs: Record<string, unknown> | null = null
    const validateAndSync = () => {
      try {
        const parsed: unknown = call.argsText.trim() ? JSON.parse(call.argsText) : {}
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          parsedArgs = null
          parseErrEl.textContent = '参数必须是 JSON 对象（如 {"query": "..."}）'
          previewPre.textContent = '（参数格式无效）'
        } else {
          parsedArgs = parsed as Record<string, unknown>
          parseErrEl.textContent = ''
          previewPre.textContent = JSON.stringify(parsedArgs, null, 2)
        }
      } catch (err) {
        parsedArgs = null
        parseErrEl.textContent = `JSON 解析错误：${err instanceof Error ? err.message : String(err)}`
        previewPre.textContent = '（等待修正 JSON 格式）'
      }
      executeBtn.disabled = !parsedArgs || !call.approved
    }

    argsTextarea.addEventListener('input', () => {
      call.argsText = argsTextarea.value
      // Require fresh explicit approval if args are modified after checking
      if (call.approved) {
        call.approved = false
        consentInput.checked = false
      }
      validateAndSync()
    })

    consentInput.addEventListener('change', () => {
      call.approved = consentInput.checked
      validateAndSync()
    })

    executeBtn.addEventListener('click', () => {
      if (!parsedArgs || !call.approved) return
      const payload = { id: call.server.id, item: call.item, args: parsedArgs }
      this.pendingCall = null
      this.renderCallReview()
      this.renderItems()
      this.options.dispatch({ type: 'mcp-call', ...payload })
    })

    validateAndSync()
    card.append(head, summary, argsField, previewLabel, previewPre, parseErrEl, consentLabel, actions)
    this.callReviewWrap.append(card)
  }

  private renderResult() {
    this.resultWrap.replaceChildren()
    const hasResult = Boolean(this.view.result)
    this.resultWrap.toggleAttribute('hidden', !hasResult)
    if (!hasResult) return

    const card = el('section', { className: 'yy-card yy-result-card', attrs: { 'aria-label': '最近一次 MCP 返回结果' } })
    const head = el('div', { className: 'yy-section-head' })
    head.append(el('span', { className: 'yy-section-title', text: '最近返回结果' }))
    const copyBtn = el('button', { className: 'yy-btn yy-btn-xs yy-btn-ghost', type: 'button', text: '复制' })
    copyBtn.addEventListener('click', async () => {
      const ok = await copyTextToClipboard(this.view.result)
      this.options.onNotify?.(ok ? '已复制返回结果' : '复制失败')
    })
    head.append(copyBtn)
    const pre = el('pre', { className: 'yy-result-pre', text: this.view.result })
    card.append(head, pre)
    this.resultWrap.append(card)
  }
}
