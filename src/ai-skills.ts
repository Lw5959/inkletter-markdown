import type { AiSkill } from './contracts'
import { frontMatter } from './editor/front-matter'

export const builtInSkills: AiSkill[] = [
  {
    name: 'meeting-notes', label: '会议纪要', builtIn: true,
    description: '把会议材料整理为决定、待办和待确认事项。',
    instructions: '合并同一议题的讨论，把已确认决定和仍待确认的事项分开。待办写清行动及原材料明确的负责人和期限，缺失处用「待确认」标记。保留影响决策的日期、数字和约束。使用适合转发的 Markdown 纪要，按材料省略无内容的小节。',
  },
  {
    name: 'document-review', label: '文档审阅', builtIn: true,
    description: '按影响大小指出读者会遇到的问题，并给出可落地的改法。',
    instructions: '按读者使用文档的实际顺序检查缺失步骤、前后矛盾、歧义和事实依据。先列影响读者理解、决策或执行的问题。每项用章节名、行号或短引文定位，说明影响并给出最小修改。分清已核实的问题和需要材料才能判断的问题。',
  },
  {
    name: 'technical-guide', label: '技术说明', builtIn: true,
    description: '整理技术方案、操作步骤和验证方法。',
    instructions: '先交代目标、适用范围和前置条件，再按实际执行顺序写步骤。逐项说明命令对应的工作目录、输入及成功信号。保留标识符、路径和版本。遇到可预见的失败，写明如何识别与恢复。未知环境或命令用「待确认」标记，保留已有操作边界。',
  },
  {
    name: 'weekly-report', label: '周报整理', builtIn: true,
    description: '把零散进度归成可汇报的简短编号条目。',
    instructions: '按交付结果归并重复进度，优先写本周完成的变化、可验证的结果和仍需跟进的事项。一般整理成三条简短编号条目，材料不足时用实际条数。使用具体动词，保留可核实的数字与日期。把已完成和仍在推进的工作写清楚。',
  },
]

export function mergeSkills(previous: AiSkill[], incoming: AiSkill[]) {
  return [...new Map([...previous, ...incoming].map(skill => [skill.name, skill])).values()]
}

export async function parseSkill(source: string, filename: string): Promise<AiSkill> {
  if (source.length > 128 * 1024) throw new Error(`${filename} 内容过长，请精简技能正文后导入`)
  const markdown = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const front = frontMatter(markdown)
  if (!front) throw new Error(`${filename} 缺少 SKILL.md 所需的 YAML 文件头`)
  const { parseDocument } = await import('yaml')
  const document = parseDocument(front[1] ?? '')
  if (document.errors.length) throw new Error(`${filename} 的 YAML 文件头有误，请检查缩进和引号`)
  // 只读取两个标准标量，文件头中的其他内容不进入工具权限或模型请求。
  const name = document.get('name')
  const description = document.get('description')
  const instructions = markdown.slice(front[0].length).trim()
  if (typeof name !== 'string' || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`${filename} 的 name 须用小写字母、数字和短横线`)
  }
  if (typeof description !== 'string' || !description.trim() || description.trim().length > 1024) {
    throw new Error(`${filename} 需要填写不超过 1024 字符的 description`)
  }
  if (!instructions) throw new Error(`${filename} 需要填写技能正文`)
  return { name, description: description.trim(), instructions }
}
