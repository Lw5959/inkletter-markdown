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
const diagramFont = 'system-ui, sans-serif'

function formatFlowchart(svg: string) {
  if (!svg.includes('class="flowchart"')) return svg
  const template = document.createElement('template')
  template.innerHTML = svg
  const graph = template.content.querySelector('svg.flowchart')
  if (!graph) return svg

  // 净化会移除 Mermaid 的内嵌样式。把布局所需的对齐和线型保留为 SVG 属性。
  graph.setAttribute('font-family', diagramFont)
  graph.setAttribute('font-size', '16')
  for (const label of graph.querySelectorAll('.node .label text, .edgeLabel text')) {
    label.setAttribute('text-anchor', 'middle')
  }
  for (const rect of graph.querySelectorAll('.node > rect.basic.label-container:not([rx])')) {
    rect.setAttribute('rx', '6')
  }
  for (const edge of graph.querySelectorAll('.edgePaths path')) {
    const classes = edge.classList
    const width = classes.contains('edge-thickness-invisible') ? '0' : classes.contains('edge-thickness-thick') ? '2.5' : '1.25'
    edge.setAttribute('stroke-width', width)
    edge.setAttribute('stroke-linecap', 'round')
    if (classes.contains('edge-pattern-dashed')) edge.setAttribute('stroke-dasharray', '5 3')
    if (classes.contains('edge-pattern-dotted')) edge.setAttribute('stroke-dasharray', '2 3')
  }
  for (const arrow of graph.querySelectorAll('marker[id*="-point"]')) {
    arrow.setAttribute('markerWidth', '7')
    arrow.setAttribute('markerHeight', '8')
    arrow.firstElementChild?.setAttribute('fill', 'currentColor')
    arrow.firstElementChild?.setAttribute('stroke', 'none')
  }
  return graph.outerHTML
}

export async function renderDiagram(kind: string, content: string) {
  const source = diagramSource(kind, content)
  // 禁止文档注入渲染配置或在画图时加载远程资源。
  if (!source || /^\s*---|%%\{|\b(?:click|style|classDef|linkStyle)\b|\b(?:https?|file|data|img|image):|url\s*\(|@import/im.test(source)) return null
  renderer ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false, securityLevel: 'strict', htmlLabels: false, suppressErrorRendering: true,
      fontFamily: diagramFont,
      flowchart: { useMaxWidth: false, minNodeWidth: 68, wrappingWidth: 156, padding: 10, rankSpacing: 42, nodeSpacing: 30 },
    })
    return mermaid
  })
  try {
    const mermaid = await renderer
    await mermaid.parse(source)
    return formatFlowchart((await mermaid.render('yeyu-diagram-' + ++sequence, source)).svg)
  } catch {
    return null
  }
}
