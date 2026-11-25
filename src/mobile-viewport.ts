import { invoke } from '@tauri-apps/api/core'
import { EditorView } from '@codemirror/view'

type Insets = { left: number; top: number; right: number; bottom: number }

export function installMobileViewport(paper: HTMLElement) {
  const root = document.documentElement
  const viewport = window.visualViewport
  const container = paper.querySelector<HTMLElement>('.cm-editor')
  const editor = container && EditorView.findFromDOM(container)
  let pendingFrame = 0
  let measuredHeight = 0

  function resize() {
    if (pendingFrame) return
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = 0
      const height = Math.round(Math.min(window.innerHeight, viewport?.height ?? window.innerHeight))
      if (height !== measuredHeight) {
        measuredHeight = height
        root.style.setProperty('--yy-viewport-height', `${height}px`)
      }
      if (!editor?.hasFocus) return
      // 键盘改变可用高度后，只在光标被遮住时移动文档，不改变选区或打断输入法组合。
      // WebKit 的折叠 DOM 选区可能返回空矩形，使用编辑器自身的光标几何。
      const line = editor.coordsAtPos(editor.state.selection.main.head)
      const visible = paper.getBoundingClientRect()
      if (!line) return
      const gap = Math.max(0, Math.min(20, (visible.height - (line.bottom - line.top)) / 2))
      if (line.bottom > visible.bottom - gap) paper.scrollTop += line.bottom - visible.bottom + gap
      else if (line.top < visible.top + gap) paper.scrollTop += line.top - visible.top - gap
    })
  }

  function setInsets(insets: Insets) {
    for (const side of ['left', 'top', 'right', 'bottom'] as const) root.style.setProperty(`--yy-safe-${side}`, `${insets[side]}px`)
    resize()
  }

  window.addEventListener('yeyu:insets', event => setInsets((event as CustomEvent<Insets>).detail))
  window.addEventListener('resize', resize)
  viewport?.addEventListener('resize', resize)
  paper.addEventListener('focusin', resize)
  void invoke<Insets | null>('android_insets').then(insets => { if (insets) setInsets(insets) }).catch(() => {})
  resize()
}
