import type { MarketPlugin, PluginCatalog, PluginMarketPort } from '../contracts'
import { el } from './helpers'
import { icons } from './icons'

export function createPluginMarket(port: PluginMarketPort, manage: () => void) {
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
  const useBuiltin = el('button', { className: 'yy-btn', type: 'button', text: '使用内置市场' })
  const saveSource = el('button', { className: 'yy-btn yy-btn-primary', type: 'submit', text: '连接' })
  const sourceButtons = el('div', { className: 'yy-plugin-controls' })
  sourceButtons.append(useBuiltin, saveSource)
  sourceForm.append(address, sourceButtons)

  const sourceName = el('p', { className: 'yy-plugin-note yy-market-source-name', attrs: { hidden: '' } })
  const status = el('p', { className: 'yy-plugin-note', attrs: { role: 'status', hidden: '' } })
  const error = el('p', { className: 'yy-plugin-error', attrs: { role: 'alert', hidden: '' } })
  const list = el('div', { className: 'yy-plugin-list' })
  panel.append(toolbar, sourceForm, sourceName, status, error, list)

  let catalog: PluginCatalog | undefined
  let busy = false

  function render() {
    for (const control of [refresh, settings, address, useBuiltin, saveSource]) control.disabled = busy
    list.replaceChildren()
    if (!catalog) return
    const name = catalog.source ? catalog.name + ' · ' + new URL(catalog.source).host : catalog.name
    sourceName.textContent = name
    sourceName.hidden = false
    const words = search.value.trim().toLowerCase().split(/\s+/)
    const matches = catalog.plugins.filter(plugin => {
      const details = [plugin.name, plugin.description, plugin.author, plugin.id].join(' ').toLowerCase()
      return words.every(word => details.includes(word))
    })
    for (const plugin of matches) {
      list.append(pluginCard(plugin, busy, async () => {
        if (plugin.availability === 'installed') {
          manage()
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
        if (panel.isConnected && !panel.hidden && document.activeElement === document.body) {
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

  async function run(message: string, task: () => Promise<PluginCatalog>, success = '') {
    if (busy) return false
    busy = true
    error.hidden = true
    status.textContent = message
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
    if (await run('正在载入市场…', () => port.load(value, true)) && panel.isConnected && !panel.hidden) showSource(false)
  }

  search.addEventListener('input', render)
  refresh.addEventListener('click', () => { void run('正在刷新市场…', () => port.load(undefined, true)) })
  settings.addEventListener('click', () => showSource(sourceForm.hasAttribute('hidden')))
  useBuiltin.addEventListener('click', () => { void connect('') })
  sourceForm.addEventListener('submit', event => {
    event.preventDefault()
    void connect(address.value.trim())
  })
  return { panel, search, show: () => { void run('正在载入市场…', () => port.load()) } }
}

function iconButton(label: string, svg: string) {
  return el('button', { className: 'yy-icon-btn', type: 'button', html: svg, attrs: { 'aria-label': label, title: label } })
}

function pluginCard(plugin: MarketPlugin, busy: boolean, onSelect: () => Promise<void>) {
  const row = el('article', { className: 'yy-plugin-row yy-market-card', attrs: { 'aria-label': plugin.name } })
  const info = el('div', { className: 'yy-market-info' })
  const version = plugin.installedVersion && plugin.installedVersion !== plugin.version
    ? `已安装 ${plugin.installedVersion} · 市场 ${plugin.version}` : `版本 ${plugin.version}`
  info.append(
    el('strong', { text: plugin.name }),
    el('p', { className: 'yy-market-description', text: plugin.description }),
    el('p', { className: 'yy-plugin-note', text: `${plugin.author} · ${version} · ${plugin.license}` }),
  )
  const labels = { install: '安装', update: '更新', installed: '已安装', incompatible: '接口不兼容' }
  const operation = plugin.availability
  const action = el('button', {
    className: 'yy-btn yy-btn-sm' + (operation === 'install' || operation === 'update' ? ' yy-btn-primary' : ''),
    type: 'button',
    text: labels[operation],
    attrs: {
      'data-market-plugin': plugin.id,
      title: operation === 'incompatible' ? `需要插件接口 v${plugin.apiVersion}` : labels[operation] + ' ' + plugin.name,
    },
  })
  action.disabled = busy || operation === 'incompatible'
  action.addEventListener('click', () => { void onSelect() })
  row.append(info, action)
  return row
}
