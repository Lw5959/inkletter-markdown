export type ShortcutCategory = '文件' | '导航与检索' | '视图与侧栏' | '格式与编辑' | '设置'

export type ShortcutCommandId =
  | 'file.new'
  | 'file.open'
  | 'file.openFolder'
  | 'file.save'
  | 'file.saveAs'
  | 'file.print'
  | 'file.exportAgain'
  | 'nav.quickOpen'
  | 'nav.find'
  | 'nav.replace'
  | 'nav.searchWorkspace'
  | 'view.toggleMode'
  | 'view.toggleSidebar'
  | 'view.toggleOutline'
  | 'view.toggleAI'
  | 'view.toggleMcp'
  | 'view.toggleFocus'
  | 'view.toggleTypewriter'
  | 'view.toggleReadonly'
  | 'format.bold'
  | 'format.italic'
  | 'format.underline'
  | 'format.strike'
  | 'format.inlineCode'
  | 'format.link'
  | 'format.heading1'
  | 'format.heading2'
  | 'format.heading3'
  | 'format.quote'
  | 'format.codeBlock'
  | 'edit.pastePlain'
  | 'settings.shortcuts'

export interface ShortcutDefinition {
  id: ShortcutCommandId
  label: string
  category: ShortcutCategory
  defaultCombo: string
  /** If true, only fires when focus is not inside a shell form field (input/textarea/select). */
  editorOnly?: boolean
}

export const SHORTCUT_STORAGE_KEY = 'yeyu.shortcuts.v1'

export const SHORTCUT_DEFINITIONS: readonly ShortcutDefinition[] = [
  { id: 'file.new', label: '新建文档', category: '文件', defaultCombo: 'Mod+N' },
  { id: 'file.open', label: '打开文件', category: '文件', defaultCombo: 'Mod+O' },
  { id: 'file.openFolder', label: '打开文件夹', category: '文件', defaultCombo: 'Mod+Shift+O' },
  { id: 'file.save', label: '保存', category: '文件', defaultCombo: 'Mod+S' },
  { id: 'file.saveAs', label: '另存为', category: '文件', defaultCombo: 'Mod+Shift+S' },
  { id: 'file.exportAgain', label: '再次导出', category: '文件', defaultCombo: 'Mod+Shift+E' },
  { id: 'file.print', label: '打印', category: '文件', defaultCombo: 'Mod+Alt+P' },

  { id: 'nav.quickOpen', label: '快速打开文件', category: '导航与检索', defaultCombo: 'Mod+P' },
  { id: 'nav.find', label: '文内查找', category: '导航与检索', defaultCombo: 'Mod+F' },
  { id: 'nav.replace', label: '文内替换', category: '导航与检索', defaultCombo: 'Mod+H' },
  { id: 'nav.searchWorkspace', label: '跨文件检索', category: '导航与检索', defaultCombo: 'Mod+Shift+F' },

  { id: 'view.toggleMode', label: '切换实时 / 源码模式', category: '视图与侧栏', defaultCombo: 'Mod+/' },
  { id: 'view.toggleSidebar', label: '显示 / 隐藏左侧栏', category: '视图与侧栏', defaultCombo: 'Mod+Shift+L' },
  { id: 'view.toggleOutline', label: '打开大纲面板', category: '视图与侧栏', defaultCombo: 'Mod+Shift+1' },
  { id: 'view.toggleAI', label: '显示 / 隐藏 AI 侧栏', category: '视图与侧栏', defaultCombo: 'Mod+Shift+A' },
  { id: 'view.toggleMcp', label: '显示 / 隐藏 MCP 侧栏', category: '视图与侧栏', defaultCombo: 'Mod+Shift+M' },
  { id: 'view.toggleFocus', label: '切换专注模式', category: '视图与侧栏', defaultCombo: 'F8' },
  { id: 'view.toggleTypewriter', label: '切换打字机模式', category: '视图与侧栏', defaultCombo: 'F9' },
  { id: 'view.toggleReadonly', label: '切换只读模式', category: '视图与侧栏', defaultCombo: 'Mod+Shift+R' },

  { id: 'format.bold', label: '加粗', category: '格式与编辑', defaultCombo: 'Mod+B', editorOnly: true },
  { id: 'format.italic', label: '斜体', category: '格式与编辑', defaultCombo: 'Mod+I', editorOnly: true },
  { id: 'format.underline', label: '下划线', category: '格式与编辑', defaultCombo: 'Mod+U', editorOnly: true },
  { id: 'format.strike', label: '删除线', category: '格式与编辑', defaultCombo: 'Mod+Shift+X', editorOnly: true },
  { id: 'format.inlineCode', label: '行内代码', category: '格式与编辑', defaultCombo: 'Mod+E', editorOnly: true },
  { id: 'format.link', label: '插入链接', category: '格式与编辑', defaultCombo: 'Mod+K', editorOnly: true },
  { id: 'format.heading1', label: '一级标题', category: '格式与编辑', defaultCombo: 'Mod+1', editorOnly: true },
  { id: 'format.heading2', label: '二级标题', category: '格式与编辑', defaultCombo: 'Mod+2', editorOnly: true },
  { id: 'format.heading3', label: '三级标题', category: '格式与编辑', defaultCombo: 'Mod+3', editorOnly: true },
  { id: 'format.quote', label: '引用块', category: '格式与编辑', defaultCombo: 'Mod+Shift+Q', editorOnly: true },
  { id: 'format.codeBlock', label: '代码块', category: '格式与编辑', defaultCombo: 'Mod+Alt+C', editorOnly: true },
  { id: 'edit.pastePlain', label: '粘贴为纯文本', category: '格式与编辑', defaultCombo: 'Mod+Shift+V', editorOnly: true },

  { id: 'settings.shortcuts', label: '快捷键设置', category: '设置', defaultCombo: 'Mod+,' },
]

export interface ParsedCombo {
  mod: boolean
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
  key: string
}

export function detectMac(): boolean {
  if (typeof navigator === 'undefined') return false
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '')
}

function normalizeKeyName(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const lower = trimmed.toLowerCase()
  if (lower === ' ' || lower === 'spacebar' || lower === 'space') return 'Space'
  if (lower === 'esc' || lower === 'escape') return 'Escape'
  if (lower === 'return' || lower === 'enter') return 'Enter'
  if (lower === 'arrowup' || lower === 'up') return 'ArrowUp'
  if (lower === 'arrowdown' || lower === 'down') return 'ArrowDown'
  if (lower === 'arrowleft' || lower === 'left') return 'ArrowLeft'
  if (lower === 'arrowright' || lower === 'right') return 'ArrowRight'
  if (lower === 'backspace') return 'Backspace'
  if (lower === 'delete' || lower === 'del') return 'Delete'
  if (/^f([1-9]|1[0-2])$/i.test(trimmed)) return trimmed.toUpperCase()
  if (trimmed.length === 1) return trimmed.toUpperCase()
  return trimmed
}

export function parseCombo(combo: string): ParsedCombo | null {
  const trimmed = combo.trim()
  if (!trimmed) return null
  const tokens = trimmed.split('+').map(t => t.trim()).filter(Boolean)
  if (!tokens.length) return null
  const parsed: ParsedCombo = { mod: false, ctrl: false, meta: false, alt: false, shift: false, key: '' }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const lower = token.toLowerCase()
    const isLast = i === tokens.length - 1
    if (!isLast && (lower === 'mod' || lower === 'cmdorctrl')) {
      parsed.mod = true
    } else if (!isLast && (lower === 'ctrl' || lower === 'control')) {
      parsed.ctrl = true
    } else if (!isLast && (lower === 'meta' || lower === 'cmd' || lower === 'command')) {
      parsed.meta = true
    } else if (!isLast && (lower === 'alt' || lower === 'option')) {
      parsed.alt = true
    } else if (!isLast && lower === 'shift') {
      parsed.shift = true
    } else if (isLast) {
      if (['control', 'ctrl', 'meta', 'cmd', 'command', 'alt', 'option', 'shift', 'mod'].includes(lower)) {
        return null
      }
      parsed.key = normalizeKeyName(token)
    } else {
      return null
    }
  }
  return parsed.key ? parsed : null
}

export function serializeCombo(parsed: ParsedCombo): string {
  const parts: string[] = []
  if (parsed.mod) parts.push('Mod')
  if (parsed.ctrl) parts.push('Ctrl')
  if (parsed.meta) parts.push('Meta')
  if (parsed.alt) parts.push('Alt')
  if (parsed.shift) parts.push('Shift')
  parts.push(parsed.key)
  return parts.join('+')
}

export function normalizeCombo(combo: string): string {
  const parsed = parseCombo(combo)
  return parsed ? serializeCombo(parsed) : ''
}

export interface KeyEventLike {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
  keyCode?: number
}

function keyFromEvent(event: KeyEventLike): string {
  // Handle macOS Option/Shift producing alternate characters for digits/letters via code fallback
  if (event.code) {
    const digit = /^Digit([0-9])$/.exec(event.code)
    if (digit && (event.altKey || event.shiftKey)) return digit[1]
    const letter = /^Key([A-Z])$/.exec(event.code)
    if (letter && event.altKey) return letter[1]
    if (event.code === 'Slash') return '/'
    if (event.code === 'Comma') return ','
    if (event.code === 'Period') return '.'
    if (event.code === 'Backslash') return '\\'
  }
  return normalizeKeyName(event.key)
}

export function eventToCombo(event: KeyEventLike, isMac = detectMac()): string | null {
  if (event.isComposing || event.keyCode === 229) return null
  const ignored = new Set(['Shift', 'Control', 'Alt', 'Meta', 'OS', 'Dead', 'Process', 'Unidentified'])
  if (ignored.has(event.key)) return null
  const key = keyFromEvent(event)
  if (!key) return null

  const primaryMod = isMac ? event.metaKey : event.ctrlKey
  const secondaryCtrl = isMac ? event.ctrlKey : false
  const secondaryMeta = isMac ? false : event.metaKey

  const isFunctionKey = /^F([1-9]|1[0-2])$/.test(key)
  if (!primaryMod && !secondaryCtrl && !secondaryMeta && !event.altKey && !isFunctionKey) {
    return null
  }
  return serializeCombo({
    mod: primaryMod,
    ctrl: secondaryCtrl,
    meta: secondaryMeta,
    alt: event.altKey,
    shift: event.shiftKey,
    key,
  })
}

export function matchCombo(event: KeyEventLike, combo: string, isMac = detectMac()): boolean {
  if (event.isComposing || event.keyCode === 229) return false
  const parsed = parseCombo(combo)
  if (!parsed) return false

  const expectCtrl = parsed.ctrl || (!isMac && parsed.mod)
  const expectMeta = parsed.meta || (isMac && parsed.mod)
  if (event.ctrlKey !== expectCtrl) return false
  if (event.metaKey !== expectMeta) return false
  if (event.altKey !== parsed.alt) return false
  if (event.shiftKey !== parsed.shift) return false

  const eventKey = keyFromEvent(event)
  return eventKey === parsed.key
}

export function formatComboLabel(combo: string, isMac = detectMac()): string {
  const parsed = parseCombo(combo)
  if (!parsed) return ''
  const parts: string[] = []
  if (isMac) {
    if (parsed.ctrl) parts.push('⌃')
    if (parsed.alt) parts.push('⌥')
    if (parsed.shift) parts.push('⇧')
    if (parsed.mod || parsed.meta) parts.push('⌘')
    parts.push(parsed.key)
    return parts.join('')
  }
  if (parsed.mod || parsed.ctrl) parts.push('Ctrl')
  if (parsed.meta) parts.push('Meta')
  if (parsed.alt) parts.push('Alt')
  if (parsed.shift) parts.push('Shift')
  parts.push(parsed.key)
  return parts.join('+')
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function getDefaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

export class ShortcutRegistry {
  private bindings = new Map<ShortcutCommandId, string>()
  private storage: StorageLike | null
  private listeners = new Set<() => void>()

  constructor(storage: StorageLike | null = getDefaultStorage()) {
    this.storage = storage
    this.resetDefaults(false)
    this.load()
  }

  private load() {
    if (!this.storage) return
    try {
      const raw = this.storage.getItem(SHORTCUT_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (!parsed || typeof parsed !== 'object') return
      for (const def of SHORTCUT_DEFINITIONS) {
        const value = parsed[def.id]
        if (typeof value === 'string') {
          if (value === '') {
            this.bindings.set(def.id, '')
          } else {
            const normalized = normalizeCombo(value)
            if (normalized) this.bindings.set(def.id, normalized)
          }
        }
      }
    } catch {
      // Ignore malformed storage entries
    }
  }

  private persist() {
    if (!this.storage) return
    try {
      const overrides: Record<string, string> = {}
      for (const def of SHORTCUT_DEFINITIONS) {
        const current = this.bindings.get(def.id) ?? def.defaultCombo
        if (current !== def.defaultCombo) {
          overrides[def.id] = current
        }
      }
      if (Object.keys(overrides).length === 0) {
        this.storage.removeItem(SHORTCUT_STORAGE_KEY)
      } else {
        this.storage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(overrides))
      }
    } catch {
      // Ignore quota / security errors
    }
  }

  private notify() {
    for (const listener of this.listeners) listener()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get(id: ShortcutCommandId): string {
    return this.bindings.get(id) ?? ''
  }

  getLabel(id: ShortcutCommandId, isMac = detectMac()): string {
    return formatComboLabel(this.get(id), isMac)
  }

  set(id: ShortcutCommandId, combo: string): { ok: boolean; conflict?: ShortcutDefinition } {
    const trimmed = combo.trim()
    if (trimmed === '') {
      this.bindings.set(id, '')
      this.persist()
      this.notify()
      return { ok: true }
    }
    const normalized = normalizeCombo(trimmed)
    if (!normalized) return { ok: false }
    const conflict = this.findConflict(id, normalized)
    this.bindings.set(id, normalized)
    this.persist()
    this.notify()
    return { ok: true, conflict }
  }

  findConflict(id: ShortcutCommandId, combo: string): ShortcutDefinition | undefined {
    const normalized = normalizeCombo(combo)
    if (!normalized) return undefined
    return SHORTCUT_DEFINITIONS.find(def => def.id !== id && this.get(def.id) === normalized)
  }

  importBindings(bindings: Readonly<Record<string, string>>, isMac: boolean) {
    const keys = (combo: string) => {
      const parsed = parseCombo(combo)
      if (!parsed) return ''
      if (parsed.mod) {
        parsed.mod = false
        if (isMac) parsed.meta = true
        else parsed.ctrl = true
      }
      return serializeCombo(parsed)
    }
    const pending = new Map<ShortcutCommandId, string>()
    for (const { id } of SHORTCUT_DEFINITIONS) {
      const combo = bindings[id]
      if (typeof combo === 'string') pending.set(id, combo)
    }
    const requested = pending.size
    // 先看整批导入后的键位以允许互换。冲突项回到原键位后再检查剩余条目。
    for (;;) {
      const conflicts = [...pending].filter(([id, combo]) => combo && SHORTCUT_DEFINITIONS.some(other =>
        other.id !== id && keys(pending.get(other.id) ?? this.get(other.id)) === keys(combo)))
      if (!conflicts.length) break
      for (const [id] of conflicts) pending.delete(id)
    }
    for (const [id, combo] of pending) this.bindings.set(id, combo)
    if (pending.size) {
      this.persist()
      this.notify()
    }
    return { applied: pending.size, conflicts: requested - pending.size }
  }

  resetOne(id: ShortcutCommandId) {
    const def = SHORTCUT_DEFINITIONS.find(item => item.id === id)
    if (!def) return
    this.bindings.set(id, def.defaultCombo)
    this.persist()
    this.notify()
  }

  resetDefaults(save = true) {
    for (const def of SHORTCUT_DEFINITIONS) {
      this.bindings.set(def.id, def.defaultCombo)
    }
    if (save) {
      this.persist()
      this.notify()
    }
  }

  match(event: KeyEventLike, inFormField: boolean, isMac = detectMac()): ShortcutDefinition | null {
    for (const def of SHORTCUT_DEFINITIONS) {
      const combo = this.get(def.id)
      if (!combo) continue
      if (def.editorOnly && inFormField) continue
      if (matchCombo(event, combo, isMac)) return def
    }
    return null
  }
}
