import { EditorView, WidgetType } from '@codemirror/view'

export abstract class LiveBlock extends WidgetType {
  height = -1
  get estimatedHeight() { return this.height }

  protected reserveHeight(element: HTMLElement) {
    if (this.height > 0) element.style.minHeight = `${this.height}px`
  }

  protected measureHeight(view: EditorView, element: HTMLElement) {
    // 离屏区块重新挂载时，异步渲染完成前沿用原来的高度，避免先收缩再撑开。
    element.style.removeProperty('min-height')
    view.requestMeasure({
      key: element,
      read: () => element.isConnected ? element.offsetHeight : 0,
      write: height => { if (height > 0) this.height = height },
    })
  }
}
