import type { Appearance, Theme } from '../contracts'

export function createAppearance(paper: HTMLElement, updateNative?: (theme: Appearance | null) => void) {
  const root = paper.ownerDocument.documentElement
  const system = paper.ownerDocument.defaultView!.matchMedia('(prefers-color-scheme: dark)')
  const canvas = paper.ownerDocument.createElement('canvas')
  canvas.width = canvas.height = 1
  const pixel = canvas.getContext('2d', { willReadFrequently: true })
  let theme: Theme | undefined
  let appearance: Appearance = 'light'
  let windowTheme: Appearance | null = null

  function brightness(color: string) {
    if (!pixel) return null
    pixel.clearRect(0, 0, 1, 1)
    pixel.fillStyle = color
    pixel.fillRect(0, 0, 1, 1)
    const [red, green, blue, alpha] = pixel.getImageData(0, 0, 1, 1).data
    return alpha >= 128 ? (red * .2126 + green * .7152 + blue * .0722) / 255 : null
  }

  function apply() {
    // 推断前移除上一主题的派生颜色，避免白色主题继承上一轮的暗底。
    delete paper.dataset.appearance
    const nativeAuto = !theme || theme.styles.some(css => /prefers-color-scheme\s*:/i.test(css))
    appearance = system.matches ? 'dark' : 'light'
    if (theme) {
      const colors = getComputedStyle(paper)
      const light = brightness(colors.backgroundColor)
      if (colors.colorScheme === 'dark' || (light !== null && light < .48)) {
        appearance = 'dark'
        if (light !== null && light < .48) root.style.setProperty('--yy-theme-surface', colors.backgroundColor)
        else root.style.removeProperty('--yy-theme-surface')
      } else {
        root.style.removeProperty('--yy-theme-surface')
        appearance = light !== null || colors.colorScheme === 'light' ? 'light' : appearance
      }
    } else root.style.removeProperty('--yy-theme-surface')

    root.dataset.yeyuAppearance = appearance
    paper.dataset.appearance = appearance
    const nextWindowTheme = nativeAuto ? null : appearance
    if (windowTheme !== nextWindowTheme) {
      windowTheme = nextWindowTheme
      updateNative?.(windowTheme)
    }
  }

  system.addEventListener('change', apply)
  apply()
  return {
    get: () => appearance,
    select(next: Theme | undefined) { theme = next; apply() },
    destroy() {
      system.removeEventListener('change', apply)
      delete root.dataset.yeyuAppearance
      root.style.removeProperty('--yy-theme-surface')
      if (windowTheme !== null) updateNative?.(null)
    },
  }
}
