import { EditorState, StateEffect, StateField, Text } from '@codemirror/state'
import { invertedEffects } from '@codemirror/commands'

const endings = { L: '\n', R: '\r', D: '\r\n' } as const

// CM 使用单字符换行。第二棵持久化文本树只为换行附加类型标记和 CRLF 的额外宽度。
// 两棵树按行对齐，复用未编辑的子树。历史记录可直接恢复树根，包含仅改变换行的编辑。
export function encode(raw: string) {
  const parts = raw.split(/(\r\n|\r|\n)/)
  const lines: string[] = []
  const encoded: string[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i]
    const eol = parts[i + 1]
    lines.push(line)
    encoded.push(line + (eol ? tag(eol) : ''))
  }
  return { doc: Text.of(lines), raw: Text.of(encoded) }
}

function tag(eol: string) {
  return eol === '\r\n' ? ' D' : eol === '\r' ? 'R' : 'L'
}

export const restoreRaw = StateEffect.define<Text>()
export const rawBuffer = StateField.define<Text>({
  create: state => encode(state.doc.toString()).raw,
  update(raw, tr) {
    const restored = tr.effects.reduce((value, effect) => effect.is(restoreRaw) ? effect.value : value, null as Text | null)
    if (restored) return restored
    if (!tr.docChanged) return raw

    let result = raw
    let delta = 0
    tr.changes.iterChanges((from, to, _start, _end, insert) => {
      const start = encodedOffset(tr.startState.doc, raw, from)
      const end = encodedOffset(tr.startState.doc, raw, to)
      const line = tr.startState.doc.lineAt(from)
      const eol = line.number < raw.lines ? ending(raw.line(line.number).text)
        : raw.lines > 1 ? ending(raw.line(raw.lines - 1).text) : '\n'
      const added = Text.of(Array.from({ length: insert.lines }, (_, index) =>
        insert.line(index + 1).text + (index + 1 < insert.lines ? tag(eol) : '')))
      result = result.replace(start + delta, end + delta, added)
      delta += added.length - (end - start)
    })
    return result
  },
})

export const rawHistory = invertedEffects.of(tr =>
  tr.docChanged || tr.effects.some(effect => effect.is(restoreRaw))
    ? [restoreRaw.of(tr.startState.field(rawBuffer))]
    : [])

// 删除 CR 与 LF 之间的内容后，两条逻辑换行合并为原文中的一个 CRLF。
export const coalesceEndings = EditorState.transactionFilter.of(tr => {
  if (!tr.docChanged || tr.effects.some(effect => effect.is(restoreRaw))) return tr
  const doc = tr.newDoc
  const raw = tr.state.field(rawBuffer)
  const merges = new Set<number>()
  tr.changes.iterChangedRanges((_from, _to, start, end) => {
    for (let n = Math.max(2, doc.lineAt(start).number); n <= Math.min(doc.lines - 1, doc.lineAt(end).number); n++) {
      if (doc.line(n).length === 0 && ending(raw.line(n - 1).text) === '\r' && ending(raw.line(n).text) === '\n') merges.add(n)
    }
  })
  if (!merges.size) return tr
  let next = raw
  const changes = [...merges].sort((a, b) => b - a).map(n => {
    next = next.replace(raw.line(n).from - 2, raw.line(n).to, Text.of([' D']))
    const from = doc.line(n).from - 1
    return { from, to: from + 1 }
  })
  return [tr, { changes, effects: restoreRaw.of(next), sequential: true }]
})

function ending(line: string) {
  return endings[line.at(-1) as keyof typeof endings]
}

export function encodedOffset(doc: Text, raw: Text, position: number) {
  const line = doc.lineAt(position)
  return raw.line(line.number).from + position - line.from
}

export function originalOffset(doc: Text, raw: Text, position: number) {
  const line = doc.lineAt(position)
  return raw.line(line.number).from - (line.number - 1) + position - line.from
}

// 原文的 CRLF 内部可有 API 偏移，在视图中与行尾共用一个插入点。
export function locate(doc: Text, raw: Text, offset: number) {
  let low = 1
  let high = raw.lines
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (raw.line(mid).from - (mid - 1) <= offset) low = mid
    else high = mid - 1
  }
  const line = doc.line(low)
  const column = offset - raw.line(low).from + low - 1
  return { pos: line.from + Math.min(line.length, column), inside: Math.max(0, column - line.length) }
}

export function originalSlice(doc: Text, raw: Text, from = 0, to = doc.length) {
  const first = doc.lineAt(from)
  const last = doc.lineAt(to)
  if (first.number === last.number) return first.text.slice(from - first.from, to - first.from)
  const result: string[] = []
  const rows = raw.iterRange(raw.line(first.number).from, raw.line(last.number).from)
  let skip = from - first.from
  for (let next = rows.next(); !next.done; next = rows.next()) {
    if (next.lineBreak) continue
    const eol = ending(next.value)
    result.push(next.value.slice(skip, -eol.length), eol)
    skip = 0
  }
  result.push(last.text.slice(0, to - last.from))
  return result.join('')
}
