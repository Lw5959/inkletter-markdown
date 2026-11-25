import { normalizeCombo, SHORTCUT_DEFINITIONS, type ShortcutCommandId } from './ui/shortcuts'
import type { SidebarTab } from './contracts'

export type TyporaProfile = { name: string; text: string }
export type ImageUploadService = 'multipart' | 'picgo'

const shortcutNames: Partial<Record<ShortcutCommandId, string[]>> = {
  'file.new': ['New', '新建'], 'file.open': ['Open', '打开'], 'file.openFolder': ['Open Folder'],
  'file.save': ['Save'], 'file.saveAs': ['Save As'], 'file.print': ['Print'],
  'nav.quickOpen': ['Open Quickly', 'Quick Open', '快速打开'], 'nav.find': ['Find', '查找'],
  'nav.replace': ['Replace', '替换'], 'nav.searchWorkspace': ['Search in Files', 'Find in Files'],
  'view.toggleMode': ['Source Code Mode', 'Source Mode', '源代码模式', '源码模式'],
  'view.toggleSidebar': ['Toggle Sidebar', 'Show Sidebar', 'Hide Sidebar', '显示侧边栏', '隐藏侧边栏'],
  'view.toggleOutline': ['Outline', '大纲'], 'view.toggleFocus': ['Focus Mode', '专注模式'],
  'view.toggleTypewriter': ['Typewriter Mode', '打字机模式'],
  'format.bold': ['Bold', 'Strong', '粗体', '着重'], 'format.italic': ['Italic', 'Emphasis'],
  'format.underline': ['Underline'], 'format.strike': ['Strike', 'Strikethrough'],
  'format.inlineCode': ['Inline Code', 'Code', '代码'], 'format.link': ['Link', 'Hyperlink', '链接'],
  'format.heading1': ['Heading 1', '标题 1', '标题1'], 'format.heading2': ['Heading 2', '标题 2', '标题2'],
  'format.heading3': ['Heading 3', '标题 3', '标题3'], 'format.quote': ['Quote', 'Blockquote', '引用'],
  'format.codeBlock': ['Code Fences', 'Code Block'], 'edit.pastePlain': ['Paste as Plain Text', '粘贴为纯文本'],
}

const menuKey = (name: string) => name.split('\u001b').filter(Boolean).at(-1)?.trim().replace(/(?:…|\.\.\.)$/, '').trim().toLowerCase()
const shortcutByMenu = new Map(SHORTCUT_DEFINITIONS.flatMap(({ id, label }) =>
  [label, id, ...(shortcutNames[id] ?? [])].map(name => [menuKey(name), id] as const)))

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function parseProfile(profile: TyporaProfile) {
  // Typora 的高级设置允许注释。保留 URL 和字符串中的斜线、引号与逗号。
  const json = profile.text.replace(/^\uFEFF/, '')
    .replace(/"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, part => part.startsWith('/') ? '' : part)
    .replace(/"(?:[^"\\]|\\.)*"|,\s*(?=[}\]])/g, part => part.startsWith(',') ? '' : part)
  try {
    const decoded: unknown = JSON.parse(json)
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error()
    return record(decoded)
  } catch {
    throw new Error('无法解析设置文件 ' + profile.name)
  }
}

function shortcutCombo(value: string, mac: boolean) {
  if (value === '') return ''
  if (!mac) return !value.endsWith('+') ? normalizeCombo(value.replace(/\b(?:Ctrl|CmdOrCtrl)\+/gi, 'Mod+')) : ''
  const symbols = /^([@^~$]*)(.)$/us.exec(value)
  if (!symbols) return ''
  const [, flags, rawKey] = symbols
  const code = rawKey.codePointAt(0)!
  const functionKey = code >= 0xf704 && code <= 0xf70f ? 'F' + (code - 0xf703) : undefined
  const special: Record<string, string> = { '\r': 'Enter', '\u001b': 'Escape', '\u007f': 'Backspace', ' ': 'Space',
    '\uf700': 'ArrowUp', '\uf701': 'ArrowDown', '\uf702': 'ArrowLeft', '\uf703': 'ArrowRight' }
  const key = functionKey ?? special[rawKey] ?? rawKey
  if (key === '+' || (code >= 0xf000 && !functionKey && !special[rawKey])) return ''
  const modifiers = [flags.includes('@') && 'Mod', flags.includes('^') && 'Ctrl', flags.includes('~') && 'Alt',
    (flags.includes('$') || /^[A-Z]$/.test(rawKey)) && 'Shift']
  return normalizeCombo([...modifiers.filter(Boolean), key].join('+'))
}

function uploadEndpoint(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const url = new URL(value.trim())
    const local = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
    if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) return undefined
    return url.href
  } catch { return undefined }
}

export function typoraThemeKey(name: string) {
  return name.normalize('NFKC').trim().replace(/\.css$/i, '').replace(/[\s_-]+/g, '').toLowerCase()
}

export function readTyporaProfiles(profiles: TyporaProfile[], systemDark: boolean) {
  let values: Record<string, unknown> = {}
  const shortcuts: Record<string, string> = {}
  let unsupportedShortcuts = 0
  for (const profile of profiles) {
    const data = parseProfile(profile)
    values = { ...values, ...data }
    for (const [field, mac] of [['keyBinding', false], ['NSUserKeyEquivalents', true]] as const) {
      for (const [label, value] of Object.entries(record(data[field]))) {
        const command = shortcutByMenu.get(menuKey(label))
        const combo = typeof value === 'string' ? shortcutCombo(value, mac) : ''
        if (command && (combo || value === '')) shortcuts[command] = combo
        else unsupportedShortcuts++
      }
    }
  }
  const prefersDark = values.useDarkTheme === true || (values.schemeAwareness === true && systemDark)
  const theme = prefersDark && typeof values.darkTheme === 'string' ? values.darkTheme : values.theme
  const provider = values.image_uploader ?? values.imageUploader
  const picgo = typeof provider === 'string' && /^(picgo-app|piclist-app)$/i.test(provider.trim())
  const customEndpoint = uploadEndpoint(values.uploadEndpoint ?? values.imageUploadUrl)
  const upload = picgo
    ? { service: 'picgo' as const, endpoint: 'http://127.0.0.1:36677/upload' }
    : customEndpoint ? { service: 'multipart' as const, endpoint: customEndpoint } : undefined
  const rawTab = values.sidebar_tab
  const sidebar: SidebarTab | undefined = rawTab === 'outline' || rawTab === 'search' ? rawTab
    : rawTab === 'files' || rawTab === 'file' ? 'files' : undefined
  const bool = (value: unknown) => typeof value === 'boolean' ? value : undefined
  const interval = values.autoSaveTimer
  return {
    theme: typeof theme === 'string' ? theme.trim() : undefined,
    upload, unsupportedUpload: Boolean(provider && !upload), shortcuts, unsupportedShortcuts, sidebar,
    autosave: bool(values.enableAutoSave),
    autosaveDelay: typeof interval === 'number' && interval > 0 && interval <= 1440 ? Math.round(interval * 60_000) : undefined,
    spellcheck: bool(values.spellcheck) ?? (typeof values.ignoreSpell === 'boolean' ? !values.ignoreSpell : undefined),
    matchCase: bool(values.caseSensitive), wholeWord: bool(values.wholeWord),
  }
}
