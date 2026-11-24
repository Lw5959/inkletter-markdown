import type { ExportFormat, RenderOptions, Theme } from './contracts'
import { renderMarkdown } from './editor'
import { invoke } from './native'
import baseStyles from './editor/document.css?raw'
import './print.css'

export const visual = new Set<ExportFormat>(['pdf', 'png', 'html', 'plain-html'])
export const formatExtensions: Record<ExportFormat, string> = {
  html: 'html', 'plain-html': 'html', pdf: 'pdf', png: 'png', docx: 'docx', epub: 'epub',
  odt: 'odt', latex: 'tex', rtf: 'rtf', rst: 'rst', textile: 'textile', opml: 'opml',
  revealjs: 'html', json: 'json', commonmark: 'md',
}
const documentStyles = baseStyles + `
@page { size: A4; margin: 18mm; }
html, body { margin: 0; }
@media print {
  #write { width: auto !important; max-width: none !important; padding: 0 !important; }
  #write :is(h1, h2, h3, h4, figcaption) { break-after: avoid; }
  #write :is(img, svg, table) { break-inside: avoid; }
}
`
function safeStyle(css: string) {
  return css.replace(/<\/style/gi, '<\\/style')
}
function escaped(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export async function exportHtml(markdown: string, title: string, options: RenderOptions, theme: Theme | undefined, plain: boolean) {
  const content = await renderMarkdown(markdown, options)
  const css = plain ? '' : '<style>' + safeStyle(documentStyles + (theme?.styles ?? []).join('\n')) + '</style>'
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<title>${escaped(title)}</title>${css}</head>
<body><main class="document-theme typora-export" data-theme="${theme ? 'imported' : 'default'}"><article id="write">${content}</article></main></body></html>`
}

export async function print(markdown: string, options: RenderOptions, theme: Theme | undefined) {
  document.getElementById('page-print')?.remove()
  const stage = document.createElement('div')
  stage.id = 'page-print'
  stage.className = 'document-theme typora-export'
  stage.dataset.theme = theme ? 'imported' : 'default'
  const style = document.createElement('style')
  style.textContent = '@media print {\n' + documentStyles + (theme?.styles ?? []).join('\n') + '\n}'
  const body = document.createElement('article')
  body.id = 'write'
  body.innerHTML = await renderMarkdown(markdown, options)
  stage.append(style, body)
  document.body.append(stage)
  try {
    await document.fonts.ready
    await invoke('print_document')
  } finally {
    // 系统打印面板可能在原生命令返回后才读取布局。
    window.addEventListener('afterprint', () => stage.remove(), { once: true })
    window.setTimeout(() => stage.remove(), 45_000)
  }
}
