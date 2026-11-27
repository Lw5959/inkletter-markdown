import type { MarketPlugin, PluginCatalog, PluginMarketPort } from '../contracts'
import { bindContextMenu, buttonCommand, copyCommand } from './context-menu'
import { el } from './helpers'
import { icons } from './icons'

export type MarketChannel = 'online' | 'bundled'

export function createPluginMarket(port: PluginMarketPort, options: {
  manage: () => void
  onChannel: (channel: MarketChannel, busy: boolean) => void
}) {
  const panel = el('div', { className: 'yy-modal-body yy-plugin-body yy-plugin-market', attrs: { hidden: '' } })
  const search = el('input', {
    className: 'yy-input', type: 'search',
    attrs: { 'aria-label': '搜索插件', placeholder: '搜索插件' },
  })
  const searchField = el('div', { className: 'yy-market-search' })
  searchField.append(el('span', { className: 'yy-icon', html: icons.search }), search)
  const refresh = iconButton('刷新市场', icons.refresh)
  const settings = iconButton('市场源', icons.settings)
  settings.setAttribute('aria-expanded', 'false')
  const toolbar = el('div', { className: 'yy-market-tools' })
  toolbar.append(searchField, refresh, settings)

  const sourceForm = el('form', { className: 'yy-market-source', attrs: { 'aria-label': '市场源设置', hidden: '' } })
  const address = el('input', {
    className: 'yy-input', type: 'url',
    attrs: { 'aria-label': '市场目录地址', placeholder: 'https://…/index.json', required: '' },
  })
  const useOfficial = el('button', { className: 'yy-btn', type: 'button', text: '恢复官方市场' })
  const saveSource = el('button', { className: 'yy-btn yy-btn-primary', type: 'submit', text: '连接' })
  const sourceButtons = el('div', { className: 'yy-plugin-controls' })
  sourceButtons.append(useOfficial, saveSource)
  sourceForm.append(el('label', { className: 'yy-field' },
    el('span', { className: 'yy-field-label', text: '市场目录' }), address), sourceButtons)
  const status = el('p', { className: 'yy-plugin-note', attrs: { role: 'status', hidden: '' } })
  const error = el('p', { className: 'yy-plugin-error', attrs: { role: 'alert', hidden: '' } })
  const count = el('p', { className: 'yy-market-count', attrs: { 'aria-live': 'polite', hidden: '' } })
  const list = el('div', { className: 'yy-market-list', attrs: { role: 'region', 'aria-label': '插件目录' } })
  panel.append(toolbar, sourceForm, status, error, count, list)

  let catalog: PluginCatalog | undefined
  let channel: MarketChannel = 'online'
  let loading = false
  let loadSequence = 0
  let busy = false

  function render() {
    for (const control of [refresh, settings, address, useOfficial, saveSource]) control.disabled = busy || loading
    options.onChannel(channel, busy)
    panel.dataset.marketHost = catalog?.source ? new URL(catalog.source).host : ''
    list.setAttribute('aria-busy', String(loading || busy))
    count.hidden = !catalog
    list.replaceChildren()
    if (!catalog) return
    const words = search.value.trim().toLowerCase().split(/\s+/)
    const matches = catalog.plugins.filter(plugin => {
      const details = [plugin.name, plugin.description, plugin.author, plugin.id].join(' ').toLowerCase()
      return words.every(word => details.includes(word))
    })
    count.textContent = matches.length === catalog.plugins.length
      ? `${matches.length} 个插件` : `${matches.length} / ${catalog.plugins.length} 个插件`
    for (const plugin of matches) {
      list.append(pluginCard(plugin, busy || loading, async () => {
        if (plugin.availability === 'installed') {
          options.manage()
          return
        }
        if (!catalog) return
        const source = catalog.source
        const update = plugin.availability === 'update'
        await run(
          (update ? '正在更新 ' : '正在安装 ') + plugin.name,
          () => port.install(source, plugin),
          (update ? '已更新 ' : '已安装 ') + plugin.name,
        )
        if (panel.isConnected && !panel.hidden && panel.ownerDocument.activeElement === panel.ownerDocument.body) {
          const action = [...list.querySelectorAll<HTMLButtonElement>('button')]
            .find(button => button.dataset.marketPlugin === plugin.id)
          action?.focus({ preventScroll: true })
        }
      }))
    }
    if (!matches.length) {
      list.append(el('p', { className: 'yy-plugin-empty', text: catalog.plugins.length ? '没有找到匹配的插件' : '此市场暂无插件' }))
    }
  }

  async function browse(next: MarketChannel, refresh = false, offlineReason = ''): Promise<void> {
    if (busy || (loading && next === channel)) return
    const request = ++loadSequence
    if (next !== channel) catalog = undefined
    channel = next
    loading = true
    error.hidden = true
    status.title = ''
    status.textContent = next === 'online' ? '正在连接在线市场…' : '正在载入内置插件…'
    status.hidden = false
    render()
    try {
      const result = await (next === 'online' ? port.load(undefined, refresh) : port.bundled())
      // 用户切到内置插件后，迟到的在线响应不得替换当前目录。
      if (request !== loadSequence) return
      catalog = result
      status.textContent = offlineReason ? '暂时无法连接在线市场，已显示内置插件。' : ''
      status.title = offlineReason
      status.hidden = !offlineReason
    } catch (failure) {
      if (request !== loadSequence) return
      const message = failure instanceof Error ? failure.message : String(failure)
      if (next === 'online') {
        await browse('bundled', false, message)
        return
      }
      error.textContent = message
      error.hidden = false
      status.hidden = true
    } finally {
      if (request === loadSequence) {
        loading = false
        render()
      }
    }
  }

  async function run(message: string, task: () => Promise<PluginCatalog>, success = '') {
    if (busy || loading) return false
    busy = true
    error.hidden = true
    status.textContent = message
    status.title = ''
    status.hidden = false
    render()
    try {
      catalog = await task()
      status.textContent = success
      status.hidden = !success
      return true
    } catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : String(failure)
      error.hidden = false
      status.hidden = true
      return false
    } finally {
      busy = false
      render()
    }
  }

  function showSource(open: boolean) {
    sourceForm.hidden = !open
    settings.setAttribute('aria-expanded', String(open))
    if (open) {
      address.value = port.source()
      address.focus()
    } else {
      settings.focus()
    }
  }

  async function connect(value: string) {
    const connected = await run('正在连接在线市场…', async () => {
      const result = await port.load(value, true)
      channel = 'online'
      return result
    })
    if (connected && panel.isConnected && !panel.hidden) showSource(false)
  }

  search.addEventListener('input', render)
  refresh.addEventListener('click', () => { void browse(channel, true) })
  settings.addEventListener('click', () => showSource(sourceForm.hasAttribute('hidden')))
  useOfficial.addEventListener('click', () => { void connect(port.official) })
  sourceForm.addEventListener('submit', event => {
    event.preventDefault()
    void connect(address.value.trim())
  })
  return { panel, show: (next: MarketChannel) => {
    if (next !== channel || !catalog) void browse(next)
  } }
}

function iconButton(label: string, svg: string) {
  return el('button', { className: 'yy-icon-btn', type: 'button', html: svg, attrs: { 'aria-label': label, title: label } })
}

function pluginCard(plugin: MarketPlugin, busy: boolean, onSelect: () => Promise<void>) {
  const row = el('article', { className: 'yy-market-card', attrs: { 'aria-label': plugin.name } })
  const heading = el('header', { className: 'yy-market-heading' },
    el('span', { className: 'yy-market-glyph', html: icons.plug, attrs: { 'aria-hidden': 'true' } }),
    el('div', { className: 'yy-market-info' },
      el('h3', { text: plugin.name }),
      el('p', { className: 'yy-plugin-note', text: plugin.author }),
    ),
  )
  const version = plugin.installedVersion && plugin.installedVersion !== plugin.version
    ? `${plugin.installedVersion} → ${plugin.version}` : `v${plugin.version}`
  const labels = { install: '安装', update: '更新', installed: '已安装', incompatible: '接口不兼容' }
  const operation = plugin.availability
  const action = el('button', {
    className: 'yy-btn yy-market-action' + (operation === 'update' ? ' yy-btn-primary' : ''),
    type: 'button',
    text: labels[operation],
    attrs: {
      'data-market-plugin': plugin.id,
      title: operation === 'incompatible' ? `需要插件接口 v${plugin.apiVersion}` : labels[operation] + ' ' + plugin.name,
    },
  })
  action.disabled = busy || operation === 'incompatible'
  action.addEventListener('click', () => { void onSelect() })
  const footer = el('footer', { className: 'yy-market-footer' },
    el('p', { className: 'yy-plugin-note', text: `${version} · ${plugin.license}` }),
    action,
  )
  row.append(heading, el('p', { className: 'yy-market-description', text: plugin.description }), footer)
  bindContextMenu(row, '市场插件操作', () => [
    buttonCommand(operation === 'installed' ? '管理插件' : labels[operation], action),
    copyCommand('复制插件 ID', plugin.id, row),
  ], action)
  return row
}
