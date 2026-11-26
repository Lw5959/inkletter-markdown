import type { AiModelDiscovery, ShellActions } from '../contracts'
import { el } from './helpers'
import { icons } from './icons'

export function modelDiscovery(
  discover: NonNullable<ShellActions['listAiModels']>,
  request: () => AiModelDiscovery,
  configured: () => string[],
  append: (ids: string[]) => void,
) {
  const button = el('button', { type: 'button', className: 'yy-btn yy-btn-sm' },
    el('span', { className: 'yy-icon', html: icons.refresh }), '获取模型')
  const status = el('p', { className: 'yy-ai-setting-help', attrs: { role: 'status' } })
  const filter = el('input', { className: 'yy-input', type: 'search', attrs: { 'aria-label': '筛选可用模型', placeholder: '筛选可用模型' } })
  const list = el('div', { className: 'yy-ai-discovered-list', attrs: { role: 'group', 'aria-label': '可用模型' } })
  const add = el('button', { className: 'yy-btn yy-btn-primary yy-btn-sm', type: 'button', text: '添加所选' })
  const picker = el('div', { className: 'yy-ai-discovery-picker', attrs: { hidden: '' } }, filter, list, add)
  const panel = el('div', { className: 'yy-ai-discovery', attrs: { hidden: '' } }, status, picker)
  let models: string[] = []
  const selected = new Set<string>()
  let revision = 0

  function reset() {
    revision++
    button.disabled = false
    panel.hidden = picker.hidden = true
    filter.value = ''
    selected.clear()
    models = []
    list.replaceChildren()
  }

  function render() {
    const query = filter.value.trim().toLowerCase()
    const matches = models.filter(id => id.toLowerCase().includes(query))
    status.textContent = matches.length > 120
      ? `共 ${matches.length} 项，已显示前 120 项，可继续筛选`
      : matches.length ? `${matches.length} 项可用模型` : '没有匹配的模型'
    list.replaceChildren(...matches.slice(0, 120).map(id => {
      const check = el('input', { type: 'checkbox' })
      check.checked = selected.has(id)
      check.addEventListener('change', () => {
        if (check.checked) selected.add(id)
        else selected.delete(id)
        add.disabled = !selected.size
      })
      return el('label', { className: 'yy-ai-discovered-model' }, check, el('span', { text: id }))
    }))
    add.disabled = !selected.size
  }

  filter.addEventListener('input', render)
  add.addEventListener('click', () => {
    const count = selected.size
    if (!count) return
    append([...selected])
    reset()
    panel.hidden = false
    status.textContent = `已添加 ${count} 个模型，可以保存配置`
  })
  button.addEventListener('click', async () => {
    reset()
    const value = request()
    panel.hidden = false
    if (!value.endpoint) {
      status.textContent = '请填写 API 地址后获取模型'
      return
    }
    status.textContent = '正在获取模型…'
    button.disabled = true
    const current = revision
    try {
      const ids = await discover(value)
      if (current !== revision || !panel.isConnected) return
      const existing = new Set(configured().map(id => id.trim()))
      models = [...new Set(ids)].filter(id => !existing.has(id))
      if (!models.length) {
        status.textContent = ids.length ? '返回的模型已全部添加' : '供应商暂未返回可用模型'
        return
      }
      picker.hidden = false
      render()
    } catch (error) {
      if (current === revision && panel.isConnected) status.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      if (current === revision) button.disabled = false
    }
  })
  return { button, panel, reset }
}
