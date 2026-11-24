import { count, cursor } from './document-tools'
import { outlineMarkdown } from './editor/outline'

let lastId = -1
let current = ''
let totals = { words: 0, characters: 0 }
self.onmessage = (event: MessageEvent<{ task: number; doc: number; text?: string; offset: number }>) => {
  const { task, doc, text, offset } = event.data
  if (doc !== lastId && text !== undefined) {
    current = text
    totals = count(text)
    lastId = doc
    // 先给出统计和光标，独立回传大纲，减少首次打开时的界面延迟。
    self.postMessage({ task, doc, ...totals, ...cursor(current, offset) })
    self.postMessage({ doc, outline: outlineMarkdown(text) })
  } else self.postMessage({ task, doc, ...totals, ...cursor(current, offset) })
}
