import MarkdownIt from 'markdown-it'
import type { Token } from 'markdown-it'
import footnote from 'markdown-it-footnote'
import tasks from 'markdown-it-task-lists'
import mark from 'markdown-it-mark'
import subscript from 'markdown-it-sub'
import superscript from 'markdown-it-sup'
import { light as emoji } from 'markdown-it-emoji'
import type { RenderOptions } from '../contracts'
import { frontMatter } from './front-matter'
const parser = () => new MarkdownIt({ html: true, linkify: true })
  .use(footnote).use(tasks).use(mark).use(subscript).use(superscript).use(emoji)

const inlineParser = new MarkdownIt()
const textFromTokens = (tokens: readonly Token[]): string => tokens.map(token =>
  token.children ? textFromTokens(token.children) : token.content).join('')

export function headingText(source: string) {
  return textFromTokens(inlineParser.parseInline(source, {}))
}

export function headingId(title: string, used: Set<string>) {
  const base = title.trim().toLowerCase().replace(/[^\p{Letter}\p{Number}\s_-]/gu, '').replace(/\s+/g, '-') || 'heading'
  let id = base
  for (let i = 2; used.has(id); i++) id = base + '-' + i
  used.add(id)
  return id
}

export function safeUrl(url: string, image = false) {
  // 与 HTML 清理共享白名单。Tauri 解析出的本机图片可以使用 asset 协议。
  const normalized = url.replace(/[\u0000-\u0020\u007f]/g, '')
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(normalized)?.[1].toLowerCase()
  if (image && scheme === 'data') return /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(normalized)
  return !scheme || (image ? ['http', 'https', 'asset', 'blob'] : ['http', 'https', 'mailto']).includes(scheme)
}

type RenderHooks = RenderOptions & { renderDiagram?: (kind: string, source: string) => Promise<string | null> }

export function renderMarkdown(markdown: string, options: RenderOptions = {}): Promise<string> {
  return renderMarkdownWith(markdown, {
    ...options,
    renderDiagram: typeof document === 'undefined' ? undefined : async (kind, source) => {
      const { renderDiagram } = await import('./diagrams')
      return renderDiagram(kind, source)
    },
  })
}

// Worker 与编辑器共用解析、高亮和净化。图表由有 DOM 的调用方绘制，再经过同一白名单。
export async function renderMarkdownWith(markdown: string, { resolveImage, renderDiagram }: RenderHooks): Promise<string> {
  const clean = (await import('sanitize-html')).default
  const md = parser()
  const escape = md.utils.escapeHtml
  md.renderer.rules.html_block = (tokens, index) => '<pre>' + escape(tokens[index].content) + '</pre>'
  md.renderer.rules.html_inline = (tokens, index) => {
    const html = tokens[index].content
    if (/^<input class="task-list-item-checkbox" (?:checked="" )?disabled="" type="checkbox">$/.test(html)) return html
    return /^<\/?u>$/i.test(html) ? html.toLowerCase() : escape(html)
  }
  let source = markdown.replace(/\r\n?/g, '\n')
  const front = frontMatter(source)
  let metadata = ''
  if (front?.index === 0) {
    metadata = '<pre class="yaml-frontmatter md-meta-block"><code>' + escape(front[1] ?? '') + '</code></pre>\n'
    source = source.slice(front[0].length)
  }
  if (source.includes('$') || source.includes('\\') || /\x60{3,}math/.test(source)) {
    const [{ default: texmath }, { default: katex }] = await Promise.all([import('markdown-it-texmath'), import('katex')])
    md.use(texmath, { engine: katex, delimiters: ['dollars', 'brackets'], katexOptions: { output: 'mathml', trust: false, throwOnError: false } })
  }

  const env = {}
  const tokens = md.parse(source, env)
  const headings: { id: string; title: string; tag: string }[] = []
  const used = new Set<string>()
  const jobs: Promise<void>[] = []
  const replacements = new Map<Token, string>()
  const images = new Map<string, Promise<string | undefined>>()
  for (const [index, token] of tokens.entries()) {
    if (token.type === 'list_item_open') {
      const className = token.attrGet('class')
      if (typeof className === 'string' && className.split(/\s+/).includes('task-list-item')) {
        token.attrJoin('class', 'md-task-list-item')
      }
    }
    if (token.type === 'heading_open') {
      const next = tokens[index + 1]
      const title = next.children ? textFromTokens(next.children) : next.content
      const id = headingId(title, used)
      token.attrSet('id', id)
      headings.push({ id, title, tag: token.tag })
    }
    if (resolveImage) {
      for (const child of token.children ?? []) {
        const src = child.type === 'image' ? child.attrGet('src') : null
        if (typeof src === 'string' && src && safeUrl(src, true)) {
          // 在本次渲染内复用图片读取和编码，解析失败时保留原地址。
          let image = images.get(src)
          if (!image) {
            image = Promise.resolve().then(() => resolveImage(src))
              .then(result => safeUrl(result, true) ? result : undefined).catch(() => undefined)
            images.set(src, image)
          }
          jobs.push(image.then(result => {
            if (result !== undefined) child.attrSet('src', result)
          }))
        }
      }
    }
    if (token.type === 'fence') {
      const kind = token.info.trim().split(/\s+/)[0].toLowerCase()
      if (['mermaid', 'flowchart', 'sequence'].includes(kind) && renderDiagram) {
        jobs.push(renderDiagram(kind, token.content).then(svg => {
          if (svg) replacements.set(token, '<figure class="markdown-diagram">' + svg + '</figure>')
        }))
      } else if (kind === 'math' || kind === 'latex') {
        jobs.push(import('katex').then(({ default: katex }) => {
          replacements.set(token, katex.renderToString(token.content, { output: 'mathml', displayMode: true, trust: false, throwOnError: false }))
        }))
      } else if (kind && /^[\w+-]+$/.test(kind)) {
        jobs.push(import('highlight.js').then(({ default: hljs }) => {
          if (hljs.getLanguage(kind)) {
            const highlighted = hljs.highlight(token.content, { language: kind, ignoreIllegals: true }).value
            replacements.set(token, '<pre><code class="hljs language-' + kind + '">' + highlighted + '</code></pre>\n')
          }
        }))
      }
    }
  }
  const fence = md.renderer.rules.fence!
  md.renderer.rules.fence = (items, index, ...args) =>
    (replacements.get(items[index]) ?? fence(items, index, ...args)).replace(/^<pre>/, '<pre class="md-fences">')
  const paragraph = md.renderer.rules.paragraph_open
  md.renderer.rules.paragraph_open = (items, index, opts, env, self) => {
    if (items[index + 1]?.content.trim().toUpperCase() === '[TOC]') {
      items[index + 1].children = []
      items[index + 2].hidden = true
      return '<nav class="markdown-toc md-toc"><ul class="md-toc-content">' + headings.map(({ id, title, tag }) =>
        `<li class="toc-${tag} md-toc-item md-toc-${tag}"><a class="md-toc-inner" href="#${id}">${escape(title)}</a></li>`).join('') + '</ul></nav>'
    }
    return paragraph ? paragraph(items, index, opts, env, self) : self.renderToken(items, index, opts)
  }
  await Promise.all(jobs)
  // SVG 白名单排除链接、外部资源和脚本。MathML 独立保留 KaTeX 的语义结构。
  return clean(metadata + md.renderer.render(tokens, md.options, env), {
    allowedTags: [...clean.defaults.allowedTags, 'img', 'input', 'mark', 'sup', 'sub', 'eq', 'eqn', 'math', 'semantics', 'annotation', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'ms', 'mspace',
      'msup', 'msub', 'msubsup', 'mfrac', 'msqrt', 'mroot', 'mstyle', 'mover', 'munder', 'munderover', 'mtable', 'mtr', 'mtd', 'mpadded', 'mphantom', 'menclose',
      'svg', 'g', 'defs', 'marker', 'path', 'line', 'polyline', 'polygon', 'rect', 'circle', 'ellipse', 'text', 'tspan', 'title', 'desc'],
    allowedAttributes: {
      '*': ['id', 'class', 'role', 'aria-label', 'aria-roledescription', 'fill', 'stroke'],
      a: ['href', 'title'], img: ['src', 'alt', 'title'], ol: ['start'], input: [{ name: 'type', values: ['checkbox'] }, 'checked', 'disabled'],
      math: ['xmlns', 'display'], annotation: ['encoding'],
      mi: ['mathvariant'], mo: ['stretchy', 'fence', 'separator'], mspace: ['width', 'height', 'depth'], mpadded: ['width', 'height', 'depth', 'lspace', 'voffset'],
      svg: ['xmlns', 'viewBox', 'width', 'height', 'preserveAspectRatio'], g: ['transform'],
      marker: ['viewBox', 'refX', 'refY', 'markerWidth', 'markerHeight', 'orient', 'markerUnits'],
      path: ['d', 'transform', 'marker-start', 'marker-end'], rect: ['x', 'y', 'width', 'height', 'rx', 'ry', 'transform'],
      line: ['x1', 'x2', 'y1', 'y2', 'marker-start', 'marker-end'], polyline: ['points'], polygon: ['points'],
      circle: ['cx', 'cy', 'r'], ellipse: ['cx', 'cy', 'rx', 'ry'], text: ['x', 'y', 'dx', 'dy', 'transform', 'text-anchor'], tspan: ['x', 'y', 'dx', 'dy'],
    },
    parser: { lowerCaseTags: false, lowerCaseAttributeNames: false },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https', 'asset', 'blob', 'data'] },
    transformTags: {
      img: (tagName, attrs) => {
        const { src, ...rest } = attrs
        return { tagName, attribs: src && safeUrl(src, true) ? attrs : rest }
      },
      input: (_tag, attrs) => ({
        tagName: 'input', attribs: { type: 'checkbox', class: 'task-list-item-checkbox', disabled: '', ...('checked' in attrs ? { checked: '' } : {}) },
      }),
      path: (name, attrs) => diagramShape(name, attrs, attrs.d ? 'none' : '#eef3ef'),
      line: (name, attrs) => diagramShape(name, attrs, 'none'),
      polyline: (name, attrs) => diagramShape(name, attrs, 'none'),
      polygon: (name, attrs) => diagramShape(name, attrs, '#eef3ef'),
      rect: (name, attrs) => diagramShape(name, attrs, '#eef3ef'),
      circle: (name, attrs) => diagramShape(name, attrs, '#eef3ef'),
      ellipse: (name, attrs) => diagramShape(name, attrs, '#eef3ef'),
    },
  })
}

function diagramShape(tagName: string, attribs: Record<string, string>, fill: string) {
  for (const name of ['marker-start', 'marker-end']) {
    if (!/^url\(["']?#[\w-]+["']?\)$/.test(attribs[name] ?? '')) delete attribs[name]
  }
  return { tagName, attribs: { ...attribs, fill, stroke: '#5a7065' } }
}
