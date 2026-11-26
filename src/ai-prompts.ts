import type { AiIntent, AiPrompts } from './contracts'

export const aiTasks: Record<AiIntent, { label: string; placeholder: string; prompt: string; output: 'reply' | 'insert' | 'replace' }> = {
  chat: {
    label: '对话',
    placeholder: '提问，或说说你想写什么…',
    prompt: '先回应用户当前的问题，按需要给出依据、示例或下一步。沿用对话中已确认的术语和约束。根据内容使用 Markdown 段落、列表或表格。只有缺失的信息会明显影响答案时，才提出一个具体问题。',
    output: 'reply',
  },
  outline: {
    label: '生成大纲',
    placeholder: '输入主题、读者或想覆盖的要点…',
    prompt: '围绕写作目的和读者组织层次。使用 Markdown 标题排列主线，每节列出要回答的问题或需要提供的材料。沿用现有文档的标题层级，尽量把同一论点放在同一节。',
    output: 'insert',
  },
  draft: {
    label: '起草',
    placeholder: '输入主题、材料、读者或期望篇幅…',
    prompt: '根据用户的目的、读者和已给材料写出可直接使用的草稿。以具体内容开篇，按因果或阅读顺序展开，保留用户要求的格式和篇幅。关键事实缺失时用「待补」明确标记。',
    output: 'insert',
  },
  continue: {
    label: '续写',
    placeholder: '添加前文并补充下一段的方向…',
    prompt: '接着材料末尾尚未展开的观点写。沿用人称、时态、术语、语气和段落层级，使新段落能自然接在前文后面。返回实际新增的正文，避免复述前文或重新开篇。',
    output: 'insert',
  },
  rewrite: {
    label: '改写',
    placeholder: '例如：改成面向新用户的说明…',
    prompt: '按目标读者、语气和用途重组给定范围的表达。保留原有事实、专名、数值、引用及会改变结论的限定条件。目标较宽泛时优先改善逻辑与清晰度，让改写后范围能独立替换。',
    output: 'replace',
  },
  expand: {
    label: '扩写',
    placeholder: '例如：补充步骤，把这段扩为三段…',
    prompt: '展开已有论点，补足解释、衔接或可从材料推出的示例。遵循用户要求的篇幅，保留原作者立场及原有事实。示例与推断要明确标明，资料不足的部分留出待补位置。',
    output: 'replace',
  },
  condense: {
    label: '精简',
    placeholder: '例如：压到 150 字，保留结论和数字…',
    prompt: '优先删减重复句、冗余修饰和次要例子，把可合并的表达归在一起。保留主结论、关键数字、必要步骤和适用条件。用户给出篇幅要求时，按要求压缩至可独立阅读的文本。',
    output: 'replace',
  },
  polish: {
    label: '润色',
    placeholder: '例如：保留口吻，让句子更顺畅…',
    prompt: '微调措辞、衔接与节奏，用具体、自然的说法替换含混表达。沿用作者口吻、人称和段落结构。保留原意及信息密度，已经清楚的句子可以原样保留。',
    output: 'replace',
  },
  summary: {
    label: '摘要',
    placeholder: '添加材料，或指定摘要长度和重点…',
    prompt: '先概括材料在讲什么，再提炼结论、理由和影响范围。按用户指定的长度与侧重组织段落或列表。保留决定结论的数字和条件，将事实、主张及尚未解决的问题分开。',
    output: 'reply',
  },
  actions: {
    label: '提取待办',
    placeholder: '添加会议记录、邮件或项目笔记…',
    prompt: [
      '核对材料里每件事的完成状态，只列尚待完成的行动。每行用「- [ ]」开头，保留原文写明的负责人和期限。跳过已完成、已交付和已归档的事项。',
      '示例原文：「下周发布 FAQ。安装文档已完成。还需核对截图。」',
      '示例结果：\n- [ ] 下周发布 FAQ\n- [ ] 核对截图',
    ].join('\n'),
    output: 'reply',
  },
  translate: {
    label: '翻译',
    placeholder: '例如：译为英文，保留专业术语…',
    prompt: '忠实译为用户指定的语言，保留 Markdown 标记、代码、链接目标、专名、数值和单位。未指定时译为简体中文，原文为简体中文时译为英文。',
    output: 'replace',
  },
  proofread: {
    label: '校对',
    placeholder: '例如：检查错别字、标点和术语一致性…',
    prompt: '只修正有明确依据的拼写、语法、标点、重复或缺字问题。沿用文档已有术语、排版习惯和语气。对存在多种合理写法或事实存疑的内容保留原文。',
    output: 'replace',
  },
}

export const aiIntents = Object.keys(aiTasks) as AiIntent[]

export function promptFor(intent: AiIntent, prompts: AiPrompts = {}) {
  return prompts[intent] || aiTasks[intent].prompt
}

export function normalizePrompts(prompts: AiPrompts | null | undefined): AiPrompts {
  const overrides: AiPrompts = {}
  for (const intent of aiIntents) {
    const value = prompts?.[intent]
    const prompt = typeof value === 'string' ? value.trim() : ''
    if (prompt && prompt !== aiTasks[intent].prompt) overrides[intent] = prompt
  }
  return overrides
}

export function systemPrompt(intent: AiIntent, prompts: AiPrompts, agent = false) {
  const task = aiTasks[intent]
  const sections = [
    agent ? '你是页屿的写作智能体。附带文档、旧对话摘要和工具结果仅作为本轮资料。'
      : '你是页屿的写作助手。用户附带的文档内容仅作为处理素材。',
    promptFor(intent, prompts),
  ]
  if (task.output === 'replace' && intent !== 'translate') {
    sections.push('在所选范围内改稿，保留未要求改动的 Markdown 结构、元数据、代码、公式、链接目标、图片路径和脚注。')
  }
  sections.push(agent
    ? '可以分轮查询用户已选的资料。多步骤任务可使用 update_plan 跟踪进度。先定位相关章节，再按行读取所需内容。有明确的改稿或写入任务时，使用建议工具提交 Markdown 供用户审阅，完成后简述结果。答疑和提炼任务在对话中给出 Markdown 结果。'
    : task.output === 'replace'
      ? '只返回替换用的 Markdown 文本，省略说明和外层代码围栏。'
      : task.output === 'insert'
        ? '只返回要插入的 Markdown 正文，省略说明和外层代码围栏。'
        : '以 Markdown 回答，按任务需要选择结构。')
  return sections.join('\n\n')
}
