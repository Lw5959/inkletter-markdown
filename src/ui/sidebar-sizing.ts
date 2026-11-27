import type { SidebarSide, SidebarWidths } from '../contracts'
import { el } from './helpers'

const sides = ['left', 'right'] as const
const minimum = { left: 192, right: 248 }

export function sidebarSizing(body: HTMLElement, slots: Record<SidebarSide, HTMLElement>, save: (side: SidebarSide, width: number) => void) {
  const preferred: SidebarWidths = {}
  const widths = { left: 0, right: 0 }
  const min = { ...minimum }
  const max = { left: 0, right: 0 }
  const grips = {
    left: grip('left', '调整左侧栏宽度'),
    right: grip('right', '调整右侧栏宽度'),
  }

  function refresh() {
    const windowWidth = body.clientWidth
    if (!windowWidth) return
    const leftOpen = slots.left.dataset.open === 'true'
    const rightOpen = slots.right.dataset.open === 'true'
    const narrow = window.innerWidth <= 820
    // 保留正文可用宽度。缩小窗口只收紧显示尺寸，窗口放大后恢复用户的设置。
    const available = windowWidth - Math.min(192, Math.round(windowWidth * .3))
    const scale = leftOpen && rightOpen ? Math.min(1, available / (minimum.left + minimum.right)) : 1
    min.left = Math.min(available, Math.floor(minimum.left * scale))
    min.right = Math.min(available, Math.floor(minimum.right * scale))
    widths.left = clamp(preferred.left ?? (narrow ? 224 : 220), min.left, available - (rightOpen ? min.right : 0))
    widths.right = clamp(preferred.right ?? Math.min(narrow ? 300 : 360, Math.round(window.innerWidth * .46)), min.right,
      available - (leftOpen ? widths.left : 0))
    max.left = available - (rightOpen ? widths.right : 0)
    max.right = available - (leftOpen ? widths.left : 0)
    for (const side of sides) {
      slots[side].style.setProperty('--yy-sidebar-size', `${widths[side]}px`)
      grips[side].setAttribute('aria-valuemin', String(min[side]))
      grips[side].setAttribute('aria-valuemax', String(max[side]))
      grips[side].setAttribute('aria-valuenow', String(widths[side]))
    }
  }

  function resize(side: SidebarSide, requested: number) {
    const width = clamp(requested, min[side], max[side])
    if (width === widths[side]) return false
    preferred[side] = width
    refresh()
    return true
  }

  function grip(side: SidebarSide, label: string) {
    const slot = slots[side]
    const panel = slot.querySelector('aside')!
    panel.id = `yy-sidebar-${side}`
    const handle = el('div', {
      className: 'yy-sidebar-grip', title: label,
      attrs: { role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', 'aria-label': label, 'aria-controls': panel.id },
    })
    const direction = side === 'left' ? 1 : -1
    let drag: { id: number; x: number; width: number; preferred?: number } | undefined
    handle.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0 || body.dataset.sidebarDrag) return
      event.preventDefault()
      handle.focus({ preventScroll: true })
      handle.setPointerCapture(event.pointerId)
      drag = { id: event.pointerId, x: event.clientX, width: widths[side], preferred: preferred[side] }
      body.dataset.sidebarDrag = side
    })
    handle.addEventListener('pointermove', event => {
      if (drag?.id === event.pointerId) resize(side, drag.width + Math.round((event.clientX - drag.x) * direction))
    })
    handle.addEventListener('lostpointercapture', event => {
      if (drag?.id !== event.pointerId) return
      delete body.dataset.sidebarDrag
      if (widths[side] !== drag.width && preferred[side] !== undefined) save(side, preferred[side])
      else {
        preferred[side] = drag.preferred
        refresh()
      }
      drag = undefined
    })
    handle.addEventListener('keydown', event => {
      if (drag) return
      let next: number
      switch (event.key) {
        case 'ArrowLeft': next = widths[side] - 16 * direction; break
        case 'ArrowRight': next = widths[side] + 16 * direction; break
        case 'Home': next = min[side]; break
        case 'End': next = max[side]; break
        default: return
      }
      event.preventDefault()
      if (resize(side, next)) save(side, widths[side])
    })
    slot.append(handle)
    return handle
  }

  const observer = new ResizeObserver(refresh)
  observer.observe(body)
  return {
    refresh,
    set(widths: SidebarWidths) {
      for (const side of sides) preferred[side] = Number.isFinite(widths[side]) ? widths[side] : undefined
      refresh()
    },
    destroy() { observer.disconnect() },
  }
}

function clamp(width: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(width)))
}
