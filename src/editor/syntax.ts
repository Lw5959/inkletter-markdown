import { Emoji, GFM, Subscript, Superscript } from '@lezer/markdown'
import type { MarkdownConfig } from '@lezer/markdown'

const marker = { resolve: 'Highlight', mark: 'HighlightMark' }
const Highlight: MarkdownConfig = {
  defineNodes: ['Highlight', 'HighlightMark'],
  parseInline: [{
    name: 'Highlight',
    parse(context, char, position) {
      if (char !== 61 || context.char(position + 1) !== 61) return -1
      const before = context.slice(position - 1, position)
      const after = context.slice(position + 2, position + 3)
      if (before === '=' || after === '=') return -1
      return context.addDelimiter(marker, position, position + 2, !!after.trim(), !!before.trim())
    },
  }],
}

// 使用源码缓冲区提供标记边界，实时视图只装饰当前视窗，不重写 Markdown。
export const markdownSyntax = [GFM, Subscript, Superscript, Emoji, Highlight]
