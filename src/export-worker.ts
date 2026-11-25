/// <reference lib="webworker" />

import { renderMarkdownWith } from './editor/render'

export type ExportAsset =
  | { type: 'image'; url: string }
  | { type: 'diagram'; kind: string; source: string }

export type ExportWorkerInput =
  | { type: 'render'; markdown: string; images: boolean }
  | { type: 'resolved'; id: number; value: string | null }

export type ExportWorkerOutput =
  | { type: 'resolve'; id: number; asset: ExportAsset }
  | { type: 'rendered'; html: string }
  | { type: 'failed'; message: string }

const worker = self as unknown as DedicatedWorkerGlobalScope
const pending = new Map<number, (value: string | null) => void>()
let nextId = 0

function send(message: ExportWorkerOutput) {
  worker.postMessage(message)
}

function request(asset: ExportAsset) {
  return new Promise<string | null>(resolve => {
    const id = ++nextId
    pending.set(id, resolve)
    send({ type: 'resolve', id, asset })
  })
}

worker.onmessage = ({ data }: MessageEvent<ExportWorkerInput>) => {
  if (data.type === 'resolved') {
    pending.get(data.id)?.(data.value)
    pending.delete(data.id)
    return
  }
  // 图片沿用应用的文件解析逻辑，Mermaid 沿用窗口中的 DOM 绘制。
  void renderMarkdownWith(data.markdown, {
    resolveImage: data.images ? async url => await request({ type: 'image', url }) ?? url : undefined,
    renderDiagram: (kind, source) => request({ type: 'diagram', kind, source }),
  }).then(html => send({ type: 'rendered', html }))
    .catch(error => send({ type: 'failed', message: String(error) }))
}
