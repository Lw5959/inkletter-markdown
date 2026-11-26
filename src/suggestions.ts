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

export function markdownDiff(original: string, response: string) {
  // 用固定上限避免极端改写长文档时让差异计算阻塞界面。
  const diff = diffLines(original, response, { maxEditLength: 4_000, timeout: 80 })
  return diff ?? [
    { removed: true, added: false, value: original },
    { removed: false, added: true, value: response },
  ].filter(change => change.value)
}

export function writingMarkdown(markdown: string, target: Binding, eol: string) {
  const breaks = /\r\n|[\r\n]/g
  if (!target.text) {
    const text = markdown.replace(breaks, eol)
    const gap = (left: string, right: string) => {
      if (!left.trim() || !right.trim()) return ''
      const boundary = (left.match(/\s*$/)?.[0] ?? '') + (right.match(/^\s*/)?.[0] ?? '')
      return eol.repeat(Math.max(0, 2 - (boundary.match(breaks)?.length ?? 0)))
    }
    return gap(target.before, text) + text + gap(text, target.after)
  }
  const endings = target.text.match(breaks) ?? []
  const original = target.text.replace(breaks, '\n')
  const changes = markdownDiff(original, markdown.replace(breaks, '\n'))
  let line = 0
  // 模型通常返回 LF。保留未改动行原有的换行符，新行沿用改稿范围的换行风格。
  return changes.map(change => {
    if (change.removed) {
      line += change.value.match(/\n/g)?.length ?? 0
      return ''
    }
    return change.value.replace(/\n/g, () => change.added ? endings[0] ?? eol : endings[line++] ?? eol)
  }).join('')
}

export function suggestion(source: Suggestion['source'], title: string, target: Binding, response: string, mcpId?: string): PendingSuggestion {
  const changes = markdownDiff(target.text, response)
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
