import type { AiMessage } from './contracts'
import { invoke } from './native'

export type Conversation = {
  id: string
  scope: string
  title: string
  messages: AiMessage[]
  summary: string
  covered: number
  updated: number
}

type Snapshot = { conversations: Conversation[]; selected: Record<string, string> }

export class ConversationArchive {
  private data: Snapshot = { conversations: [], selected: {} }
  private queue = Promise.resolve()

  async load() {
    const saved = await invoke<Snapshot | null>('ai_conversations')
    if (!saved || !Array.isArray(saved.conversations)) return
    this.data = { conversations: saved.conversations, selected: saved.selected ?? {} }
  }

  list(scope: string) {
    return this.data.conversations.filter(item => item.scope === scope).sort((a, b) => b.updated - a.updated)
  }

  current(scope: string): Conversation | null {
    if (!scope) return null
    const items = this.list(scope)
    return items.find(item => item.id === this.data.selected[scope]) ?? items[0] ?? this.create(scope)
  }

  create(scope: string) {
    const item: Conversation = { id: crypto.randomUUID(), scope, title: '新对话', messages: [], summary: '', covered: 0, updated: Date.now() }
    this.data.conversations.unshift(item)
    this.data.selected[scope] = item.id
    return item
  }

  get(scope: string, id: string) {
    const item = this.data.conversations.find(chat => chat.scope === scope && chat.id === id)
    if (!item) throw new Error('此对话已移除')
    return item
  }

  select(scope: string, id: string) {
    const item = this.get(scope, id)
    this.data.selected[scope] = id
    return item
  }

  remove(item: Conversation) {
    this.data.conversations = this.data.conversations.filter(chat => chat !== item)
    if (this.data.selected[item.scope] === item.id) delete this.data.selected[item.scope]
  }

  async save() {
    // 原子写入独立的会话记录，异步保存按顺序提交，避免旧快照覆盖新消息。
    const value = structuredClone(this.data)
    const next = this.queue.then(() => invoke<void>('ai_conversations', { value }))
    this.queue = next.catch(() => {})
    await next
  }
}

export function compressionEnd(chat: Conversation, automatic = false, end = chat.messages.length) {
  // 保留最近的完整问答。自动压缩在旧历史累积到预算后触发。
  const tail = automatic ? 6 : 2
  const stop = Math.max(chat.covered, end - tail)
  if (automatic && chat.messages.slice(chat.covered, end).reduce((size, item) => size + item.text.length, chat.summary.length) < 18_000) {
    return chat.covered
  }
  let position = stop
  while (position > chat.covered && chat.messages[position]?.role === 'assistant') position--
  return position
}
