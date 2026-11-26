type SwipeEdge = 'left' | 'right'
type BackLayer = { element: HTMLElement; restore: () => void }
type Gesture = {
  layer: BackLayer
  edge: SwipeEdge
  progress: number
  animation: Animation
  settling?: boolean
  commit?: () => void
}

const resting = { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1 }
const seekDuration = 200
const easing = 'cubic-bezier(.22, .8, .25, 1)'

function backFrame(progress: number, edge: SwipeEdge, opacity = 1 - progress * .05) {
  const distance = (edge === 'right' ? -12 : 12) * progress
  return { transform: `translate3d(${distance}%, 0, 0) scale(${1 - progress * .12})`, opacity }
}

export function createMobileMotion(reducedMotion: MediaQueryList) {
  let entrance: Animation | undefined
  let gesture: Gesture | undefined
  let completing = false
  const enabled = () => !reducedMotion.matches && document.documentElement.dataset.yeyuMotion !== 'off'

  function clearBack(commit = false) {
    const current = gesture
    if (!current) return
    gesture = undefined
    current.animation.cancel()
    current.layer.element.removeAttribute('data-yeyu-back-preview')
    current.layer.restore()
    if (commit && current.commit) {
      completing = true
      try { current.commit() } finally { completing = false }
    }
  }

  function enter(element: HTMLElement, direction: 'forward' | 'back') {
    clearBack()
    entrance?.cancel()
    if (!enabled() || completing) return
    entrance = element.animate([
      { transform: `translate3d(${direction === 'forward' ? 9 : -6}%, 0, 0)`, opacity: .74 },
      { transform: 'translate3d(0, 0, 0)', opacity: 1 },
    ], { duration: 210, easing })
  }

  function startBack(reveal: () => BackLayer | null, edge: SwipeEdge) {
    clearBack(true)
    if (!enabled()) return
    const layer = reveal()
    if (!layer) return
    entrance?.cancel()
    layer.element.dataset.yeyuBackPreview = edge
    const animation = layer.element.animate([resting, backFrame(1, edge)], { duration: seekDuration, fill: 'both' })
    animation.pause()
    animation.currentTime = 0
    gesture = { layer, edge, progress: 0, animation }
  }

  function progressBack(progress: number) {
    if (!gesture || gesture.settling || !Number.isFinite(progress)) return
    // 逐帧只更新合成动画的时间，预览页在手势开始时就已摆放好。
    gesture.progress = Math.max(0, Math.min(1, progress))
    gesture.animation.currentTime = gesture.progress * seekDuration
  }

  function settle(current: Gesture, target: Keyframe, duration: number) {
    current.settling = true
    current.animation.cancel()
    current.animation = current.layer.element.animate([backFrame(current.progress, current.edge), target], { duration, easing, fill: 'both' })
    current.animation.onfinish = () => { if (gesture === current) clearBack(true) }
  }

  function cancelBack() {
    if (!gesture || gesture.settling) return
    if (gesture.progress > 0 && enabled()) settle(gesture, resting, 140)
    else clearBack()
  }

  function commitBack(action: () => void) {
    if (gesture?.commit) return
    if (!gesture || gesture.settling || !enabled()) {
      clearBack()
      action()
      return
    }
    gesture.commit = action
    settle(gesture, backFrame(1.15, gesture.edge, 0), 130)
  }

  function reset() {
    entrance?.cancel()
    clearBack(true)
  }

  return { enabled, enter, startBack, progressBack, cancelBack, commitBack, reset }
}
