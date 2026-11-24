import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { history, undo } from '@codemirror/commands'
import { defaultMarkdownParser, defaultMarkdownSerializer } from 'prosemirror-markdown'

describe('编辑器架构试验', () => {
  it('默认 ProseMirror 往返会改写原始 Markdown 标记', () => {
    const original = '# 中文标题\n\n-   第一条\n-   第二条\n\n[引用][link]\n\n[link]: https://example.org\n'
    expect(defaultMarkdownSerializer.serialize(defaultMarkdownParser.parse(original))).not.toBe(original)
  })

  it('源码缓冲区可在样式切换时共享选区和撤销记录', () => {
    const state = EditorState.create({ doc: '# 中文', extensions: [history()] })
    const typed = state.update({ changes: { from: 4, insert: '输入' }, selection: { anchor: 6 } }).state
    expect(typed.doc.toString()).toBe('# 中文输入')
    expect(typed.selection.main.anchor).toBe(6)
    expect(undo({ state: typed, dispatch: transaction => {
      expect(transaction.newDoc.toString()).toBe('# 中文')
    } })).toBe(true)
  })
})
