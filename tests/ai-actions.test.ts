import { describe, expect, it } from 'vitest'
import { actionCandidates, actionChoices, actionReply, noActionItems } from '../src/ai-actions'
import { systemPrompt } from '../src/ai-prompts'

const extract = (text: string) => actionCandidates([{ name: '会议纪要', text }]).map(item => item.text)

describe('提取待办', () => {
  it('排除完成与归档分组、已勾选项、删除线和旧待办', () => {
    const source = [
      '\uFEFF---', 'example: 需要新增样例', '---', '# 发布',
      '## 待办', '- [ ] **补部署说明**', '- [ ] 旧版海报（已归档）',
      '- [ ] [待办] 修改入口（已完成）', '- [ ] ~~旧计划~~', '- [ ] 核对新签名',
      '## 已完成（本周）', '- [X] 补部署说明', '- 回归测试',
      '### 后续记录', '- [ ] 完成记录的旧子项',
      '## Archived tasks', '- [ ] Previously closed note',
      '## 下一步', '- 核对已归档文档的索引',
    ].join('\r\n')
    expect(extract(source)).toEqual(['核对新签名', '核对已归档文档的索引'])
  })

  it('按表格状态选择任务，保留负责人、截止时间和空白列位置', () => {
    const source = [
      '| 任务 | 备注 | 状态 | 负责人 | 截止日期 |',
      '| --- | --- | --- | --- | --- |',
      '| 提交报价单 |  | 进行中 | 小王 | 周五 |',
      '| 封装旧版海报 |  | **已归档** | 小林 | 周三 |',
      '| 集成支付 |  | 已完成 | 小周 | 周四 |',
      '| 截图说明 |  | 待定 | 小周 |  |',
      '| [x] 回填文件 |  | 待办 | 小周 |  |',
      '| 复查签名 |  | not completed | 林工 |  |',
    ].join('\n')
    expect(extract(source)).toEqual(['提交报价单（负责人：小王，截止日期：周五）', '复查签名（负责人：林工）'])
  })

  it('从混合段落分开独立的后续行动，跳过代码示例和状态不明的记录', () => {
    const source = [
      '请根据以下材料提取待办。',
      '周五提交报价单，旧版海报已经归档。',
      '上周已完成安装文档，库存还需检查。发布计划已取消。',
      '接口尚未完成。接口已完成了。',
      '公告已发布。已归档的附件仍需复核。',
      '仍需核对[清单](./check.md?q=a;b)和\x60a;b\x60。',
      '另有一份供应商资料。',
      '', '\x60\x60\x60markdown', '- [ ] 代码示例', '\x60\x60\x60',
    ].join('\n')
    expect(extract(source)).toEqual(['周五提交报价单', '库存还需检查', '已归档的附件仍需复核', '仍需核对[清单](./check.md?q=a;b)和\x60a;b\x60'])
  })

  it('应用只渲染有效编号所指的原文，拒绝自由文本，允许空清单', () => {
    const candidates = actionCandidates([
      { name: '旧记录', text: '- [ ] 更新链接\n- [ ] 复查报价单' },
      { name: '新记录', text: '- [x] 更新链接\n\n### 待办\n- 核对库存' },
    ])
    expect(actionChoices(candidates)).toBe('1. 复查报价单（材料：旧记录）\n2. 核对库存（材料：新记录）')
    expect(actionReply('[2, 99, 1, 2]', candidates)).toBe('- [ ] 核对库存\n- [ ] 复查报价单')
    expect(actionReply('[]', candidates)).toBe(noActionItems)
    expect(() => actionReply('[99]', candidates)).toThrow('超出范围')
    expect(() => actionReply('- [ ] 更新链接', candidates)).toThrow('可核对的待办编号')
    expect(systemPrompt('actions', { actions: '按负责人筛选。' }, true)).toContain('只返回一个 JSON 数字数组')
  })
})
