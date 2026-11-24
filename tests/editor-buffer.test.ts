import { expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { history, redo, undo } from '@codemirror/commands'
import { coalesceEndings, encode, locate, originalOffset, originalSlice, rawBuffer, rawHistory, restoreRaw } from '../src/editor/buffer'

it('区分 LF、CR、CRLF，原样保留末尾换行和 emoji UTF-16 宽度', () => {
  const source = '甲😀\r\n\n乙\r\r\n尾\n'
  const { doc, raw } = encode(source)
  expect(originalSlice(doc, raw)).toBe(source)
  expect(originalSlice(doc, raw, 2, 7)).toBe(source.slice(2, 8))
  for (let offset = 0; offset <= source.length; offset++) {
    const { pos, inside } = locate(doc, raw, offset)
    expect(originalOffset(doc, raw, pos) + inside).toBe(offset)
  }
})

it('撤销和重做复原混合换行，包括规范化文本完全一致的换行编辑', () => {
  const { doc, raw } = encode('甲\r\n乙\r丙\n')
  let state = EditorState.create({ doc, extensions: [rawBuffer, rawBuffer.init(() => raw), rawHistory, history()] })
  const text = () => originalSlice(state.doc, state.field(rawBuffer))
  const changed = encode('甲\n乙\r丙\n')
  state = state.update({ effects: restoreRaw.of(changed.raw) }).state
  expect(text()).toBe('甲\n乙\r丙\n')
  state = state.update({ changes: { from: 2, insert: 'xyz\n' } }).state
  expect(text()).toBe('甲\nxyz\r乙\r丙\n')
  const command = (action: typeof undo) => action({ state, dispatch: tr => { state = tr.state } })
  command(undo)
  expect(text()).toBe('甲\n乙\r丙\n')
  command(undo)
  expect(text()).toBe('甲\r\n乙\r丙\n')
  command(redo)
  command(redo)
  expect(text()).toBe('甲\nxyz\r乙\r丙\n')
})

it('键盘删除夹在 CR 和 LF 之间的文字时合并逻辑行，撤销后完整还原', () => {
  const source = '甲\r乙\n尾'
  const { doc, raw } = encode(source)
  let state = EditorState.create({ doc, extensions: [rawBuffer, rawBuffer.init(() => raw), rawHistory, coalesceEndings, history()] })
  state = state.update({ changes: { from: 2, to: 3 }, selection: { anchor: 2 }, userEvent: 'delete' }).state
  expect(state.doc.toString()).toBe('甲\n尾')
  expect(originalSlice(state.doc, state.field(rawBuffer))).toBe('甲\r\n尾')
  expect(undo({ state, dispatch: tr => { state = tr.state } })).toBe(true)
  expect(originalSlice(state.doc, state.field(rawBuffer))).toBe(source)
})
