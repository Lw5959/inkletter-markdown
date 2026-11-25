import type { Appearance, Theme } from './contracts'

const palettes = [
  { id: 'builtin-paper', name: '白纸', appearance: 'light', paper: '#ffffff', ink: '#262626', accent: '#454545', serif: true },
  { id: 'builtin-jade', name: '青瓷', appearance: 'light', paper: '#eef5f0', ink: '#243731', accent: '#315f4d' },
  { id: 'builtin-graphite', name: '石墨', appearance: 'dark', paper: '#242424', ink: '#ededed', accent: '#cfcfcf' },
  { id: 'builtin-pine', name: '松夜', appearance: 'dark', paper: '#192620', ink: '#e4efe7', accent: '#a6d4b6' },
] satisfies Array<{
  id: string; name: string; appearance: Appearance; paper: string; ink: string; accent: string; serif?: boolean
}>

export const builtinThemes: Theme[] = palettes.map(({ id, name, appearance, paper, ink, accent, serif }) => ({
  id, name, swatch: { paper, ink },
  // CSS 随文档一同导出，并使用系统字体保证离线可用。
  styles: [`.document-theme {
    color-scheme: ${appearance};
    --doc-paper: ${paper};
    --doc-ink: ${ink};
    --doc-accent: ${accent};
    --doc-muted: color-mix(in srgb, ${ink} 75%, ${paper});
    --doc-rule: color-mix(in srgb, ${paper} 83%, ${ink});
    --doc-surface: color-mix(in srgb, ${paper} 94%, ${ink});
    --doc-code: color-mix(in srgb, ${paper} 91%, ${ink});
    --doc-selection: color-mix(in srgb, ${paper} 68%, ${accent});
    --doc-mark: color-mix(in srgb, ${paper} 75%, ${accent});
    ${serif ? '--doc-font: Georgia, "Songti SC", "Noto Serif CJK SC", SimSun, serif;' : ''}
  }`],
}))
