import { listAiModels, Writing } from './ai'
import { clipboardImages, readAttachments } from './ai-attachments'
import { normalizePrompts } from './ai-prompts'
import { mergeSkills, parseSkill } from './ai-skills'
import type { AiAgentApprovalMode, AiPrompts, AiSkill, Editor, McpServer, PluginCatalog, PluginInfo, ShellAction } from './contracts'
import { reviewChanges } from './dialogs'
import { interval } from './document-tools'
import { Protocol } from './mcp'
import { invoke, reason } from './native'
import { officialPluginMarket, resolvePluginMarketSource } from './plugin-market-source'
import { bind, chooseHunks, relocate, suggestion } from './suggestions'
import { AiPanel } from './ui/ai-panel'
import { el } from './ui/helpers'
import { McpPanel } from './ui/mcp-panel'
import type { createPages } from './ui/pages'
import { PluginManager } from './ui/plugins'
import './ui/ai.css'

export type MobileServiceSettings = { aiPrompts?: AiPrompts; aiSkills?: AiSkill[]; aiAgentApprovalMode?: AiAgentApprovalMode; mcp?: McpServer[]; marketSource?: string }
export type MobileServicePage = 'ai' | 'mcp' | 'plugins'

type Snapshot = { uri: string; name: string; text: string; version: string; bom: boolean; writable: boolean }
type Options = {
  editor: Editor
  pages: ReturnType<typeof createPages>
  settings: MobileServiceSettings
  state: () => { id: number; revision: number; title: string; uri: string | null; open: boolean; readonly: boolean }
  persist: () => Promise<void>
  notify: (text: string) => void
  read: (uri: string) => Promise<Snapshot>
  pick: (name?: string, mime?: string) => Promise<string | null>
}

export function createMobileServices(options: Options) {
  const { editor, pages, settings, notify } = options
  const detail = el('p', { className: 'yy-mobile-service-detail', attrs: { role: 'status', hidden: '' } })
  const body = el('div', { className: 'yy-mobile-service-body' })
  const service = el('div', { className: 'yy-mobile-service' }, body, detail)

  let ai: AiPanel | undefined
  const writing = new Writing(view => ai?.setView(view))
  writing.setPrompts(normalizePrompts(settings.aiPrompts))
  writing.setSkills(settings.aiSkills)
  writing.setAgentApprovalMode(settings.aiAgentApprovalMode)
  let mcp: McpPanel | undefined
  const protocol = new Protocol(view => mcp?.setView(view))
  protocol.configure((settings.mcp ?? []).filter(server => server.transport === 'http'))
  let plugins: PluginInfo[] = []
  const pluginManager = new PluginManager({ open: pages.replace, back: pages.closeAll }, dispatch, {
    official: officialPluginMarket,
    source: () => resolvePluginMarketSource(settings.marketSource),
    bundled: () => invoke<PluginCatalog>('plugin_market_list', { source: null, refresh: false }),
    async load(source, refresh = false) {
      const catalog = await invoke<PluginCatalog>('plugin_market_list', {
        source: resolvePluginMarketSource(source || settings.marketSource), refresh,
      })
      if (source !== undefined) {
        const previous = settings.marketSource
        settings.marketSource = catalog.source && catalog.source !== officialPluginMarket ? catalog.source : undefined
        try {
          await options.persist()
        } catch (failure) {
          settings.marketSource = previous
          throw failure
        }
      }
      return catalog
    },
    async install(source, plugin) {
      const result = await invoke<{ installed: PluginInfo[]; catalog: PluginCatalog }>('plugin_market_install', { source, id: plugin.id, sha256: plugin.sha256 })
      setPlugins(result.installed)
      return result.catalog
    },
  })

  let writingLoaded = false
  let runningPlugin = false

  function setPlugins(installed: PluginInfo[]) {
    plugins = installed.map(item => ({ ...item, commands: item.commands.filter(command => command.workflow !== 'images') }))
    pluginManager.setPlugins(plugins)
  }

  async function open(page: MobileServicePage) {
    const label = page === 'ai' ? 'AI 写作助手' : page === 'mcp' ? 'MCP 连接与工具' : '插件管理'
    detail.hidden = true
    if (page === 'ai') {
      ai ??= new AiPanel({ dispatch, listAiModels, modals: pages.present('push') })
      body.replaceChildren(ai.element)
      pages.push(label, service, () => ai?.closePickers())
      ai.setView(writing.view)
      if (!writingLoaded) {
        await writing.load()
        writingLoaded = true
      }
    } else if (page === 'mcp') {
      mcp ??= new McpPanel({ dispatch: action => { void dispatch(action) }, remoteOnly: true })
      body.replaceChildren(mcp.element)
      pages.push(label, service)
      mcp.setView(protocol.view)
    } else {
      const status = el('p', { className: 'yy-mobile-page-message', text: '正在读取插件…', attrs: { role: 'status' } })
      pages.push(label, status)
      try {
        setPlugins(await invoke<PluginInfo[]>('plugin_list'))
        if (status.isConnected) pluginManager.open('online')
      } catch (error) { status.textContent = reason(error) }
    }
  }

  async function dispatch(action: ShellAction) {
    try { await operate(action) }
    catch (error) {
      detail.textContent = reason(error)
      detail.hidden = false
      if (action.type === 'plugin-run' && !detail.isConnected) notify(detail.textContent)
      return detail.textContent
    }
  }

  function editable() {
    const state = options.state()
    if (!state.open) throw new Error('请先打开或新建文档')
    if (state.readonly) throw new Error('请先关闭只读模式')
    return state
  }

  async function operate(action: ShellAction) {
    detail.hidden = true
    switch (action.type) {
      case 'ai-provider-save': case 'ai-provider-remove': case 'ai-model-select':
        await writing.configure(action); break
      case 'ai-prompts':
        settings.aiPrompts = normalizePrompts(action.prompts)
        await options.persist()
        writing.setPrompts(settings.aiPrompts)
        break
      case 'ai-skill-import': case 'ai-skill-remove': {
        const previous = settings.aiSkills ?? []
        if (action.type === 'ai-skill-import') {
          const uris = await invoke<string[]>('android_pick_many')
          if (!uris.length) break
          const files = await Promise.all(uris.map(options.read))
          settings.aiSkills = mergeSkills(previous, await Promise.all(files.map(file => parseSkill(file.text, file.name))))
        } else settings.aiSkills = previous.filter(skill => skill.name !== action.name)
        try { await options.persist() }
        catch (error) { settings.aiSkills = previous; throw error }
        writing.setSkills(settings.aiSkills)
        break
      }
      case 'ai-agent-approval-mode': {
        if (writing.view.pending) throw new Error('请先结束当前生成')
        const previous = settings.aiAgentApprovalMode
        settings.aiAgentApprovalMode = action.mode
        try { await options.persist() }
        catch (error) { settings.aiAgentApprovalMode = previous; throw error }
        writing.setAgentApprovalMode(action.mode)
        break
      }
      case 'ai-agent-approval': writing.decideAgentApproval(action.id, action.allow); break
      case 'ai-context': {
        const state = options.state()
        if (action.scope === 'files') {
          const uris = await invoke<string[]>('android_pick_many')
          if (!uris.length) break
          const files = await Promise.all(uris.map(options.read))
          writing.files(files.map(({ name, text }) => ({ name, text })))
        } else {
          if (!state.open) throw new Error('请先打开文档再添加上下文')
          writing.preview(action.scope, editor, state.id, state.revision, state.title)
        }
        break
      }
      case 'ai-context-clear': writing.clearContext(); break
      case 'ai-model-detect': await writing.detectActiveModel(); break
      case 'ai-attach': {
        const chat = writing.view.conversations?.active
        const files = action.images ? await clipboardImages(action.images)
          : await readAttachments('android_ai_attachment', await invoke<string[]>('android_pick_many'))
        await writing.addAttachments(files, chat)
        break
      }
      case 'ai-attachment-remove': writing.removeAttachment(action.id); break
      case 'ai-send': {
        const { id, revision, open, readonly } = options.state()
        await writing.send(action.intent, action.prompt, editor, id, revision, { agent: action.agent, skill: action.skill, writable: open && !readonly })
        break
      }
      case 'ai-insert-reply': {
        const { id, revision } = editable()
        writing.insertReply(action.message, editor, id, revision)
        break
      }
      case 'ai-cancel': await writing.cancel(); break
      case 'ai-retry': await writing.retry(); break
      case 'ai-clear': await writing.clear(); break
      case 'ai-chat-new': case 'ai-chat-select': case 'ai-chat-rename': case 'ai-chat-remove': case 'ai-compress':
        await writing.manageChat(action); break
      case 'suggestion-apply': {
        const item = writing.pending
        if (!item || item.view.id !== action.id || !action.hunks.length) break
        const { id, revision } = editable()
        const target = relocate(item.binding, id, revision, editor.getMarkdown())
        if (!target) throw new Error('原文已经变化，请基于当前内容重新生成')
        editor.replace(target.from, target.to, chooseHunks(item.view.parts, action.hunks))
        writing.review(null)
        if (writing.view.context && writing.view.context.scope !== 'files') writing.clearContext()
        pages.closeAll()
        notify('建议已应用，可撤销')
        break
      }
      case 'suggestion-dismiss': if (writing.pending?.view.id === action.id) writing.review(null); break
      case 'plugin-install': {
        const uri = await options.pick(undefined, 'application/json')
        if (uri) setPlugins(await invoke<PluginInfo[]>('plugin_install_content', { text: (await options.read(uri)).text }))
        break
      }
      case 'plugin-enabled': setPlugins(await invoke<PluginInfo[]>('plugin_set_enabled', { id: action.id, enabled: action.enabled })); break
      case 'plugin-remove': setPlugins(await invoke<PluginInfo[]>('plugin_remove', { id: action.id })); break
      case 'plugin-run': await runPlugin(action); break
      case 'mcp-config':
        if (action.server.transport !== 'http') throw new Error('请使用 Streamable HTTP 地址')
        if (settings.mcp?.some(server => server.id === action.server.id)) await protocol.disconnect(action.server.id)
        settings.mcp = [...(settings.mcp ?? []).filter(server => server.id !== action.server.id), action.server]
        protocol.configure(settings.mcp)
        await options.persist()
        break
      case 'mcp-remove':
        await protocol.disconnect(action.id)
        settings.mcp = settings.mcp?.filter(server => server.id !== action.id)
        protocol.configure(settings.mcp ?? [])
        await options.persist()
        break
      case 'mcp-connect': await protocol.connect(action.id); break
      case 'mcp-disconnect': await protocol.disconnect(action.id); break
      case 'mcp-call': await protocol.call(action.id, action.item, action.args); break
    }
  }

  async function runPlugin(action: Extract<ShellAction, { type: 'plugin-run' }>) {
    if (runningPlugin || writing.pending || writing.view.pending) throw new Error('请先结束当前操作')
    const command = plugins.find(item => item.id === action.id && item.enabled)?.commands.find(entry => entry.id === action.command)
    if (!command) throw new Error('此插件已停用或命令不可用')
    const run = (text: string) => invoke<string>('plugin_run', { id: action.id, command: command.id, text })
    runningPlugin = true
    try {
      if (command.workflow === 'files') { await formatFiles(run); return }
      const { id, revision } = editable()
      const text = editor.getMarkdown()
      const range = action.scope === 'selection' ? interval(editor.getSelection()) : { from: 0, to: text.length }
      if (range.from === range.to) throw new Error('请先选择处理范围')
      const target = bind(id, revision, text, range)
      const replacement = await run(target.text)
      const current = options.state()
      if (!relocate(target, current.id, current.revision, editor.getMarkdown())) throw new Error('原文已经变化，请重新运行插件')
      const item = suggestion('plugin', command.label, target, replacement)
      if (!item.view.hunks) { notify('插件处理结果与原文一致'); return }
      writing.review(item)
      await open('ai')
    } finally { runningPlugin = false }
  }

  async function formatFiles(run: (text: string) => Promise<string>) {
    const uris = await invoke<string[]>('android_pick_many')
    if (!uris.length) return
    const changes: (Snapshot & { path: string; replacement: string })[] = []
    const issues: string[] = []
    for (const uri of uris) {
      try {
        const file = await options.read(uri)
        if (uri === options.state().uri || !file.writable) { issues.push(file.name); continue }
        const replacement = await run(file.text)
        if (replacement !== file.text) changes.push({ ...file, path: uri, replacement })
      } catch (error) { issues.push(reason(error)) }
    }
    if (!changes.length) {
      notify(issues.length ? '没有可写回的文件，请检查文件权限或在编辑器中处理当前文档' : '所选文件格式已符合要求')
      return
    }
    const selected = await reviewChanges('审阅批量格式化', '应用后保存到选中的原文件。', changes, '应用并保存', true, issues, pages)
    let applied = 0
    let failed = 0
    for (const file of changes.filter(item => selected.has(item.uri))) {
      try {
        await invoke('android_write', { uri: file.uri, text: file.replacement, bom: file.bom, expected: file.version })
        applied++
      } catch { failed++ }
    }
    notify(`已保存 ${applied} 个文件${failed ? `，${failed} 个文件发生冲突或无法写入` : ''}`)
  }

  return { open, documentChanged: () => writing.clearContext() }
}
