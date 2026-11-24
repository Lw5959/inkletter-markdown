import type { McpConnection, McpItem, McpServer, McpView, Selection } from './contracts'
import { invoke, reason } from './native'
import type { LocalMcp, McpProposal } from './native'

export class Protocol {
  view: McpView = { connections: [], workspaceAllowed: false, command: '', proposals: 0, result: '', error: '' }
  proposals: McpProposal[] = []
  private root: string | null = null

  constructor(private publish: (view: McpView) => void) {}

  configure(servers: McpServer[]) {
    const previous = this.view.connections
    this.view.connections = servers.map(server => previous.find(connection => connection.server === server)
      ?? { server, status: 'idle', items: [] })
    this.show()
  }

  async workspace(root: string | null, allow?: boolean) {
    this.root = root
    this.view.workspaceAllowed = false
    this.view.command = ''
    this.proposals = []
    if (root) {
      const info = await invoke<LocalMcp>('mcp_local', { root, allow })
      if (this.root !== root) return
      this.view.workspaceAllowed = info.allowed
      this.view.command = info.command
    }
    this.view.proposals = 0
    this.show()
    await this.refreshProposals()
  }

  async connect(id: string) {
    const connection = this.connection(id)
    if (connection.status === 'connecting' || connection.status === 'connected') return
    Object.assign(connection, { status: 'connecting', items: [], error: undefined })
    this.show()
    try {
      const items = await invoke<McpItem[]>('mcp_connect', { server: connection.server })
      if (!this.view.connections.includes(connection) || (connection as McpConnection).status !== 'connecting') {
        await invoke('mcp_disconnect', { id })
        return
      }
      Object.assign(connection, { status: 'connected', items })
    } catch (error) {
      Object.assign(connection, { status: 'error', error: reason(error) })
    }
    this.show()
  }

  async disconnect(id: string) {
    const connection = this.connection(id)
    Object.assign(connection, { status: 'idle', items: [], error: undefined })
    await invoke('mcp_disconnect', { id })
    this.show()
  }

  async call(id: string, item: McpItem, args: Record<string, unknown>) {
    const connection = this.connection(id)
    if (!connection.items.some(candidate => candidate.kind === item.kind && candidate.name === item.name)) throw new Error('该 MCP 能力尚未发现')
    this.view.error = ''
    this.view.result = '正在调用 ' + (item.title ?? item.name)
    this.show()
    try {
      const result = await invoke<unknown>('mcp_call', { id, item, args })
      this.view.result = JSON.stringify(result, null, 2)
    } catch (error) {
      this.view.result = ''
      this.view.error = reason(error)
    }
    this.show()
  }

  async check() {
    if (this.view.connections.some(connection => connection.status === 'connected')) {
      const live = await invoke<string[]>('mcp_connected')
      let changed = false
      for (const connection of this.view.connections) {
        if (connection.status === 'connected' && !live.includes(connection.server.id)) {
          Object.assign(connection, { status: 'error', items: [], error: '服务器连接已断开' })
          changed = true
        }
      }
      if (changed) this.show()
    }
    await this.refreshProposals()
  }

  async current(selection: (Selection & { path: string; text: string }) | null) {
    if (!this.root || !this.view.workspaceAllowed) return
    await invoke('mcp_selection', { root: this.root, selection })
  }

  async resolve(id: string) {
    await invoke('mcp_resolve', { id })
    await this.refreshProposals()
  }

  private connection(id: string): McpConnection {
    const connection = this.view.connections.find(item => item.server.id === id)
    if (!connection) throw new Error('MCP 服务不存在')
    return connection
  }

  private async refreshProposals() {
    const root = this.root
    if (!root || !this.view.workspaceAllowed) return
    const proposals = await invoke<McpProposal[]>('mcp_proposals', { root })
    if (this.root !== root) return
    this.proposals = proposals
    if (this.view.proposals !== proposals.length) {
      this.view.proposals = proposals.length
      this.show()
    }
  }

  private show() { this.publish(this.view) }
}
