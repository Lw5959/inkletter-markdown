import type { EditorFormat } from '../contracts'

const inline = {
  bold: ['**', '**'], italic: ['*', '*'], strike: ['~~', '~~'],
  underline: ['<u>', '</u>'], highlight: ['==', '=='], subscript: ['~', '~'], superscript: ['^', '^'], 'inline-code': ['`', '`'],
  link: ['[', '](https://)'], image: ['![', '](图片路径)'],
} as const

const prefixes = {
  'heading-1': '# ', 'heading-2': '## ', 'heading-3': '### ', quote: '> ',
  'bullet-list': '- ', 'ordered-list': '1. ', task: '- [ ] ',
} as const

function ticks(value: string, minimum: number) {
  let length = minimum
  for (const match of value.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1)
  return '`'.repeat(length)
}

export function applyFormat(kind: EditorFormat, value: string, eol: string) {
  if (kind in inline) {
    let [before, after]: readonly [string, string] = inline[kind as keyof typeof inline]
    if (kind === 'inline-code' && value.includes('`')) {
      const delimiter = ticks(value, 1)
      before = delimiter + ' '
      after = ' ' + delimiter
    }
    if (value.startsWith(before) && value.endsWith(after) && value.length >= before.length + after.length) {
      const text = value.slice(before.length, -after.length)
      return { text, start: 0, end: text.length }
    }
    return { text: before + value + after, start: before.length, end: before.length + value.length }
  }
  if (kind in prefixes) {
    const prefix = prefixes[kind as keyof typeof prefixes]
    const text = value.split(/(\r\n|\r|\n)/).map((line, i) => {
      if (i % 2) return line
      if (kind.startsWith('heading-')) return prefix + line.replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/, '')
      if (kind === 'quote') return prefix + line
      const [, indent, tail] = /^([ \t]*)([\s\S]*)$/.exec(line)!
      return indent + prefix + tail.replace(/^(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/, '')
    }).join('')
    return { text, start: 0, end: text.length }
  }

  const fence = ticks(value, 3)
  const [before, body, after] = {
    'table': ['', '| 标题 | 标题 |\n| --- | --- |\n| 内容 | 内容 |', ''],
    'code-block': [fence + '\n', value, '\n' + fence],
    math: ['$$\n', value || 'x^2', '\n$$'],
    mermaid: [fence + 'mermaid\n', value || 'flowchart TD\n  A --> B', '\n' + fence],
    rule: ['', '---', ''],
    toc: ['', '[TOC]', ''],
    footnote: ['[^note]: ', value || '脚注内容', ''],
    clear: ['', value
      .replace(/^(?:#{1,6}|>|[-+*](?: \[[ xX]\])?|\d+[.)]) +/gm, '')
      .replace(/(\*\*|__|~~|`+|\*|_)(.+?)\1/g, '$2')
      .replace(/<u>(.*?)<\/u>/gi, '$1')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1'), ''],
  }[kind as Exclude<EditorFormat, keyof typeof inline | keyof typeof prefixes>]
  const prefix = before.replace(/\n/g, eol)
  const content = kind === 'code-block' || (value && (kind === 'math' || kind === 'mermaid' || kind === 'footnote' || kind === 'clear'))
    ? body : body.replace(/\n/g, eol)
  return { text: prefix + content + after.replace(/\n/g, eol), start: prefix.length, end: prefix.length + content.length }
}

export const lineFormats = new Set<string>(Object.keys(prefixes))
export const blockFormats = new Set<EditorFormat>(['table', 'code-block', 'math', 'mermaid', 'rule', 'toc', 'footnote'])
