import { parser } from '@lezer/markdown'
import type { OutlineEntry } from '../contracts'
import { headingId, headingText } from './render'
import { frontMatter } from './front-matter'

// 全量解析移动到统计 Worker，实时装饰继续读 CodeMirror 的增量树。
export function outlineMarkdown(markdown: string): OutlineEntry[] {
  const crlf = [...markdown.matchAll(/\r\n/g)].map((match, index) => match.index - index)
  const normalized = markdown.replace(/\r\n?/g, '\n')
  const yaml = frontMatter(normalized)
  const entries: OutlineEntry[] = []
  const used = new Set<string>()
  let offset = 0
  parser.parse(normalized).iterate({ enter(node) {
    const heading = /^(ATX|Setext)Heading([1-6])$/.exec(node.name)
    if (!heading || node.from < (yaml?.[0].length ?? 0)) return
    while (offset < crlf.length && crlf[offset] < node.from) offset++
    const title = headingText(normalized.slice(node.from, node.to)
      .replace(/^#{1,6}[ \t]*|[ \t]+#+[ \t]*$/g, '').replace(/\n[ \t]*[=-]+[ \t]*$/, '').trim())
    entries.push({ level: Number(heading[2]), title, from: node.from + offset, id: headingId(title, used) })
  } })
  return entries
}
