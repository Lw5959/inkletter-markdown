import type { Editor, FindQuery, Selection } from './contracts'
import type { Range } from './suggestions'

const han = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/gu
const words = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu

export function count(text: string) {
  let cjk = 0
  let wordCount = 0
  for (const _ of text.matchAll(han)) cjk++
  for (const _ of text.replace(han, ' ').matchAll(words)) wordCount++
  return { words: wordCount + cjk, characters: Array.from(text).length }
}

export function cursor(text: string, offset: number) {
  const before = text.slice(0, offset)
  let line = 1
  let start = 0
  for (const m of before.matchAll(/\r\n|[\r\n]/g)) {
    line++
    start = m.index + m[0].length
  }
  return { line, column: Array.from(before.slice(start)).length + 1 }
}

export function lineOffset(text: string, line: number) {
  if (line <= 1) return 0
  for (const m of text.matchAll(/\r\n|[\r\n]/g)) {
    if (--line === 1) return m.index + m[0].length
  }
  return text.length
}

export function interval(selection: Selection): Range {
  const { anchor, head } = selection
  return { from: Math.min(anchor, head), to: Math.max(anchor, head) }
}

export function paragraph(text: string, offset: number): Range {
  let from = 0
  for (const m of text.matchAll(/(?:\r\n|[\n\r])[^\S\r\n]*(?:\r\n|[\n\r])/g)) {
    if (m.index > offset) return { from, to: m.index }
    from = m.index + m[0].length
  }
  return { from: Math.min(offset, from), to: text.length }
}

function finder(query: FindQuery) {
  const needle = query.regex ? query.text : query.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = query.wholeWord ? '(?<![\\p{L}\\p{N}_])(?:' + needle + ')(?![\\p{L}\\p{N}_])' : needle
  return new RegExp(pattern, query.matchCase ? 'gmu' : 'gimu')
}

function replacement(match: RegExpMatchArray, source: string, query: FindQuery): string {
  if (!query.regex) return query.replacement
  // 替换文本沿用系统正则组规则，同时接受 $0 表示完整匹配。
  return query.replacement.replace(/\$(\$|&|`|'|\d{1,2}|<[^>]+>)/g, (literal, group: string) => {
    if (group === '$') return '$'
    if (group === '&' || group === '0') return match[0]
    if (group === '`') return source.slice(0, match.index!)
    if (group === "'") return source.slice(match.index! + match[0].length)
    if (group.startsWith('<')) return match.groups?.[group.slice(1, -1)] ?? literal
    return Number(group) < match.length ? match[Number(group)] ?? '' : literal
  })
}

export function find(editor: Editor, query: FindQuery, operation: 'next' | 'previous' | 'replace' | 'replace-all'): string {
  if (!query.text) return '请输入查找内容'
  const source = editor.getMarkdown()
  const matches = [...source.matchAll(finder(query))]
  if (!matches.length) return '没有匹配项'
  if (operation === 'replace-all') {
    let start = 0
    const parts: string[] = []
    for (const match of matches) {
      parts.push(source.slice(start, match.index), replacement(match, source, query))
      start = match.index! + match[0].length
    }
    parts.push(source.slice(start))
    editor.replace(0, source.length, parts.join(''))
    return '已替换 ' + matches.length + ' 处'
  }
  const range = interval(editor.getSelection())
  const active = matches.findIndex(match => match.index === range.from && match[0].length === range.to - range.from)
  let previous = matches.length - 1
  if (operation === 'previous' && active < 0) {
    while (previous >= 0 && matches[previous].index! >= range.from) previous--
    if (previous < 0) previous = matches.length - 1
  }
  const index = operation === 'previous'
    ? (active >= 0 ? (active - 1 + matches.length) % matches.length : previous)
    : operation === 'replace' && active >= 0 ? active
      : active >= 0 ? (active + 1) % matches.length : Math.max(0, matches.findIndex(match => match.index! >= range.to))
  const match = matches[index]
  const from = match.index!
  const to = from + match[0].length
  if (operation === 'replace') {
    const next = replacement(match, source, query)
    editor.replace(from, to, next)
    editor.select({ anchor: from, head: from + next.length })
    return '已替换 1 处'
  }
  editor.select({ anchor: from, head: to })
  return '第 ' + (index + 1) + ' 项，共 ' + matches.length + ' 项'
}
