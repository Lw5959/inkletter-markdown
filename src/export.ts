import type { ExportFormat, RenderOptions, Theme } from './contracts'
import { renderMarkdown } from './editor'
import { invoke } from './native'
import './print.css'

export const visual = new Set<ExportFormat>(['pdf', 'png', 'html', 'plain-html'])
export const formatExtensions: Record<ExportFormat, string> = {
  html: 'html', 'plain-html': 'html', pdf: 'pdf', png: 'png', docx: 'docx', epub: 'epub',
  odt: 'odt', latex: 'tex', rtf: 'rtf', rst: 'rst', textile: 'textile', opml: 'opml',
  revealjs: 'html', json: 'json', commonmark: 'md',
}
const documentStyles = `
@page { size: A4; margin: 18mm; }
html,body { margin:0; }
.document-theme { background:#fff; color:#202522; font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
#write { box-sizing:border-box; width:min(100%, 840px); margin:0 auto; padding:36px 48px; overflow-wrap:anywhere; }
#write :is(img,svg,video) { max-width:100%; height:auto; }
#write table { border-collapse:collapse; }
#write :is(th,td) { border:1px solid #b8c5bf; padding:.3em .65em; }
#write pre { white-space:pre-wrap; padding:1em; background:#f3f5f3; border-radius:.35em; }
#write blockquote { margin-inline:0; padding-inline:1rem; border-inline-start:.2em solid #a6b7b0; }
#write a { color:#1c6453; }
@media print { #write { width:auto!important; max-width:none!important; padding:0!important; } #write :is(h1,h2,h3,h4,figcaption) { break-after:avoid; } #write :is(img,svg,table) { break-inside:avoid; } }
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
<body><main class="document-theme typora-export"><article id="write">${content}</article></main></body></html>`
}

export async function print(markdown: string, options: RenderOptions, theme: Theme | undefined) {
  document.getElementById('page-print')?.remove()
  const stage = document.createElement('div')
  stage.id = 'page-print'
  stage.className = 'document-theme typora-export'
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
