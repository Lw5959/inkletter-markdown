import { parser } from '@lezer/markdown'
import type { AiAgentApproval, AiAgentPlanItem, AiAgentStep, AiInputFile, AiSelection, AiUsage } from './contracts'
import { frontMatter } from './editor/front-matter'
import { Channel, invoke } from './native'
import type { StreamEvent } from './native'

export type AgentDocument = { name: string; text: string }
export type AgentMessage = { role: 'system' | 'user' | 'assistant'; text: string; files?: AiInputFile[] }
export type AgentInput = {
  id: string
  sessionId: string
  selection: AiSelection
  messages: AgentMessage[]
  documents: AgentDocument[]
  target: { text: string; insert: boolean; eol: string } | null
}

type Arguments = Record<string, unknown>
type ToolCall = { id: string; name: string; arguments: string }
type Turn = { text: string; calls: ToolCall[]; output: unknown[]; usage?: AiUsage }
type ToolResult = { id: string; content: string; error: boolean }
type Exchange = { output: unknown[]; results: ToolResult[] }
type Change = { from: number; to: number; text: string }
type Result = { value: object; detail: string; plan?: AiAgentPlanItem[] }
type Prepared = { detail: string; markdown?: string; run: () => Result }
type Tool = {
  title: string
  name: string
  description: string
  schema: object
  prepare: (args: Arguments) => Prepared
}

const lineNumber = { type: 'integer', minimum: 1 }
const text = { type: 'string' }
const MAX_ROUNDS = 8
const MAX_CALLS = 16

function lines(source: string) {
  const starts = [0]
  for (const newline of source.matchAll(/\r\n|[\r\n]/g)) starts.push(newline.index + newline[0].length)
  return starts
}

function lineEnd(source: string, starts: number[], line: number) {
  const next = starts[line]
  if (next === undefined) return source.length
  return next - (source.slice(next - 2, next) === '\r\n' ? 2 : 1)
}

function lineRange(args: Arguments, count: number, limit: number) {
  const { start_line: start, end_line: end } = args
  if (typeof start !== 'number' || typeof end !== 'number' ||
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || start > end || end > count) {
    throw new Error('行号应在第 1 到 ' + count + ' 行之间')
  }
  if (end - start + 1 > limit) throw new Error('请一次选择至多 ' + limit + ' 行')
  return { start, end }
}

function define(name: string, title: string, description: string, properties: Record<string, object>, prepare: Tool['prepare']): Tool {
  return { name, title, description, schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }, prepare }
}

function agentSources(documents: { name: string; starts: number[] }[], target: AgentInput['target']) {
  const names = documents.map(({ name, starts }, i) => ({ document: i + 1, title: name, lines: starts.length }))
  return [
    names.length ? '用户已确认的文档编号和标题 ' + JSON.stringify(names) : '用户没有附带可读取的文档。',
    target?.insert ? '用户的编辑器光标可接收插入建议。'
      : target ? '文档 1 是本次可以提出改稿建议的范围，工具行号从该范围的第 1 行算起。'
        : '本次为只读任务。',
  ].join('\n')
}

function workspace(documents: AgentDocument[], target: AgentInput['target']) {
  // 工具查询已预览的快照，编号不能解析为文件路径或重新读取磁盘。
  const sources = documents.map(({ name, text }) => ({ name, text, starts: lines(text) }))
  const changes: Change[] = []
  const states = ['pending', 'in_progress', 'completed']
  const tools: Tool[] = [define('update_plan', '更新执行计划', '为多步骤任务设置简短执行计划，阶段完成后再次更新。', {
    plan: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false,
      properties: { step: text, status: { type: 'string', enum: states } }, required: ['step', 'status'] } },
  }, ({ plan }) => {
    if (!Array.isArray(plan) || !plan.length || plan.length > 8) throw new Error('计划需要 1 到 8 个步骤')
    const items = plan.map((item): AiAgentPlanItem => {
      const value = item as Partial<AiAgentPlanItem> | null
      if (typeof value?.step !== 'string' || !value.step.trim() || !value.status || !states.includes(value.status)) {
        throw new Error('每一步都需要名称和有效状态')
      }
      return { step: value.step.trim().slice(0, 160), status: value.status }
    })
    return { detail: items.map(item => item.step).join(' · '),
      run: () => ({ value: { updated: true }, detail: items.length + ' 个计划步骤', plan: items }) }
  })]
  const get = (index: unknown) => {
    const item = typeof index === 'number' && Number.isSafeInteger(index) ? sources[index - 1] : null
    if (!item) throw new Error('请使用用户已选文档的编号')
    return item
  }
  if (sources.length) tools.push(
    define('search_documents', '搜索上下文', '按文字关键词搜索已确认的文档。返回文档编号、行号和片段。', { query: text }, args => {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (!query || query.length > 160) throw new Error('请输入 1 到 160 个字符的关键词')
      const keyword = query.toLowerCase()
      return { detail: '在已选文档中查找「' + query + '」', run() {
        const matches: { document: number; line: number; excerpt: string }[] = []
        for (const [i, source] of sources.entries()) {
          for (const [j, start] of source.starts.entries()) {
            const value = source.text.slice(start, lineEnd(source.text, source.starts, j + 1))
            const at = value.toLowerCase().indexOf(keyword)
            if (at < 0) continue
            if (matches.length === 16) return { value: { matches, truncated: true }, detail: '「' + query + '」至少匹配 16 行' }
            const excerptFrom = Math.max(0, at - 60)
            matches.push({ document: i + 1, line: j + 1, excerpt: value.slice(excerptFrom, excerptFrom + 260).trim() })
          }
        }
        return { value: { matches }, detail: '「' + query + '」匹配 ' + matches.length + ' 行' }
      } }
    }),
    define('read_document', '读取文档片段', '按行读取一个已确认的文档。行号含首尾，从 1 开始，一次最多 80 行。', {
      document: lineNumber, start_line: lineNumber, end_line: lineNumber,
    }, args => {
      const source = get(args.document)
      const { start, end } = lineRange(args, source.starts.length, 80)
      const from = source.starts[start - 1]
      const to = lineEnd(source.text, source.starts, end)
      const detail = source.name + ' · 第 ' + start + '–' + end + ' 行'
      return { detail, run: () => ({
        value: { document: args.document, start_line: start, end_line: end, total_lines: source.starts.length,
          markdown: source.text.slice(from, Math.min(to, from + 9000)), truncated: to - from > 9000 },
        detail,
      }) }
    }),
    define('document_outline', '查看文档大纲', '列出一个已确认的 Markdown 文档的标题、层级和行号。', { document: lineNumber }, args => {
      const source = get(args.document)
      return { detail: source.name, run() {
        const headings: { line: number; level: number; title: string }[] = []
        let line = 0
        const normalized = source.text.replace(/\r\n?/g, '\n')
        const normalStarts = lines(normalized)
        const metadata = frontMatter(normalized)?.[0].length ?? 0
        parser.parse(normalized).iterate({
          enter(node) {
            // 语法树使用正规化行尾，下面用同一文本的行位置定位标题。
            const level = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name)
            if (!level || node.from < metadata || headings.length >= 120) return
            while (line + 1 < source.starts.length && normalStarts[line + 1] <= node.from) line++
            const from = source.starts[line]
            const title = source.text.slice(from, lineEnd(source.text, source.starts, line + 1))
              .replace(/^\s*#{1,6}\s+|\s+#+\s*$/g, '').trim().slice(0, 240)
            headings.push({ line: line + 1, level: Number(level[1]), title })
          },
        })
        return { value: { total_lines: source.starts.length, headings, truncated: headings.length === 120 }, detail: source.name + ' · ' + headings.length + ' 个标题' }
      } }
    }),
  )

  if (target) {
    const starts = lines(target.text)
    const propose = ({ markdown }: Arguments, from: number, to: number, detail: string): Prepared => {
      if (typeof markdown !== 'string' || markdown.length > 24000) throw new Error('单段建议最多 24000 个字符')
      const original = target.text.slice(from, to)
      const eol = original.match(/\r\n|[\r\n]/)?.[0] ?? target.eol
      let text = markdown.replace(/\r\n|[\r\n]/g, eol)
      // 按行替换保留原文行尾，模型附带的一个末尾换行不能在相邻行之间增加空段。
      if (!target.insert && /[\r\n]/.test(target.text.charAt(to)) && text.endsWith(eol)) text = text.slice(0, -eol.length)
      return { detail, markdown: text, run() {
        const same = changes.find(change => change.from === from && change.to === to)
        if (changes.some(change => change !== same && change.from <= to && from <= change.to)) {
          throw new Error('建议与先前的行范围重叠，请合并成同一个范围')
        }
        if (same) same.text = text
        else changes.push({ from, to, text })
        return { value: { accepted_for_review: true, changed: original !== text },
          detail: original === text ? '内容与原文一致' : detail + ' · 已加入差异审阅' }
      } }
    }
    tools.push(target.insert
      ? define('propose_insert', '提出插入建议', '提出在当前编辑器光标插入完整 Markdown，等用户审阅后应用。', { markdown: text },
        args => propose(args, 0, 0, '编辑器原光标位置'))
      : define('propose_edit', '提出修改建议', '替换文档 1 内指定行的 Markdown，等用户审阅后应用。首尾均包含，行号从 1 开始。编辑器保留被替换范围之外的原有换行。', {
        start_line: lineNumber, end_line: lineNumber, markdown: text,
      }, args => {
        const { start, end } = lineRange(args, starts.length, starts.length)
        return propose(args, starts[start - 1], lineEnd(target.text, starts, end), '已选范围内第 ' + start + '–' + end + ' 行')
      }))
  }

  function replacement() {
    if (!target || !changes.length) return null
    let cursor = 0
    const parts: string[] = []
    for (const change of changes.sort((a, b) => a.from - b.from)) {
      parts.push(target.text.slice(cursor, change.from), change.text)
      cursor = change.to
    }
    return parts.join('') + target.text.slice(cursor)
  }
  return { tools, replacement, context: agentSources(sources, target) }
}

export async function runAgent(input: AgentInput, callbacks: {
  signal: AbortSignal; round: (round: number) => void; delta: (text: string) => void; reasoning: (text: string) => void;
  step: (step: AiAgentStep) => void;
  approve?: (request: AiAgentApproval) => Promise<boolean>
}) {
  const { tools, replacement, context } = workspace(input.documents, input.target)
  const messages = input.messages.map((message, i) =>
    i === input.messages.length - 1 ? { ...message, text: context + '\n\n' + message.text } : message)
  const definitions = tools.map(({ name, description, schema }) => ({ name, description, schema }))
  const history: Exchange[] = []
  const usage: AiUsage[] = []
  let calls = 0
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    callbacks.signal.throwIfAborted()
    callbacks.round(round)
    const event = new Channel<StreamEvent>()
    let accepting = true
    event.onmessage = item => {
      if (!accepting || callbacks.signal.aborted) return
      if (item.kind === 'delta') callbacks.delta(item.text)
      if (item.kind === 'reasoning') callbacks.reasoning(item.text)
    }
    const reply = await invoke<Turn | null>('ai_agent_turn', {
      request: { id: input.id, sessionId: input.sessionId, selection: input.selection, messages, history, tools: definitions }, event,
    }).finally(() => { accepting = false })
    callbacks.signal.throwIfAborted()
    if (!reply) throw new DOMException('已取消生成', 'AbortError')
    if (reply.usage) usage.push(reply.usage)
    if (!reply.calls.length) return { text: reply.text, proposal: replacement(), usage }
    calls += reply.calls.length
    if (calls > MAX_CALLS || round === MAX_ROUNDS) throw new Error('已达到智能体的步骤上限，请缩小任务范围')
    if (new Set(reply.calls.map(call => call.id)).size !== reply.calls.length) throw new Error('模型重复使用了工具调用编号')
    // 两种模式都先检验工具、参数和文档范围。审批只允许已经通过检查的操作进入执行阶段。
    const prepared = reply.calls.map(call => {
      const tool = tools.find(item => item.name === call.name)
      const title = tool?.title ?? '文档工具'
      try {
        if (!tool) throw new Error('该工具不在本次授权范围内')
        const args: unknown = JSON.parse(call.arguments || '{}')
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数应是一个对象')
        return { id: call.id, title, operation: tool.prepare(args as Arguments) }
      } catch (error) {
        return { id: call.id, title, error: error instanceof SyntaxError ? '工具参数不是有效的 JSON' : (error as Error).message }
      }
    })
    if (callbacks.approve) {
      const tools = prepared.flatMap(({ title, operation }) => operation ? [{ title, detail: operation.detail, markdown: operation.markdown }] : [])
      if (tools.length && !await callbacks.approve({ id: crypto.randomUUID(), round, tools })) {
        callbacks.signal.throwIfAborted()
        throw new Error('已拒绝本轮工具请求，智能体已停止')
      }
    }
    const results: ToolResult[] = []
    for (const { id, title, operation, error } of prepared) {
      callbacks.signal.throwIfAborted()
      try {
        if (!operation) throw new Error(error)
        const result = operation.run()
        results.push({ id, content: JSON.stringify(result.value), error: false })
        callbacks.step({ title, detail: result.detail, plan: result.plan })
      } catch (error) {
        const message = (error as Error).message
        results.push({ id, content: JSON.stringify({ error: message }), error: true })
        callbacks.step({ title, detail: message, failed: true })
      }
    }
    history.push({ output: reply.output, results })
  }
  throw new Error('已达到智能体的轮次上限，请缩小任务范围')
}
