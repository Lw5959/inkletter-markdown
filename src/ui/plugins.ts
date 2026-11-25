import type { PluginInfo, PluginMarketPort, ShellAction, ShellActions } from '../contracts'
import type { ModalManager } from './dialogs'
import { el, selectWithIcon } from './helpers'
import { icons } from './icons'
import { createPluginMarket } from './plugin-market'

type PluginPage = 'installed' | 'market'

export class PluginManager {
  private installed: PluginInfo[] = []
  private list: HTMLElement | null = null
  private processing = false

  constructor(
    private modals: ModalManager,
    private dispatch: ShellActions['dispatch'],
    private marketPort?: PluginMarketPort,
  ) {}

  setPlugins(plugins: PluginInfo[]) {
    this.installed = plugins
    this.render()
  }

  enabledPlugins() {
    return this.installed.filter(plugin => plugin.enabled)
  }

  open(page: PluginPage = 'installed') {
    const dialog = el('section', {
      className: 'yy-modal yy-plugin-manager',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '插件管理' },
    })
    const header = el('header', { className: 'yy-modal-header' })
    const close = el('button', { className: 'yy-icon-btn', type: 'button', html: icons.close, attrs: { 'aria-label': '关闭' } })
    close.addEventListener('click', () => this.modals.close())
    header.append(el('h2', { text: '插件管理' }), close)
    const body = el('div', { className: 'yy-modal-body yy-plugin-body' })
    const toolbar = el('div', { className: 'yy-plugin-toolbar' })
    const install = el('button', { className: 'yy-btn yy-btn-primary', type: 'button', text: '从文件安装…' })
    const scope = el('select', { className: 'yy-input', attrs: { 'aria-label': '处理范围' } })
    scope.append(
      el('option', { text: '命令默认范围', attrs: { value: 'command' } }),
      el('option', { text: '当前选区', attrs: { value: 'selection' } }),
      el('option', { text: '当前全文', attrs: { value: 'document' } }),
    )
    toolbar.append(selectWithIcon(scope), install)
    const error = el('p', { className: 'yy-plugin-error', attrs: { role: 'alert', hidden: '' } })
    const list = el('div', { className: 'yy-plugin-list' })
    // 只有点击命令时才传入选择的文本，插件结果沿用编辑器的差异审阅。
    body.append(toolbar, el('p', { className: 'yy-plugin-note', text: '插件修改经差异审阅后应用。' }), error, list)
    const market = this.marketPort ? createPluginMarket(this.marketPort, () => selectPage('installed', true)) : null
    const installedTab = el('button', { className: 'yy-mode-btn', type: 'button', text: '已安装' })
    const marketTab = el('button', { className: 'yy-mode-btn', type: 'button', text: '插件市场' })
    function selectPage(next: PluginPage, focus = false) {
      const showMarket = next === 'market' && !!market
      body.hidden = showMarket
      for (const [tab, selected] of [[installedTab, !showMarket], [marketTab, showMarket]] as const) {
        tab.classList.toggle('is-active', selected)
        tab.setAttribute('aria-pressed', String(selected))
      }
      if (market) {
        market.panel.hidden = !showMarket
        if (showMarket) market.show()
      }
      if (focus) (showMarket ? market!.search : install).focus()
    }
    dialog.append(header)
    if (market) {
      const tabBar = el('div', { className: 'yy-plugin-tabs' })
      const tabs = el('div', { className: 'yy-mode-pill', attrs: { role: 'group', 'aria-label': '插件页面' } })
      tabs.append(marketTab, installedTab)
      tabBar.append(tabs)
      dialog.append(tabBar, market.panel)
      marketTab.addEventListener('click', () => selectPage('market', true))
      installedTab.addEventListener('click', () => selectPage('installed', true))
    }
    dialog.append(body)
    selectPage(page)

    const run = async (action: ShellAction) => {
      if (this.processing) return
      this.processing = true
      error.hidden = true
      try {
        const detail = await this.dispatch(action)
        if (detail) throw new Error(detail)
        if (action.type === 'plugin-run' && dialog.isConnected) this.modals.close()
      } catch (failure) {
        error.textContent = failure instanceof Error ? failure.message : String(failure)
        error.hidden = false
      } finally {
        this.processing = false
      }
    }
    install.addEventListener('click', () => { void run({ type: 'plugin-install' }) })
    list.addEventListener('click', event => {
      if (!(event.target instanceof HTMLElement)) return
      const pluginButton = event.target.closest<HTMLButtonElement>('button[data-plugin]')
      if (!pluginButton) return
      const id = pluginButton.dataset.plugin!
      if (pluginButton.dataset.operation === 'run') {
        const command = this.installed.find(plugin => plugin.id === id)?.commands.find(item => item.id === pluginButton.value)
        if (!command) return
        if (command.workflow) {
          this.modals.close()
          void this.dispatch({ type: 'plugin-run', id, command: command.id, scope: 'document' })
          return
        }
        const range = scope.value === 'command' ? command.scope ?? 'selection' : scope.value === 'document' ? 'document' : 'selection'
        void run({ type: 'plugin-run', id, command: command.id, scope: range })
      } else if (pluginButton.dataset.operation === 'remove') {
        void run({ type: 'plugin-remove', id })
      } else {
        void run({ type: 'plugin-enabled', id, enabled: pluginButton.dataset.operation === 'enable' })
      }
    })
    this.modals.open(dialog, {
      initialFocus: page === 'market' && market ? market.search : install,
      onClose: () => { this.list = null },
    })
    this.list = list
    this.render()
  }

  private render() {
    if (!this.list) return
    const active = this.list.contains(document.activeElement) && document.activeElement instanceof HTMLButtonElement
      ? document.activeElement.dataset : null
    this.list.replaceChildren()
    if (!this.installed.length) {
      this.list.append(el('p', { className: 'yy-plugin-empty', text: '暂无已安装插件' }))
      return
    }
    for (const plugin of this.installed) {
      const row = el('article', { className: 'yy-plugin-row', attrs: { 'aria-label': plugin.name } })
      const heading = el('header', { className: 'yy-plugin-toolbar' })
      const info = el('div')
      info.append(
        el('strong', { text: plugin.name }),
        el('p', { className: 'yy-plugin-note', text: plugin.version + (plugin.enabled ? ' · 已启用' : ' · 已停用') }),
      )
      const controls = el('div', { className: 'yy-plugin-controls' })
      const toggle = actionButton(plugin.id, plugin.enabled ? 'disable' : 'enable', plugin.enabled ? '停用' : '启用')
      controls.append(toggle, actionButton(plugin.id, 'remove', '卸载'))
      heading.append(info, controls)
      row.append(heading)
      if (plugin.enabled) {
        const commands = el('div', { className: 'yy-plugin-controls' })
        for (const command of plugin.commands) {
          const button = actionButton(plugin.id, 'run', command.label)
          button.value = command.id
          commands.append(button)
        }
        row.append(commands)
      }
      this.list.append(row)
      if (plugin.id === active?.plugin && ['enable', 'disable'].includes(active.operation ?? '')) toggle.focus()
    }
  }
}

function actionButton(id: string, operation: string, text: string) {
  return el('button', {
    className: 'yy-btn yy-btn-sm', type: 'button', text,
    attrs: { 'data-plugin': id, 'data-operation': operation },
  })
}
