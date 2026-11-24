import { describe, expect, it } from 'vitest'
import { bind, chooseHunks, relocate, suggestion } from '../src/suggestions'

describe('接受修改建议', () => {
  it('重新定位仍完整的建议，并拒绝歧义和改过的原文', () => {
    const source = '第一段\n'.repeat(50) + '只修改这句。' + '\n后文'.repeat(60)
    const from = source.indexOf('只修改')
    const binding = bind(7, 1, source, { from, to: from + '只修改这句。'.length })
    expect(relocate(binding, 7, 2, '新标题\n' + source)).toEqual({ from: from + 4, to: binding.to + 4 })
    expect(relocate(binding, 7, 2, source + source)).toBeNull()
    expect(relocate(binding, 7, 2, source.replace('只修改', '已经改写'))).toBeNull()
    expect(relocate(binding, 8, 1, source)).toBeNull()
  })

  it('应用选中的差异块并保留其余字节', () => {
    const old = '保留\r\n甲\r\n中间\n乙\r末尾'
    const next = '保留\r\n丙\r\n中间\n丁\r末尾'
    const proposal = suggestion('ai', '改稿', bind(1, 1, old, { from: 0, to: old.length }), next)
    expect(proposal.view.hunks).toEqual(2)
    expect(chooseHunks(proposal.view.parts, [0])).toEqual('保留\r\n丙\r\n中间\n乙\r末尾')
    expect(chooseHunks(proposal.view.parts, [0, 1])).toEqual(next)
  })
})
