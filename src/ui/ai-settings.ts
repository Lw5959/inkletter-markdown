import { aiIntents, aiTasks, normalizePrompts, systemPrompt } from '../ai-prompts'
import { detectedInputTokens, effortLabels, modelEfforts, modelImageInput, optionsForModel } from '../ai-models'
import type { AiIntent, AiModelOptions, AiPrompts, AiProtocol, AiProviderDraft, AiReasoningEffort, AiSettings, AiSkill, ShellActions } from '../contracts'
import type { DialogPresenter } from './dialogs'
import { modelDiscovery } from './ai-model-discovery'
import { ChoicePicker } from './choice-picker'
import { bindContextMenu, buttonCommand, copyCommand, selectedText, type ContextItem } from './context-menu'
import { el, selectWithIcon } from './helpers'
import { icons } from './icons'
import { detectMac } from './shortcuts'

type Dispatch = ShellActions['dispatch']

const protocols: Record<AiProtocol, { name: string; endpoint: string }> = {
  chat: { name: 'Chat Completions', endpoint: 'http://127.0.0.1:11434/v1' },
  anthropic: { name: 'Anthropic Messages', endpoint: 'https://api.anthropic.com/v1' },
  responses: { name: 'Responses', endpoint: 'https://api.openai.com/v1' },
}

type ModelDraft = { id: string; options: AiModelOptions }
type Draft = { provider: Omit<AiProviderDraft, 'models' | 'modelOptions'>; models: ModelDraft[]; key: string; clearKey: boolean }

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
    drafts.set(id, { provider: { id, name: '', endpoint: '', protocol: 'chat' }, models: [{ id: '', options: {} }], key: '', clearKey: false })
    return id
  }

  function getDraft(): Draft {
    const prior = drafts.get(editing)
    if (prior) return prior
    const saved = settings().providers.find(item => item.id === editing)!
    const { id, name, endpoint, protocol, models } = saved
    const draft = { provider: { id, name, endpoint, protocol },
      models: models.map(id => ({ id, options: structuredClone(optionsForModel(saved, id) ?? {}) })), key: '', clearKey: false }
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
      bindContextMenu(button, '供应商操作', () => {
        const commands: ContextItem[] = [buttonCommand('编辑供应商', button)]
        const provider = settings().providers.find(item => item.id === row.id)
        if (provider) {
          commands.push(copyCommand('复制 API 地址', provider.endpoint, button), {
            label: '删除供应商', run: () => {
              select(row.id)
              editor.querySelector<HTMLButtonElement>('[data-provider-remove]')?.click()
            },
          })
        }
        return commands
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
    address.addEventListener('input', () => {
      const changed = draft.provider.endpoint.trim() !== address.value.trim()
      draft.provider.endpoint = address.value
      if (changed) clearDetected()
      syncKey()
      discovery?.reset()
    })
    protocol = new ChoicePicker('API 协议', 'API 协议', value => {
      const changed = draft.provider.protocol !== value
      draft.provider.protocol = value as AiProtocol
      if (changed) clearDetected()
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
    const migrate = el('button', { className: 'yy-btn yy-btn-sm yy-btn-ghost', type: 'button', text: '迁移旧密钥' })
    function syncKey() {
      address.placeholder = protocols[draft.provider.protocol].endpoint
      const sameEndpoint = saved && address.value.trim() === saved.endpoint && draft.provider.protocol === saved.protocol
      const stored = sameEndpoint && saved.hasKey
      const canMigrate = sameEndpoint && saved.legacyKey
      clearLabel.hidden = !stored
      if (!stored) draft.clearKey = clearKey.checked = false
      key.disabled = draft.clearKey
      key.placeholder = canMigrate ? '填写新密钥，或迁移旧密钥' : stored ? '留空沿用已存密钥' : '无需认证时留空'
      migrate.hidden = !canMigrate || draft.clearKey || !!draft.key
    }
    syncKey()
    key.addEventListener('input', syncKey)

    const models = el('div', { className: 'yy-ai-model-list' })
    const addModel = el('button', { type: 'button', className: 'yy-btn yy-btn-sm yy-btn-ghost' },
      el('span', { className: 'yy-icon', html: icons.plus }), '添加模型')
    function clearDetected() {
      const cached = draft.models.filter(model => model.options.detected)
      for (const model of cached) delete model.options.detected
      if (cached.length) showModels()
    }
    function showModels(focus?: number) {
      models.replaceChildren(...draft.models.map((model, index) => {
        const { options } = model
        const input = el('input', {
          className: 'yy-input', type: 'text',
          attrs: { required: '', 'aria-label': `模型 ID ${index + 1}`, placeholder: '例如 qwen2.5:7b', spellcheck: 'false' },
        })
        input.value = model.id
        input.addEventListener('input', () => {
          if (input.value.trim() !== model.id.trim()) delete options.detected
          model.id = input.value
          syncDetected()
        })
        const displayName = el('input', { className: 'yy-input', type: 'text',
          attrs: { 'aria-label': `模型显示名 ${index + 1}`, maxlength: '128' } })
        displayName.value = options.displayName ?? ''
        displayName.addEventListener('input', () => { options.displayName = displayName.value.trim() || undefined })
        function tokenField(field: 'inputTokens' | 'outputTokens', label: string) {
          const entry = el('input', { className: 'yy-input', type: 'number',
            attrs: { min: '1', max: '4294967295', step: '1', 'aria-label': `模型${label} ${index + 1}` } })
          entry.value = options[field]?.toString() ?? ''
          entry.addEventListener('input', () => {
            options[field] = entry.value === '' ? undefined : entry.valueAsNumber
            syncTokenPlaceholders()
          })
          return entry
        }
        const inputTokens = tokenField('inputTokens', '输入上限')
        const outputTokens = tokenField('outputTokens', '输出上限')
        const effort = el('select', { className: 'yy-input', attrs: { 'aria-label': `模型思考强度 ${index + 1}` } })
        effort.addEventListener('change', () => { options.reasoningEffort = effort.value === 'default' ? undefined : effort.value as AiReasoningEffort })
        const imageInput = el('select', { className: 'yy-input', attrs: { 'aria-label': `模型图片输入 ${index + 1}` } })
        imageInput.addEventListener('change', () => { options.imageInput = imageInput.value === 'auto' ? undefined : imageInput.value === 'yes' })
        function syncTokenPlaceholders() {
          inputTokens.placeholder = detectedInputTokens(options)?.toString() ?? '自动'
          outputTokens.placeholder = options.detected?.outputTokens?.toString() ?? '自动'
        }
        function syncDetected() {
          displayName.placeholder = options.detected?.displayName || '留空使用模型 ID'
          syncTokenPlaceholders()
          const levels = modelEfforts(model.id.trim(), options)
          effort.replaceChildren(...levels.map(value => el('option', { attrs: { value }, text: effortLabels[value] })))
          effort.value = options.reasoningEffort ?? 'default'
          effort.disabled = levels.length === 1
          const vision = modelImageInput({ detected: options.detected })
          imageInput.replaceChildren(...[
            ['auto', vision === undefined ? '自动 · 未识别' : vision ? '自动 · 支持' : '自动 · 不支持'],
            ['yes', '支持'], ['no', '不支持'],
          ].map(([value, text]) => el('option', { attrs: { value }, text })))
          imageInput.value = options.imageInput === undefined ? 'auto' : options.imageInput ? 'yes' : 'no'
        }
        syncDetected()
        const remove = el('button', {
          type: 'button', className: 'yy-icon-btn', html: icons.close, attrs: { 'aria-label': `移除模型 ${index + 1}` },
        })
        remove.disabled = draft.models.length === 1
        remove.addEventListener('click', () => {
          draft.models.splice(index, 1)
          showModels(Math.min(index, draft.models.length - 1))
        })
        const row = el('div', { className: 'yy-ai-model-card' },
          el('div', { className: 'yy-ai-model-entry' }, labelled('模型 ID', input), labelled('显示名', displayName), remove),
          el('div', { className: 'yy-ai-model-limits' }, labelled('输入上限（Token）', inputTokens),
            labelled('输出上限（Token）', outputTokens), labelled('思考强度', selectWithIcon(effort)), labelled('图片输入', selectWithIcon(imageInput))))
        bindContextMenu(row, '模型操作', () => [
          { label: '编辑模型 ID', run: () => { input.focus(); input.select() } },
          ...(input.value.trim() ? [copyCommand('复制模型 ID', input.value.trim(), row)] : []),
          buttonCommand('移除模型', remove),
        ], remove)
        if (focus === index) queueMicrotask(() => input.focus())
        return row
      }))
    }
    addModel.addEventListener('click', () => { draft.models.push({ id: '', options: {} }); showModels(draft.models.length - 1) })
    showModels()
    if (listAiModels) discovery = modelDiscovery(listAiModels, () => ({
      id: draft.provider.id, endpoint: draft.provider.endpoint.trim(), protocol: draft.provider.protocol,
      key: draft.clearKey ? '' : draft.key.trim() || undefined,
    }), () => draft.models.map(model => model.id), (discovered, add) => {
      if (add) draft.models = draft.models.filter(model => model.id.trim() || Object.values(model.options).some(value => value !== undefined))
      for (const { id, metadata } of discovered) {
        const model = draft.models.find(model => model.id.trim() === id)
        if (model) model.options.detected = { ...model.options.detected, ...metadata }
        else if (add) draft.models.push({ id, options: { detected: metadata } })
      }
      showModels()
    })
    const modelActions = el('div', { className: 'yy-ai-model-actions' })
    if (discovery) modelActions.append(discovery.button)
    modelActions.append(addModel)
    const modelFields = el('section', { className: 'yy-ai-models', attrs: { 'aria-label': '模型' } },
      el('div', { className: 'yy-ai-models-head' }, el('span', { className: 'yy-field-label', text: '模型' }), modelActions), models)
    if (discovery) modelFields.append(discovery.panel)
    const status = el('p', { className: 'yy-ai-setting-help', text: notice, attrs: { role: 'status' } })
    migrate.onclick = async () => {
      if (!saved) return
      migrate.disabled = true
      status.textContent = '正在迁移旧密钥…'
      try {
        const failure = await dispatch({ type: 'ai-key-migrate', id: saved.id })
        if (!migrate.isConnected) return
        if (failure) status.textContent = failure
        else {
          notice = '密钥已移至墨笺密钥库'
          render()
        }
      } catch (error) {
        if (migrate.isConnected) status.textContent = error instanceof Error ? error.message : String(error)
      } finally { migrate.disabled = false }
    }
    editor.replaceChildren(
      labelled('供应商名称', name),
      el('div', { className: 'yy-ai-endpoint-fields' }, labelled('API 协议', protocol.button), labelled('API 地址', address)),
      labelled('API 密钥（可选）', key, detectMac() ? '密钥加密保存在墨笺密钥库。' : '密钥保存在系统凭据存储中。'),
      clearLabel, migrate, modelFields, status,
    )
    if (saved) {
      const remove = el('button', { className: 'yy-btn yy-btn-sm yy-btn-ghost', type: 'button', text: '删除供应商', attrs: { 'data-provider-remove': '' } })
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
      const models = draft.models.map(model => model.id.trim())
      const modelOptions = Object.fromEntries(draft.models
        .filter(({ options }) => Object.values(options).some(value => value !== undefined))
        .map(({ id, options }) => [id.trim(), options]))
      const failure = await dispatch({
        type: 'ai-provider-save',
        provider: { ...draft.provider, models, ...(Object.keys(modelOptions).length ? { modelOptions } : {}) },
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

export function openPromptSettings(modals: DialogPresenter, prompts: AiPrompts, initial: AiIntent, dispatch: Dispatch, agent = false, skill?: AiSkill) {
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
    preview.textContent = systemPrompt(intent, normalizePrompts(drafts), agent, skill)
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
  bindContextMenu(editor, '提示词操作', () => {
    const selection = selectedText(preview)
    return [
      ...(selection ? [copyCommand('复制所选文字', selection, preview)] : []),
      copyCommand('复制完整提示词', preview.textContent, preview), buttonCommand('恢复默认', reset),
    ]
  })
  showTask()
  body.append(tasks, editor)
  openSettings(modals, {
    title: '默认提示词',
    description: '墨笺在运行对应操作时使用这里的提示词。留空会使用内置内容。',
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
  const fields = el('fieldset', { className: 'yy-ai-settings-fields', attrs: { 'data-page-scroll': '' } })
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
