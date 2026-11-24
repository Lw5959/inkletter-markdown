// 旧语法中可直接映射的节点和消息复用 Mermaid 离线绘制。
export function diagramSource(kind: string, source: string) {
  if (kind === 'mermaid') return source
  if (kind === 'sequence') {
    const lines = source.trim().split('\n').filter(line => !/^\s*Title:/i.test(line))
    return 'sequenceDiagram\n' + lines.map(line => line.replace(/(-+)>\s*([^:]+:)/, '$1>>$2')).join('\n')
  }
  const lines = ['flowchart TD']
  for (const row of source.trim().split('\n')) {
    const node = /^(\w+)\s*=>\s*(start|end|operation|inputoutput|subroutine|condition)\s*:\s*([^|]+)(?:\|\w+)?\s*$/.exec(row)
    if (node) {
      const [, id, type, title] = node
      const label = '"' + title.trim().replace(/["<>&]/g, '') + '"'
      lines.push(id + (type === 'condition' ? '{' + label + '}' : '[' + label + ']'))
      continue
    }
    const path = row.trim().split(/\s*->\s*/)
    if (path.length < 2 || path.some(part => !/^\w+(?:\((?:yes|no)(?:,\w+)?\))?$/.test(part))) return null
    for (let i = 1; i < path.length; i++) {
      const [from, condition] = path[i - 1].split(/[(),]/)
      const to = path[i].split('(')[0]
      lines.push(from + ' --> ' + (condition ? '|' + condition + '| ' : '') + to)
    }
  }
  return lines.join('\n')
}

let sequence = 0
let renderer: Promise<typeof import('mermaid').default> | undefined

export async function renderDiagram(kind: string, content: string) {
  const source = diagramSource(kind, content)
  // 禁止文档注入渲染配置或在画图时加载远程资源。
  if (!source || /^\s*---|%%\{|\b(?:click|style|classDef|linkStyle)\b|\b(?:https?|file|data|img|image):|url\s*\(|@import/im.test(source)) return null
  renderer ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, suppressErrorRendering: true })
    return mermaid
  })
  try {
    const mermaid = await renderer
    await mermaid.parse(source)
    return (await mermaid.render('yeyu-diagram-' + ++sequence, source)).svg
  } catch {
    return null
  }
}
