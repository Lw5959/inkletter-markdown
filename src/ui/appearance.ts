import type { Appearance, Theme } from '../contracts'

type Color = [number, number, number]
const white: Color = [255, 255, 255]
const black: Color = [0, 0, 0]
const paletteProperties = ['surface', 'ink', 'accent', 'on-accent'] as const

function luminance([red, green, blue]: Color) {
  const linear = (channel: number) => {
    const value = channel / 255
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
  }
  return .2126 * linear(red) + .7152 * linear(green) + .0722 * linear(blue)
}

function contrast(a: Color, b: Color) {
  const lightA = luminance(a) + .05
  const lightB = luminance(b) + .05
  return Math.max(lightA, lightB) / Math.min(lightA, lightB)
}

function contrastingNeutral(color: Color) {
  return contrast(white, color) >= contrast(black, color) ? white : black
}

function readableColor(color: Color, background: Color, minimum: number): Color {
  // 低对比度主题沿原色调拉开明暗，保留小字号标签和按钮文字的可读性。
  const neutral = contrastingNeutral(background)
  for (let amount = 0; amount < 1; amount += .1) {
    const candidate = color.map((channel, index) => Math.round(channel + (neutral[index] - channel) * amount)) as Color
    if (contrast(candidate, background) >= minimum) return candidate
  }
  return neutral
}

export function createAppearance(paper: HTMLElement, updateNative?: (theme: Appearance | null) => void) {
  const root = paper.ownerDocument.documentElement
  const system = paper.ownerDocument.defaultView!.matchMedia('(prefers-color-scheme: dark)')
  const canvas = paper.ownerDocument.createElement('canvas')
  canvas.width = canvas.height = 1
  const pixel = canvas.getContext('2d', { willReadFrequently: true })
  let theme: Theme | undefined
  let appearance: Appearance = 'light'
  let windowTheme: Appearance | null = null

  function readColor(color: string): Color | undefined {
    if (!pixel || !color.trim()) return undefined
    pixel.clearRect(0, 0, 1, 1)
    pixel.fillStyle = 'transparent'
    pixel.fillStyle = color
    pixel.fillRect(0, 0, 1, 1)
    const [red, green, blue, alpha] = pixel.getImageData(0, 0, 1, 1).data
    return alpha === 255 ? [red, green, blue] : undefined
  }

  function clearPalette() {
    root.removeAttribute('data-yeyu-theme')
    for (const name of paletteProperties) root.style.removeProperty('--yy-theme-' + name)
  }

  function readThemePalette() {
    const write = paper.querySelector<HTMLElement>('#write')
    const paperStyle = getComputedStyle(paper)
    const textStyle = write ? getComputedStyle(write) : paperStyle
    const documentSurface = readColor(textStyle.backgroundColor) ?? readColor(paperStyle.backgroundColor)
    const token = (name: string) => readColor(textStyle.getPropertyValue(name))
    if (paperStyle.colorScheme === 'dark' || textStyle.colorScheme === 'dark') appearance = 'dark'
    else if (documentSurface) {
      const [red, green, blue] = documentSurface
      appearance = (red * .2126 + green * .7152 + blue * .0722) / 255 < .48 ? 'dark' : 'light'
    } else if (paperStyle.colorScheme === 'light') appearance = 'light'

    const dark = appearance === 'dark'
    const referenceInk = dark ? white : black
    const baseSurface = token('--side-bar-bg-color') ?? documentSurface ?? (dark ? [36, 36, 36] : white)
    const surface = readableColor(baseSurface, referenceInk, 8)
    const ink = readableColor(readColor(textStyle.color) ?? referenceInk, surface, 8)
    let accent = token('--primary-color') ?? token('--link-color')
    if (!accent && write) {
      // 个别主题直接给文档链接着色。用不可见链接取色，主题切换不依赖当前文档内容。
      const sample = paper.ownerDocument.createElement('a')
      sample.href = '#'
      sample.style.setProperty('display', 'none', 'important')
      write.append(sample)
      accent = readColor(getComputedStyle(sample).color)
      sample.remove()
    }
    const action = readableColor(accent ?? token('--doc-accent') ?? ink, surface, 6.5)
    return { surface, ink, accent: action, 'on-accent': contrastingNeutral(action) }
  }

  function apply() {
    // 先恢复文档的基础配色，避免上一主题的明暗参与本轮取色。
    delete paper.dataset.appearance
    const nativeAuto = !theme || theme.styles.some(css => /prefers-color-scheme\s*:/i.test(css))
    appearance = system.matches ? 'dark' : 'light'
    if (theme) {
      const colors = readThemePalette()
      for (const name of paletteProperties) {
        root.style.setProperty('--yy-theme-' + name, `rgb(${colors[name].join(', ')})`)
      }
      root.setAttribute('data-yeyu-theme', '')
    } else clearPalette()

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
      clearPalette()
      if (windowTheme !== null) updateNative?.(null)
    },
  }
}
