import { el } from './helpers'
import { renderMarkdownContent } from './markdown-content'

export function replyBody() {
  return el('div', { className: 'yy-msg-body yy-markdown-content' })
}

export async function renderReply(body: HTMLElement, text: string, streaming = false, current = () => true) {
  // 流式输出按批合并，图表和代码高亮等模型完成后再渲染。
  const rendered = await renderMarkdownContent(text, streaming)
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
