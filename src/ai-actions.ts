import MarkdownIt from 'markdown-it'
import type { Token } from 'markdown-it'
import { frontMatter } from './editor/front-matter'

type Status = 'open' | 'closed' | undefined
type Source = { name: string; text: string }
export type ActionCandidate = { text: string; source: string }

const markdown = new MarkdownIt({ html: true })
const identity = (text: string) => text.normalize('NFKC')
  .replace(/^\*\*(.+)\*\*$|^__(.+)__$/, '$1$2')
  .replace(/^(?:尚未|仍未|还未|还没)(?:完成|归档|交付)\s*|\s*(?:尚未|仍未|还未|还没|未)(?:完成|归档|交付)$/g, '')
  .replace(/\s+/g, ' ').trim().toLowerCase()
const closedLabel = /^(?:已(?:经)?(?:完成|归档|交付|提交|发布|取消|关闭|结项|废弃|结束)|已办|完成|归档|历史归档|done|complete|completed|finished|archive|archived|delivered|closed|cancelled|canceled|resolved)(?:的?(?:清单|事项|任务|列表|记录|项目)| (?:tasks?|items?|work|records?))?$/i
const openLabel = /^(?:待办|待处理|待跟进|待完成|待复核|未开始|未完成|进行中|未归档|下一步|todo|to do|open|pending|in progress|not (?:yet )?(?:started|completed|finished|archived)|next steps?)(?:的?(?:清单|事项|任务|列表|记录|计划)| (?:tasks?|items?|work))?$/i
const closedPhrase = /已(?:经)?(?:完成|做完|办完|归档|交付|提交|发布|取消|关闭|结项|废弃|结束)|\b(?:already |has been |was |is )?(?:done|completed|archived|delivered|cancelled|canceled|closed|finished)\b/i
const pendingCue = /尚未|尚待|未完成|未归档|[需待](?:提交|确认|检查|复核|跟进|补充|完成|处理|回复|验证|发布|核对)|还(?:需|要|没)|仍(?:需|要)|需要|必须|需[在将把于由]|计划|下一步|^(?:请|明[天日]|下周|周[一二三四五六日天])|(?:\d+[日号]|周[一二三四五六日天])前|\b(?:needs? to|will|must|please|not (?:yet )?(?:completed|finished|archived)|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i
const extractionRequest = /^(?:请帮我|请|帮我)?\s*(?:(?:根据|从|按照)[^，。；\n]{0,25})?(?:只(?:列|看|保留)|列出|提取|找出|整理).{0,32}(?:待办|未完成事项|行动项)|^(?:please )?(?:extract|list|find)\b.{0,55}\b(?:tasks?|to-?dos?|action items)\b/i

export const noActionItems = '没有找到明确的待办事项。'

function label(value: string) {
  return value.trim().replace(/[*_~]/g, '').replace(/^\d+[.、)]\s*/, '')
    .replace(/^[\[【(（]+|[\]】)）：:]+$/g, '').trim()
}

function status(value: string): Status {
  const trimmed = value.trim()
  if (/^(?:\[[xX]\]|[✅✔✓])$/u.test(trimmed)) return 'closed'
  if (trimmed === '[ ]') return 'open'
  const name = label(trimmed.replace(/[✅✔✓]/gu, '')
    .replace(/^[（(]([^）)]+)[）)]$/, '$1').replace(/\s*[（(][^）)]*[）)]$/, ''))
  if (closedLabel.test(name)) return 'closed'
  if (openLabel.test(name)) return 'open'
}

function itemStatus(value: string): { text: string; state: Status } {
  let text = value
  let state: Status
  const tag = /^(\[[^\]]+\](?!\()|【[^】]+】|\*\*[^*]+\*\*(?=\s)|[^：:]{1,24}[：:])\s*/.exec(text)
  if (tag) {
    state = status(tag[1])
    if (state) text = text.slice(tag[0].length).trim()
  }
  const tail = /\s*([（(【][^）)】]+[）)】]|\*\*[^*]+\*\*)$/.exec(text)
  if (tail) {
    const endState = status(tail[1])
    if (endState) {
      if (state !== 'closed') state = endState
      text = text.slice(0, tail.index).trim()
    }
  }
  const crossed = /^~~(.+)~~$/.exec(text)
  if (crossed) return { text: crossed[1], state: 'closed' }
  // 「已归档海报」和「海报已归档」是状态记录，中间的「核对已归档海报」仍可是一项行动。
  const done = closedPhrase.exec(text)
  if (done) {
    const before = text.slice(0, done.index).trim()
    const after = text.slice(done.index + done[0].length).trim()
    if (/(?:\bnot|\bnever|n't)(?: (?:yet|been))*$/i.test(before)) return { text, state }
    if (!before && after.startsWith('的') && pendingCue.test(after)) return { text, state }
    if (!before || /^(?:昨天|昨晚|上周|此前|周[一二三四五六日天])$/.test(before)) {
      return { text: after.replace(/^[：:]\s*/, ''), state: 'closed' }
    }
    if (/^(?:了|[（(][^）)]*[）)])?$/.test(after)) return { text: before, state: 'closed' }
  }
  return { text, state }
}

function tableRows(tokens: Token[], start: number) {
  const rows: string[][] = []
  let i = start + 1
  for (; i < tokens.length && tokens[i].type !== 'table_close'; i++) {
    if (tokens[i].type === 'tr_open') rows.push([])
    if (tokens[i].type === 'inline') rows.at(-1)?.push(tokens[i].content.trim())
  }
  return { rows, end: i }
}

function clauses(text: string) {
  // 跳过代码、Markdown 链接和 URL 内的标点，保留候选里的原文写法。
  const pieces: string[] = []
  const separators = /\x60+[^\x60\n]+\x60+|!?\[[^\]\n]*\]\([^\n)]*\)|https?:\/\/[^\s，。；！？]+|[\n。；;！!？?]+|\.(?=\s|$)|[，,]/gi
  const matches = [...text.matchAll(separators)].filter(match => !/^[\x60\[h]|^!\[/i.test(match[0]))
  let start = 0
  for (const [i, match] of matches.entries()) {
    const before = text.slice(start, match.index).trim()
    const end = match.index + match[0].length
    if (/[，,]/.test(match[0])) {
      const after = text.slice(end, matches[i + 1]?.index).trim()
      const transition = /^(?:但|接下来|下一步|另外|还需|还要|仍需|明[天日]|下周|but\b|then\b)/i.test(after)
      if (!transition && itemStatus(before).state !== 'closed' && itemStatus(after).state !== 'closed') continue
    }
    pieces.push(before)
    start = end
  }
  pieces.push(text.slice(start).trim())
  return pieces.filter(Boolean)
}

export function actionCandidates(sources: readonly Source[]): ActionCandidate[] {
  const candidates = new Map<string, ActionCandidate>()
  const closed = new Set<string>()
  for (const source of sources) {
    const normalized = source.text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
    const tokens = markdown.parse(normalized.slice(frontMatter(normalized)?.[0].length ?? 0), {})
    const headings: Status[] = []
    let group: Status

    function record(value: string, state: Status, metadata: string[] = []) {
      const { state: marked, text } = itemStatus(value.trim().replace(/[。.!！]$/, ''))
      const title = text.trim()
      if (!title || extractionRequest.test(title)) return
      const key = identity(title)
      if (state === 'closed' || marked === 'closed') {
        closed.add(key)
        for (const item of title.split('、')) closed.add(identity(item))
      }
      else if ((state === 'open' || marked === 'open' || pendingCue.test(title)) && !candidates.has(key)) {
        candidates.set(key, {
          text: title.replace(/\s*\n\s*/g, ' ') + (metadata.length ? '（' + metadata.join('，') + '）' : ''),
          source: source.name,
        })
      }
    }

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      if (token.type === 'heading_open') {
        const level = Number(token.tag.slice(1))
        headings.length = level
        headings[level - 1] = status(tokens[++i].content)
        group = undefined
        continue
      }
      const section = headings.includes('closed') || group === 'closed' ? 'closed'
        : headings.includes('open') || group === 'open' ? 'open' : undefined
      if (token.type === 'table_open') {
        const { rows: [header = [], ...rows], end } = tableRows(tokens, i)
        const stateColumn = header.findIndex(cell => /^(?:状态|进度|完成情况|status|progress|state)$/i.test(label(cell)))
        const taskColumn = header.findIndex(cell => /^(?:事项|工作项|任务|项目|行动项|内容|任务名称|task|action(?: item)?|title|item)$/i.test(label(cell)))
        if (stateColumn >= 0 || taskColumn >= 0) for (const row of rows) {
          const rowState = stateColumn >= 0 ? status(row[stateColumn] ?? '') : section
          if (stateColumn >= 0 && !rowState && section !== 'closed') continue
          const task = row[taskColumn >= 0 ? taskColumn : stateColumn === 0 ? 1 : 0]
          const metadata = header.flatMap((cell, column) =>
            row[column] && /^(?:负责人|责任人|经办人|截止(?:日期|时间)?|期限|owner|assignee|deadline|due(?: date)?)$/i.test(label(cell))
              ? [cell + '：' + row[column]] : [])
          if (task) record(task, section === 'closed' ? 'closed' : rowState, metadata)
        }
        i = end
      } else if (token.type === 'inline') {
        const content = token.content.trim()
        const checkbox = /^\[([ xX])\]\s+/.exec(content)
        if (checkbox) {
          const task = content.slice(checkbox[0].length)
          const state = section === 'closed' || checkbox[1] !== ' ' ? 'closed' : 'open'
          const parts = clauses(task)
          if (state === 'open' && parts.some(part => itemStatus(part).state === 'closed')) {
            for (const part of parts) record(part, pendingCue.test(part) ? 'open' : undefined)
          } else record(task, state)
        } else {
          const named = token.level === 1 ? status(content) : undefined
          if (named) group = named
          else for (const part of clauses(content)) record(part, section)
        }
      }
    }
  }
  // 同一事项有旧的待办记录和明确的完成记录时，完成状态优先。
  return [...candidates].filter(([key]) => !closed.has(key)).map(([, candidate]) => candidate)
}

export function actionChoices(candidates: readonly ActionCandidate[]) {
  const labeled = new Set(candidates.map(item => item.source)).size > 1
  return candidates.map((item, index) => (index + 1) + '. ' + item.text + (labeled ? '（材料：' + item.source + '）' : '')).join('\n')
}

export function actionMarkdown(candidates: readonly ActionCandidate[]) {
  return candidates.length ? candidates.map(item => '- [ ] ' + item.text).join('\n') : noActionItems
}

export function actionReply(result: string, candidates: readonly ActionCandidate[]) {
  const content = result.trim().replace(/^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/i, '$1')
  let parsed: unknown
  try { parsed = JSON.parse(content) } catch { /* 非编号回复不进入会话 */ }
  if (!Array.isArray(parsed) || parsed.some(id => !Number.isSafeInteger(id))) {
    throw new Error('模型未返回可核对的待办编号，请重试')
  }
  const selected = [...new Set<number>(parsed)].map(id => candidates[id - 1]).filter(Boolean)
  if (parsed.length && !selected.length) throw new Error('模型返回的待办编号超出范围，请重试')
  return actionMarkdown(selected)
}
