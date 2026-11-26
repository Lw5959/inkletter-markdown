import { renderMarkdown, renderMarkdownWith } from '../editor/render'
import { el } from './helpers'

const externalLink = /^(https?:\/\/|mailto:)/i

function replyFragment(html: string) {
  const template = document.createElement('template')
  template.innerHTML = html
  const { content } = template
  // 模型生成的图片先保留为可查看的链接，渲染对话时不自动访问第三方地址。
  for (const image of content.querySelectorAll('img')) {
    const source = image.getAttribute('src') ?? ''
    const label = image.alt || '查看图片'
    image.replaceWith(/^https?:\/\//i.test(source)
      ? el('a', { text: label, attrs: { href: source } })
      : document.createTextNode(label))
  }
  for (const anchor of content.querySelectorAll<HTMLElement>('[id]')) {
    if (!(anchor instanceof HTMLElement)) continue
    anchor.dataset.replyAnchor = anchor.id
    anchor.removeAttribute('id')
  }
  for (const link of content.querySelectorAll('a[href]')) {
    const url = link.getAttribute('href') ?? ''
    if (!url.startsWith('#') && !externalLink.test(url)) link.removeAttribute('href')
  }
  for (const table of content.querySelectorAll('table')) {
    const scroll = el('div', { className: 'yy-ai-table-scroll', attrs: { tabindex: '0' } })
    table.replaceWith(scroll)
    scroll.append(table)
  }
  return content
}

export function replyLink(event: MouseEvent) {
  const target = event.target
  const link = target instanceof Element ? target.closest<HTMLAnchorElement>('a[href]') : null
  const body = link?.closest('.yy-ai-markdown')
  const url = link?.getAttribute('href')
  if (!body || !url) return null
  event.preventDefault()
  if (url.startsWith('#')) {
    let anchor: string
    try { anchor = decodeURIComponent(url.slice(1)) } catch { return null }
    const section = Array.from(body.querySelectorAll<HTMLElement>('[data-reply-anchor]'))
      .find(item => item.dataset.replyAnchor === anchor)
    section?.scrollIntoView({ block: 'nearest' })
  }
  return externalLink.test(url) ? url : null
}

export function replyBody() {
  return el('div', { className: 'yy-msg-body yy-ai-markdown' })
}

export async function renderReply(body: HTMLElement, text: string, streaming = false, current = () => true) {
  let rendered: Node
  try {
    // 流式输出按批合并，图表和代码高亮等模型完成后再渲染。
    const html = streaming ? await renderMarkdownWith(text, { highlightCode: false }) : await renderMarkdown(text)
    rendered = replyFragment(html)
  } catch {
    rendered = document.createTextNode(text)
  }
  if (!current()) return
  const conversation = body.closest<HTMLElement>('.yy-ai-conversation')
  const follow = conversation && conversation.scrollHeight - conversation.clientHeight - conversation.scrollTop < 48
  body.replaceChildren(rendered)
  if (follow) conversation.scrollTop = conversation.scrollHeight
}

export class StreamingReply {
  readonly element = replyBody()
  private source = ''
  private timer = 0
  private revision = 0
  private rendering = false

  set(text: string) {
    if (text === this.source) return
    if (!text || !text.startsWith(this.source)) {
      this.revision++
      window.clearTimeout(this.timer)
      this.timer = 0
      this.element.replaceChildren()
    }
    this.source = text
    this.schedule()
  }

  private schedule() {
    if (!this.source || this.timer || this.rendering) return
    this.timer = window.setTimeout(() => { void this.flush() }, 90)
  }

  private async flush() {
    this.timer = 0
    this.rendering = true
    const { source, revision } = this
    await renderReply(this.element, source, true, () => revision === this.revision)
    this.rendering = false
    if (source !== this.source || revision !== this.revision) this.schedule()
  }
}
