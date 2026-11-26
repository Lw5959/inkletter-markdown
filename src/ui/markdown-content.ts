import { renderMarkdown, renderMarkdownWith } from '../editor/render'
import { el } from './helpers'
import './markdown-content.css'

const externalLink = /^(https?:\/\/|mailto:)/i

export async function renderMarkdownContent(markdown: string, streaming = false) {
  const template = document.createElement('template')
  try {
    template.innerHTML = streaming
      ? await renderMarkdownWith(markdown, { highlightCode: false })
      : await renderMarkdown(markdown)
  } catch {
    return document.createTextNode(markdown)
  }
  const { content } = template
  // 来自发布源或模型的图片通过链接查看，避免渲染时自动访问第三方地址。
  for (const image of content.querySelectorAll('img')) {
    const source = image.getAttribute('src') ?? ''
    const label = image.alt || '查看图片'
    image.replaceWith(/^https?:\/\//i.test(source)
      ? el('a', { text: label, attrs: { href: source } })
      : document.createTextNode(label))
  }
  for (const anchor of content.querySelectorAll<HTMLElement>('[id]')) {
    if (!(anchor instanceof HTMLElement)) continue
    anchor.dataset.markdownAnchor = anchor.id
    anchor.removeAttribute('id')
  }
  for (const link of content.querySelectorAll('a[href]')) {
    const url = link.getAttribute('href') ?? ''
    if (!url.startsWith('#') && !externalLink.test(url)) link.removeAttribute('href')
  }
  for (const table of content.querySelectorAll('table')) {
    const scroll = el('div', { className: 'yy-markdown-table-scroll', attrs: { tabindex: '0' } })
    table.replaceWith(scroll)
    scroll.append(table)
  }
  return content
}

export function markdownLink(event: MouseEvent) {
  const target = event.target
  const link = target instanceof Element ? target.closest<HTMLAnchorElement>('a[href]') : null
  const body = link?.closest('.yy-markdown-content')
  const url = link?.getAttribute('href')
  if (!body || !url) return null
  event.preventDefault()
  if (url.startsWith('#')) {
    let anchor: string
    try { anchor = decodeURIComponent(url.slice(1)) } catch { return null }
    const section = Array.from(body.querySelectorAll<HTMLElement>('[data-markdown-anchor]'))
      .find(item => item.dataset.markdownAnchor === anchor)
    section?.scrollIntoView({ block: 'nearest' })
  }
  return externalLink.test(url) ? url : null
}
