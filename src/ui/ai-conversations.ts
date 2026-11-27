import type { AiConversations, AiView, ShellAction, ShellActions } from '../contracts'
import type { DialogPresenter } from './dialogs'
import { el } from './helpers'
import { icons } from './icons'

export function contextSummary() {
  const title = el('summary')
  const body = el('pre', { className: 'yy-context-fulltext', attrs: { tabindex: '0' } })
  const element = el('details', { className: 'yy-ai-compaction', attrs: { hidden: '' } }, title, body)
  let chat: string | null | undefined
  return { element, update(chats: AiConversations | undefined) {
    if (chat !== chats?.active) element.open = false
    chat = chats?.active
    const summary = chats?.summary
    element.hidden = !summary
    if (!summary) { body.textContent = ''; return }
    const caption = `上下文摘要 · ${chats.covered} 条 · ${summary.originalCharacters.toLocaleString('zh-CN')} → ${summary.text.length.toLocaleString('zh-CN')} 字符`
    if (title.textContent !== caption) title.textContent = caption
    if (body.textContent !== summary.text) body.textContent = summary.text
  } }
}

export function openConversations(modals: DialogPresenter, view: () => AiView, dispatch: ShellActions['dispatch'], closed: () => void) {
  const panel = el('div', { className: 'yy-modal yy-ai-settings yy-ai-chat-settings',
    attrs: { role: 'dialog', 'aria-label': '对话管理', 'aria-modal': 'true' } })
  const close = el('button', { type: 'button', className: 'yy-icon-btn', html: icons.close, attrs: { 'aria-label': '关闭' } })
  close.onclick = () => modals.close()
  const create = el('button', { type: 'button', className: 'yy-btn yy-btn-primary', text: '新建对话' })
  const compact = el('button', { type: 'button', className: 'yy-btn yy-btn-sm', text: '压缩上下文' })
  const cancel = el('button', { type: 'button', className: 'yy-btn yy-btn-sm', text: '取消压缩', attrs: { hidden: '' } })
  const summary = el('span', { className: 'yy-muted-note', attrs: { role: 'status' } })
  const preview = contextSummary()
  const list = el('div', { className: 'yy-ai-chat-list', attrs: { 'aria-label': '对话列表' } })
  const error = el('p', { className: 'yy-ai-setting-error', attrs: { role: 'alert', hidden: '' } })
  const group = el('div', { className: 'yy-ai-chat-controls' }, create, compact, cancel, summary)
  panel.append(el('header', { className: 'yy-ai-settings-head' }, el('h2', { text: '对话管理' }), close),
    el('div', { className: 'yy-ai-settings-fields' }, group, preview.element, list, error))
  let shown: AiConversations | undefined | null = null
  let busy = false

  async function apply(action: ShellAction, navigate = false) {
    if (busy && action.type !== 'ai-cancel') return
    const cancellable = action.type === 'ai-cancel'
    if (!cancellable) busy = true
    error.hidden = true
    refresh()
    try {
      const failure = await dispatch(action)
      if (failure) throw new Error(failure)
      if (navigate && panel.isConnected) modals.close()
    } catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : String(failure)
      error.hidden = false
    } finally {
      if (!cancellable) busy = false
      refresh()
    }
  }

  create.onclick = () => { void apply({ type: 'ai-chat-new' }, true) }
  compact.onclick = () => { void apply({ type: 'ai-compress' }) }
  cancel.onclick = () => { void apply({ type: 'ai-cancel' }) }

  function row(chat: AiConversations['items'][number], current: boolean) {
    const entry = el('div', { className: 'yy-ai-chat-row' })
    const name = el('button', { type: 'button', className: 'yy-ai-chat-name',
      attrs: { 'aria-pressed': String(current) } }, el('strong', { text: chat.title }))
    name.onclick = () => { void apply({ type: 'ai-chat-select', id: chat.id }, true) }
    const rename = el('button', { type: 'button', className: 'yy-icon-btn', html: icons.edit, attrs: { 'aria-label': '重命名 ' + chat.title } })
    const remove = el('button', { type: 'button', className: 'yy-icon-btn', html: icons.trash, attrs: { 'aria-label': '删除 ' + chat.title } })
    const display = () => entry.replaceChildren(name, rename, remove)
    rename.onclick = () => {
      if (busy || view().pending) return
      const input = el('input', { className: 'yy-input', type: 'text', attrs: { 'aria-label': '对话标题', maxlength: '128', required: '' } })
      input.value = chat.title
      const keep = el('button', { className: 'yy-btn yy-btn-sm', type: 'button', text: '取消' })
      keep.onclick = display
      const done = el('button', { className: 'yy-btn yy-btn-sm yy-btn-primary', type: 'submit', text: '保存标题' })
      const form = el('form', { className: 'yy-ai-chat-edit' }, input, keep, done)
      form.addEventListener('submit', event => {
        event.preventDefault()
        void apply({ type: 'ai-chat-rename', id: chat.id, title: input.value })
      })
      entry.replaceChildren(form)
      input.focus()
      input.select()
    }
    remove.onclick = () => {
      if (busy || view().pending) return
      const keep = el('button', { className: 'yy-btn yy-btn-sm', type: 'button', text: '取消' })
      keep.onclick = display
      const confirm = el('button', { className: 'yy-btn yy-btn-sm yy-btn-danger', type: 'button', text: '确认删除' })
      confirm.onclick = () => { void apply({ type: 'ai-chat-remove', id: chat.id }) }
      entry.replaceChildren(el('span', { text: '删除「' + chat.title + '」及其消息？' }), keep, confirm)
      keep.focus()
    }
    display()
    return entry
  }

  function refresh() {
    const state = view()
    const chats = state.conversations
    const locked = busy || state.pending
    create.disabled = locked || !state.settings.active
    compact.disabled = locked || !chats?.canCompress
    cancel.hidden = !state.compacting
    summary.textContent = state.compacting ? '正在压缩上下文…' : chats?.covered ? '已压缩 ' + chats.covered + ' 条消息' : ''
    if (chats !== shown) {
      shown = chats
      preview.update(chats)
      list.replaceChildren(...(chats?.items ?? []).map(chat => row(chat, chat.id === chats?.active)))
      if (!chats?.items.length) list.append(el('p', { className: 'yy-muted-note', text: '配置模型后即可新建对话' }))
    }
    for (const item of list.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) item.disabled = locked
  }
  refresh()
  modals.open(panel, { initialFocus: create, onClose: closed })
  return refresh
}
