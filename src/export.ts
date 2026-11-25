import type { Appearance, ExportFormat, RenderOptions, Theme } from './contracts'
import { renderMarkdown } from './editor/render'
import type { ExportAsset, ExportWorkerInput, ExportWorkerOutput } from './export-worker'
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
/* 给长图和打印保留正文空间。横图仍可用满正文宽度，图片保持原始比例。 */
:where(.typora-export #write img) { max-height: 20rem; object-fit: contain; }
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

let idleWorker: { worker: Worker; timer: number } | undefined

async function resolveAsset(asset: ExportAsset, { resolveImage }: RenderOptions) {
  if (asset.type === 'image') {
    try {
      return await resolveImage?.(asset.url) ?? null
    } catch {
      return null
    }
  }
  const { renderDiagram } = await import('./editor/diagrams')
  return renderDiagram(asset.kind, asset.source)
}

async function renderExport(markdown: string, options: RenderOptions) {
  if (typeof Worker === 'undefined') return renderMarkdown(markdown, options)

  const idle = idleWorker
  idleWorker = undefined
  if (idle) window.clearTimeout(idle.timer)
  const worker = idle?.worker ?? new Worker(new URL('./export-worker.ts', import.meta.url), { type: 'module' })
  try {
    const html = await new Promise<string>((resolve, reject) => {
      const send = (message: ExportWorkerInput) => worker.postMessage(message)
      worker.onmessage = ({ data }: MessageEvent<ExportWorkerOutput>) => {
        if (data.type === 'rendered') resolve(data.html)
        else if (data.type === 'failed') reject(new Error(data.message))
        else void resolveAsset(data.asset, options)
          .then(value => send({ type: 'resolved', id: data.id, value })).catch(reject)
      }
      worker.onerror = event => reject(new Error(event.message || '无法启动导出渲染'))
      worker.onmessageerror = () => reject(new Error('无法读取导出渲染结果'))
      send({ type: 'render', markdown, images: !!options.resolveImage })
    })
    worker.onmessage = worker.onerror = worker.onmessageerror = null
    // 同一 Worker 一次处理一份文档。短暂保留空闲实例，供连续导出复用已加载的依赖。
    if (idleWorker) worker.terminate()
    else idleWorker = { worker, timer: window.setTimeout(() => {
      idleWorker = undefined
      worker.terminate()
    }, 5_000) }
    return html
  } catch (error) {
    worker.terminate()
    throw error
  }
}

export async function exportHtml(markdown: string, title: string, options: RenderOptions, theme: Theme | undefined, plain: boolean, appearance: Appearance) {
  const content = await renderExport(markdown, options)
  const css = plain ? '' : '<style>' + safeStyle(documentStyles + (theme?.styles ?? []).join('\n')) + '</style>'
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<title>${escaped(title)}</title>${css}</head>
<body><main class="document-theme typora-export" data-appearance="${appearance}"><article id="write">${content}</article></main></body></html>`
}

export async function print(markdown: string, options: RenderOptions, theme: Theme | undefined, appearance: Appearance) {
  document.getElementById('page-print')?.remove()
  const stage = document.createElement('div')
  stage.id = 'page-print'
  stage.className = 'document-theme typora-export'
  stage.dataset.appearance = appearance
  const style = document.createElement('style')
  style.textContent = '@media print {\n' + documentStyles + (theme?.styles ?? []).join('\n') + '\n}'
  const body = document.createElement('article')
  body.id = 'write'
  body.innerHTML = await renderExport(markdown, options)
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
