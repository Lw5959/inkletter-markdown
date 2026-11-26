import { aiIntents, aiTasks, normalizePrompts, systemPrompt } from '../ai-prompts'
import type { AiIntent, AiPrompts, AiProtocol, AiProviderDraft, AiSettings, ShellActions } from '../contracts'
import type { DialogPresenter } from './dialogs'
import { modelDiscovery } from './ai-model-discovery'
import { ChoicePicker } from './choice-picker'
import { el } from './helpers'
import { icons } from './icons'

type Dispatch = ShellActions['dispatch']

const protocols: Record<AiProtocol, { name: string; endpoint: string }> = {
  chat: { name: 'Chat Completions', endpoint: 'http://127.0.0.1:11434/v1' },
  anthropic: { name: 'Anthropic Messages', endpoint: 'https://api.anthropic.com/v1' },
  responses: { name: 'Responses', endpoint: 'https://api.openai.com/v1' },
}

type Draft = { provider: AiProviderDraft; key: string; clearKey: boolean }

export function openModelSettings(modals: DialogPresenter, settings: () => AiSettings, dispatch: Dispatch, listAiModels?: ShellActions['listAiModels']) {
  const body = el('div', { className: 'yy-ai-catalog' })
  const list = el('div', { className: 'yy-ai-provider-list', attrs: { 'aria-label': '供应商' } })
  const add = el('button', { className: 'yy-btn yy-btn-sm yy-btn-ghost yy-ai-add-provider', type: 'button' },
    el('span', { className: 'yy-icon', html: icons.plus }), '添加供应商')
  const editor = el('div', { className: 'yy-ai-provider-editor' })
  const drafts = new Map<string, Draft>()
  let fresh: string | null = null
  let protocol: ChoicePicker | undefined
  let editing = settings().active?.providerId ?? settings().providers[0]?.id ?? makeNew()
  let notice = ''

  function makeNew() {
    const id = crypto.randomUUID()
    fresh = id
    drafts.set(id, { provider: { id, name: '', endpoint: '', protocol: 'chat', models: [''] }, key: '', clearKey: false })
    return id
  }

  function getDraft(): Draft {
    const prior = drafts.get(editing)
    if (prior) return prior
    const saved = settings().providers.find(item => item.id === editing)!
    const { id, name, endpoint, protocol, models } = saved
    const draft = { provider: { id, name, endpoint, protocol, models: [...models] }, key: '', clearKey: false }
    drafts.set(editing, draft)
    return draft
  }

  const select = (id: string) => { editing = id; notice = ''; render() }
  add.addEventListener('click', () => {
    select(fresh ?? makeNew())
    editor.querySelector<HTMLInputElement>('[name="provider-name"]')?.focus()
  })

  function render() {
    protocol?.close()
    list.replaceChildren()
    const rows = settings().providers.map(({ id, name, protocol }) => ({ id, name, detail: protocols[protocol].name }))
    if (fresh) rows.push({ id: fresh, name: '新供应商', detail: '' })
    for (const row of rows) {
      const button = el('button', {
        className: 'yy-ai-provider-choice', type: 'button',
        attrs: { 'aria-pressed': String(row.id === editing), 'data-provider-id': row.id },
      }, el('span', { text: row.name }))
      if (row.detail) button.append(el('small', { text: row.detail }))
      button.addEventListener('click', () => {
        select(row.id)
        // 列表更新后让键盘焦点仍停在刚选中的供应商。
        list.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus()
      })
      list.append(button)
    }

    const draft = getDraft()
    const saved = settings().providers.find(item => item.id === editing)
    let discovery: ReturnType<typeof modelDiscovery> | undefined
    const name = el('input', { className: 'yy-input', type: 'text', attrs: { name: 'provider-name', required: '', autocomplete: 'off' } })
    name.value = draft.provider.name
    name.addEventListener('input', () => { draft.provider.name = name.value })
    const address = el('input', { className: 'yy-input', type: 'url', attrs: { required: '', spellcheck: 'false' } })
    address.value = draft.provider.endpoint
    address.addEventListener('input', () => { draft.provider.endpoint = address.value; syncKey(); discovery?.reset() })
    protocol = new ChoicePicker('API 协议', 'API 协议', value => {
      draft.provider.protocol = value as AiProtocol
      protocol?.setValue(value)
      syncKey()
      discovery?.reset()
    }, { className: 'yy-input' })
    protocol.setItems(Object.entries(protocols).map(([value, item]) => ({ value, label: item.name })), draft.provider.protocol)
    const key = el('input', { className: 'yy-input', type: 'password', attrs: { autocomplete: 'new-password' } })
    key.value = draft.key
    key.addEventListener('input', () => { draft.key = key.value; discovery?.reset() })
    const clearKey = el('input', { type: 'checkbox' })
    clearKey.checked = draft.clearKey
    clearKey.addEventListener('change', () => { draft.clearKey = clearKey.checked; syncKey(); discovery?.reset() })
    const clearLabel = el('label', { className: 'yy-ai-delete-key' }, clearKey, '删除已存密钥')
    function syncKey() {
      address.placeholder = protocols[draft.provider.protocol].endpoint
      const stored = saved?.hasKey && address.value.trim() === saved.endpoint && draft.provider.protocol === saved.protocol
      clearLabel.hidden = !stored
      if (!stored) draft.clearKey = clearKey.checked = false
      key.disabled = draft.clearKey
      key.placeholder = stored ? '留空沿用已存密钥' : '无需认证时留空'
    }
    syncKey()

    const models = el('div', { className: 'yy-ai-model-list' })
    const addModel = el('button', { type: 'button', className: 'yy-btn yy-btn-sm yy-btn-ghost' },
      el('span', { className: 'yy-icon', html: icons.plus }), '添加模型')
    function showModels(focus?: number) {
      models.replaceChildren(...draft.provider.models.map((model, index) => {
        const input = el('input', {
          className: 'yy-input', type: 'text',
          attrs: { required: '', 'aria-label': `模型 ID ${index + 1}`, placeholder: '例如 qwen2.5:7b', spellcheck: 'false' },
        })
        input.value = model
        input.addEventListener('input', () => { draft.provider.models[index] = input.value })
        const remove = el('button', {
          type: 'button', className: 'yy-icon-btn', html: icons.close, attrs: { 'aria-label': `移除模型 ${index + 1}` },
        })
        remove.disabled = draft.provider.models.length === 1
        remove.addEventListener('click', () => {
          draft.provider.models.splice(index, 1)
          showModels(Math.min(index, draft.provider.models.length - 1))
        })
        const row = el('div', { className: 'yy-ai-model-entry' }, input, remove)
        if (focus === index) queueMicrotask(() => input.focus())
        return row
      }))
    }
    addModel.addEventListener('click', () => { draft.provider.models.push(''); showModels(draft.provider.models.length - 1) })
    showModels()
    if (listAiModels) discovery = modelDiscovery(listAiModels, () => ({
      id: draft.provider.id, endpoint: draft.provider.endpoint.trim(), protocol: draft.provider.protocol,
      key: draft.clearKey ? '' : draft.key.trim() || undefined,
    }), () => draft.provider.models, ids => {
      draft.provider.models = [...new Set([...draft.provider.models.map(model => model.trim()).filter(Boolean), ...ids])]
      showModels()
    })
    const modelActions = el('div', { className: 'yy-ai-model-actions' })
    if (discovery) modelActions.append(discovery.button)
    modelActions.append(addModel)
    const modelFields = el('section', { className: 'yy-ai-models', attrs: { 'aria-label': '模型' } },
      el('div', { className: 'yy-ai-models-head' }, el('span', { className: 'yy-field-label', text: '模型' }), modelActions), models)
    if (discovery) modelFields.append(discovery.panel)
    const status = el('p', { className: 'yy-ai-setting-help', text: notice, attrs: { role: 'status' } })
    editor.replaceChildren(
      labelled('供应商名称', name),
      el('div', { className: 'yy-ai-endpoint-fields' }, labelled('API 协议', protocol.button), labelled('API 地址', address)),
      labelled('API 密钥（可选）', key, '密钥保存在系统凭据存储中。'),
      clearLabel, modelFields, status,
    )
    if (saved) {
      const remove = el('button', { className: 'yy-btn yy-btn-sm yy-btn-ghost', type: 'button', text: '删除供应商' })
      const confirm = el('button', { className: 'yy-btn yy-btn-sm yy-btn-danger', type: 'button', text: '确认删除' })
      const cancel = el('button', { className: 'yy-btn yy-btn-sm yy-btn-ghost', type: 'button', text: '取消' })
      const alert = el('div', { className: 'yy-ai-provider-remove', attrs: { hidden: '' } },
        el('span', { text: '删除此供应商及其模型？' }), cancel, confirm)
      remove.addEventListener('click', () => { remove.hidden = true; alert.hidden = false; cancel.focus() })
      cancel.addEventListener('click', () => { alert.hidden = true; remove.hidden = false; remove.focus() })
      confirm.addEventListener('click', async () => {
        confirm.disabled = true
        const failure = await dispatch({ type: 'ai-provider-remove', id: saved.id })
        if (!editor.isConnected) return
        confirm.disabled = false
        if (failure) { status.textContent = failure; return }
        drafts.delete(saved.id)
        editing = settings().active?.providerId ?? settings().providers[0]?.id ?? fresh ?? makeNew()
        notice = settings().notice ?? '供应商已删除'
        render()
        list.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus()
      })
      editor.append(remove, alert)
    }
  }

  body.append(el('nav', { className: 'yy-ai-provider-nav' }, list, add), editor)
  render()
  openSettings(modals, {
    title: '模型配置', body, initialFocus: editor.querySelector<HTMLInputElement>('[name="provider-name"]')!,
    submitLabel: '保存配置', keepOpen: true, onClose: () => protocol?.close(),
    save: async () => {
      const draft = getDraft()
      const failure = await dispatch({
        type: 'ai-provider-save',
        provider: { ...draft.provider, models: [...draft.provider.models] },
        key: draft.clearKey ? '' : draft.key.trim() || undefined,
      })
      if (failure || !editor.isConnected) return failure
      const savedId = draft.provider.id
      if (settings().providers.some(item => item.id === savedId)) {
        if (fresh === savedId) fresh = null
        drafts.delete(savedId)
      }
      notice = settings().notice ?? '已保存'
      render()
    },
  })
}

export function openPromptSettings(modals: DialogPresenter, prompts: AiPrompts, initial: AiIntent, dispatch: Dispatch, agent = false) {
  const drafts = { ...prompts }
  let intent = initial
  const body = el('div', { className: 'yy-ai-prompt-settings' })
  const tasks = el('div', { className: 'yy-ai-task-list', attrs: { role: 'group', 'aria-label': '写作操作' } })
  const title = el('span', { className: 'yy-field-label' })
  const input = el('textarea', {
    className: 'yy-textarea yy-ai-template',
    attrs: { rows: '7', 'aria-label': '提示词内容' },
  })
  const field = el('label', { className: 'yy-field' })
  field.append(title, input)
  const reset = el('button', { className: 'yy-btn yy-btn-sm yy-btn-ghost', text: '恢复默认', type: 'button' })
  const preview = el('pre', { className: 'yy-scroll-area', attrs: { 'aria-label': '完整提示词', tabindex: '0' } })
  const full = el('details', { className: 'yy-ai-template-preview' },
    el('summary', { text: agent ? '预览智能体完整提示词' : '预览完整提示词' }), preview)
  const editor = el('div', { className: 'yy-ai-template-editor' })
  editor.append(field, reset, full)
  const buttons = new Map<AiIntent, HTMLButtonElement>()
  const updatePreview = () => {
    reset.disabled = input.value === aiTasks[intent].prompt
    preview.textContent = systemPrompt(intent, normalizePrompts(drafts), agent)
  }

  const showTask = () => {
    title.textContent = aiTasks[intent].label
    input.value = drafts[intent] ?? aiTasks[intent].prompt
    updatePreview()
    for (const [id, button] of buttons) button.setAttribute('aria-pressed', String(id === intent))
  }
  for (const id of aiIntents) {
    const button = el('button', { className: 'yy-ai-task-choice', type: 'button', text: aiTasks[id].label })
    button.addEventListener('click', () => {
      intent = id
      showTask()
    })
    buttons.set(id, button)
    tasks.append(button)
  }
  input.addEventListener('input', () => {
    drafts[intent] = input.value
    updatePreview()
  })
  reset.addEventListener('click', () => {
    delete drafts[intent]
    showTask()
    input.focus()
  })
  showTask()
  body.append(tasks, editor)
  openSettings(modals, {
    title: '默认提示词',
    description: '页屿在运行对应操作时使用这里的提示词。留空会使用内置内容。',
    body,
    initialFocus: buttons.get(initial)!,
    submitLabel: '保存提示词',
    save: () => dispatch({ type: 'ai-prompts', prompts: normalizePrompts(drafts) }),
  })
}

function labelled(title: string, input: HTMLElement, description?: string) {
  const field = el('label', { className: 'yy-field' })
  field.append(el('span', { className: 'yy-field-label', text: title }), input)
  if (description) field.append(el('span', { className: 'yy-ai-setting-help', text: description }))
  return field
}

function openSettings(modals: DialogPresenter, options: {
  title: string
  description?: string
  body: HTMLElement
  initialFocus: HTMLElement
  submitLabel: string
  save: () => ReturnType<Dispatch>
  keepOpen?: boolean
  onClose?: () => void
}) {
  const dialog = el('form', {
    className: 'yy-modal yy-ai-settings',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': options.title },
  })
  const header = el('header', { className: 'yy-ai-settings-head' })
  const heading = el('div')
  heading.append(el('h2', { text: options.title }))
  if (options.description) heading.append(el('p', { text: options.description }))
  const close = el('button', {
    className: 'yy-icon-btn', type: 'button', html: icons.close, attrs: { 'aria-label': '关闭' },
  })
  close.addEventListener('click', () => modals.close())
  header.append(heading, close)
  const fields = el('fieldset', { className: 'yy-ai-settings-fields' })
  fields.append(options.body)
  const status = el('p', { className: 'yy-ai-setting-error', attrs: { role: 'alert', hidden: '' } })
  const footer = el('footer', { className: 'yy-ai-settings-actions' })
  const cancel = el('button', { className: 'yy-btn yy-btn-ghost', text: '取消', type: 'button' })
  cancel.addEventListener('click', () => modals.close())
  const submit = el('button', { className: 'yy-btn yy-btn-primary', text: options.submitLabel, type: 'submit' })
  footer.append(cancel, submit)
  dialog.addEventListener('submit', async event => {
    event.preventDefault()
    if (submit.disabled) return
    fields.disabled = submit.disabled = true
    status.hidden = true
    try {
      const detail = await options.save()
      if (detail) throw new Error(detail)
      if (dialog.isConnected && !options.keepOpen) modals.close()
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error)
      status.hidden = false
    } finally {
      fields.disabled = submit.disabled = false
      if (options.keepOpen && dialog.isConnected && !dialog.contains(document.activeElement)) submit.focus({ preventScroll: true })
    }
  })
  dialog.append(header, fields, status, footer)
  modals.open(dialog, { initialFocus: options.initialFocus, onClose: options.onClose })
}
