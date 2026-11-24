import { diffLines } from 'diff'
import type { DiffPart, Suggestion } from './contracts'

export type Range = { from: number; to: number }
export type Binding = Range & { doc: number; revision: number; text: string; before: string; after: string }
export type PendingSuggestion = { view: Suggestion; binding: Binding; mcpId?: string }

export function bind(doc: number, revision: number, source: string, range: Range): Binding {
  return {
    ...range, doc, revision, text: source.slice(range.from, range.to),
    before: source.slice(Math.max(0, range.from - 80), range.from),
    after: source.slice(range.to, range.to + 80),
  }
}

export function relocate(binding: Binding, doc: number, revision: number, markdown: string): Range | null {
  if (doc !== binding.doc) return null
  if (binding.revision === revision) return { from: binding.from, to: binding.to }
  // 区间及周围原文必须仍可唯一定位。空选区同样用左右锚点绑定。
  const needle = binding.before + binding.text + binding.after
  if (!needle) return markdown ? null : { from: 0, to: 0 }
  const found = markdown.indexOf(needle)
  if (found < 0 || markdown.indexOf(needle, found + 1) !== -1) return null
  const from = found + binding.before.length
  return { from, to: from + binding.text.length }
}

export function suggestion(source: 'ai' | 'mcp', title: string, target: Binding, response: string, mcpId?: string): PendingSuggestion {
  // 用固定上限避免极端改写长文档时让差异计算阻塞界面。
  const diff = diffLines(target.text, response, { maxEditLength: 4_000, timeout: 80 })
  const changes = diff ?? [
    { removed: true, added: false, value: target.text },
    { removed: false, added: true, value: response },
  ].filter(change => change.value)
  let hunks = 0
  let inHunk = false
  const parts: DiffPart[] = changes.map(change => {
    const kind = change.added ? 'add' : change.removed ? 'remove' : 'keep'
    if (kind === 'keep') {
      inHunk = false
      return { kind, text: change.value }
    }
    if (!inHunk) hunks++
    inHunk = true
    return { kind, text: change.value, hunk: hunks - 1 }
  })
  return { view: { id: crypto.randomUUID(), title, source, parts, hunks }, binding: target, mcpId }
}

export function chooseHunks(parts: DiffPart[], hunks: number[]) {
  const selected = new Set(hunks)
  return parts.filter(part => part.kind === 'keep' || (part.kind === 'add') === selected.has(part.hunk!))
    .map(part => part.text).join('')
}
