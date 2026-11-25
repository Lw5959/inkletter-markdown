import { invoke } from '@tauri-apps/api/core'

type Insets = { left: number; top: number; right: number; bottom: number }

export function installMobileViewport(paper: HTMLElement) {
  const root = document.documentElement
  const viewport = window.visualViewport
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
      const selection = document.getSelection()
      if (!selection?.focusNode || !paper.contains(selection.focusNode) || !paper.contains(document.activeElement)) return
      // 键盘改变可用高度后，只在光标被遮住时移动文档，不改变选区或打断输入法组合。
      const caret = document.createRange()
      caret.setStart(selection.focusNode, selection.focusOffset)
      caret.collapse(true)
      const line = caret.getBoundingClientRect()
      const visible = paper.getBoundingClientRect()
      if (!line.height) return
      const gap = Math.max(0, Math.min(20, (visible.height - line.height) / 2))
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
