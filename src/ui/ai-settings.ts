import { aiIntents, aiTasks, normalizePrompts } from '../ai-prompts'
import type { AiIntent, AiPrompts, AiProtocol, AiSettings, ShellActions } from '../contracts'
import type { ModalManager } from './dialogs'
import { el, selectWithIcon } from './helpers'
import { icons } from './icons'

type Dispatch = ShellActions['dispatch']

const protocols: Record<AiProtocol, { name: string; endpoint: string }> = {
  chat: { name: 'Chat Completions', endpoint: 'http://127.0.0.1:11434/v1' },
  anthropic: { name: 'Anthropic Messages', endpoint: 'https://api.anthropic.com/v1' },
  responses: { name: 'Responses', endpoint: 'https://api.openai.com/v1' },
}

export function openModelSettings(modals: ModalManager, settings: AiSettings, dispatch: Dispatch) {
  const protocol = el('select', { className: 'yy-input' })
  for (const [value, entry] of Object.entries(protocols)) {
    protocol.append(el('option', { text: entry.name, attrs: { value } }))
  }
  protocol.value = settings.protocol
  const endpoint = el('input', {
    className: 'yy-input', type: 'url',
    attrs: { required: '', spellcheck: 'false' },
  })
  endpoint.value = settings.endpoint
  const model = el('input', {
    className: 'yy-input', type: 'text',
    attrs: { required: '', placeholder: '例如 qwen2.5:7b', spellcheck: 'false' },
  })
  model.value = settings.model
  const key = el('input', {
    className: 'yy-input', type: 'password',
    attrs: { autocomplete: 'new-password', placeholder: settings.hasKey ? '留空沿用该地址已存的密钥' : '无需认证时留空' },
  })
  const deleteKey = el('input', { type: 'checkbox' })
  const deleteLabel = el('label', { className: 'yy-ai-delete-key' })
  deleteLabel.append(deleteKey, document.createTextNode('删除此地址已存的密钥'))
  const syncKey = () => {
    const hasExisting = settings.hasKey && endpoint.value.trim() === settings.endpoint && protocol.value === settings.protocol
    deleteLabel.hidden = !hasExisting
    if (!hasExisting) deleteKey.checked = false
    key.disabled = deleteKey.checked
    key.placeholder = hasExisting ? '留空沿用该地址已存的密钥' : '无需认证时留空'
  }
  const syncProtocol = () => {
    endpoint.placeholder = protocols[protocol.value as AiProtocol].endpoint
    syncKey()
  }
  protocol.addEventListener('change', syncProtocol)
  endpoint.addEventListener('input', syncKey)
  deleteKey.addEventListener('change', syncKey)
  syncProtocol()

  const fields = el('div', { className: 'yy-ai-model-fields' })
  fields.append(
    labelled('API 协议', selectWithIcon(protocol)),
    labelled('API 地址', endpoint, '远程服务使用 HTTPS。本机服务可使用 HTTP。'),
    labelled('模型名称', model),
    labelled('API 密钥（可选）', key, '密钥保存在系统凭据存储中。'),
    deleteLabel,
  )
  openSettings(modals, {
    title: '模型配置',
    description: '填写本地或远程模型的连接信息。',
    body: fields,
    initialFocus: endpoint,
    submitLabel: '保存配置',
    save: () => dispatch({
      type: 'ai-config',
      endpoint: endpoint.value.trim(),
      model: model.value.trim(),
      protocol: protocol.value as AiProtocol,
      key: deleteKey.checked ? '' : key.value.trim() || undefined,
    }),
  })
}

export function openPromptSettings(modals: ModalManager, prompts: AiPrompts, initial: AiIntent, dispatch: Dispatch) {
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
  const editor = el('div', { className: 'yy-ai-template-editor' })
  editor.append(field, reset)
  const buttons = new Map<AiIntent, HTMLButtonElement>()

  const showTask = () => {
    title.textContent = aiTasks[intent].label
    input.value = drafts[intent] ?? aiTasks[intent].prompt
    reset.disabled = input.value === aiTasks[intent].prompt
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
    reset.disabled = input.value === aiTasks[intent].prompt
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

function openSettings(modals: ModalManager, options: {
  title: string
  description: string
  body: HTMLElement
  initialFocus: HTMLElement
  submitLabel: string
  save: () => ReturnType<Dispatch>
}) {
  const dialog = el('form', {
    className: 'yy-modal yy-ai-settings',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': options.title },
  })
  const header = el('header', { className: 'yy-ai-settings-head' })
  const heading = el('div')
  heading.append(el('h2', { text: options.title }), el('p', { text: options.description }))
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
      if (dialog.isConnected) modals.close()
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error)
      status.hidden = false
    } finally {
      fields.disabled = submit.disabled = false
    }
  })
  dialog.append(header, fields, status, footer)
  modals.open(dialog, { initialFocus: options.initialFocus })
}
