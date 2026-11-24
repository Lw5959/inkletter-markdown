import type { DiffPart, Suggestion, WorkspaceEntry } from '../contracts'

export interface FlatFileEntry {
  path: string
  name: string
  relative: string
}

export function flattenWorkspaceFiles(entries: WorkspaceEntry[], workspaceRoot?: string | null): FlatFileEntry[] {
  const out: FlatFileEntry[] = []
  const normalizedRoot = workspaceRoot ? workspaceRoot.replace(/[\\/]+$/, '') : ''
  const walk = (list: WorkspaceEntry[], prefix: string) => {
    for (const entry of list) {
      if (Array.isArray(entry.children)) {
        walk(entry.children, prefix ? `${prefix}/${entry.name}` : entry.name)
      } else {
        let relative = prefix ? `${prefix}/${entry.name}` : entry.name
        if (normalizedRoot && entry.path.startsWith(normalizedRoot)) {
          const sliced = entry.path.slice(normalizedRoot.length).replace(/^[\\/]+/, '')
          if (sliced) relative = sliced
        }
        out.push({ path: entry.path, name: entry.name, relative })
      }
    }
  }
  walk(entries, '')
  return out
}

export function filterWorkspaceFiles(files: FlatFileEntry[], query: string): FlatFileEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return files
  const scored: { file: FlatFileEntry; score: number }[] = []
  for (const file of files) {
    const nameLower = file.name.toLowerCase()
    const relLower = file.relative.toLowerCase()
    let score = -1
    if (nameLower === needle) score = 100
    else if (nameLower.startsWith(needle)) score = 80
    else if (nameLower.includes(needle)) score = 60
    else if (relLower.includes(needle)) score = 40
    else {
      // Subsequence fuzzy match
      let pos = 0
      for (const ch of needle) {
        const idx = relLower.indexOf(ch, pos)
        if (idx === -1) {
          pos = -1
          break
        }
        pos = idx + 1
      }
      if (pos !== -1) score = 20
    }
    if (score > 0) scored.push({ file, score })
  }
  scored.sort((a, b) => b.score - a.score || a.file.relative.localeCompare(b.file.relative, 'zh-CN'))
  return scored.map(item => item.file)
}

export interface DiffBlock {
  kind: 'context' | 'hunk'
  hunkId?: number
  parts: DiffPart[]
}

export function groupDiffParts(suggestion: Suggestion): { blocks: DiffBlock[]; hunkIds: number[] } {
  const blocks: DiffBlock[] = []
  const hunkIdSet = new Set<number>()
  let fallbackHunk = 0

  for (const part of suggestion.parts) {
    if (part.kind === 'keep') {
      const prev = blocks[blocks.length - 1]
      if (prev && prev.kind === 'context') {
        prev.parts.push(part)
      } else {
        blocks.push({ kind: 'context', parts: [part] })
      }
      continue
    }
    const prev = blocks[blocks.length - 1]
    const hunkId = typeof part.hunk === 'number'
      ? part.hunk
      : (prev && prev.kind === 'hunk' && typeof prev.hunkId === 'number' ? prev.hunkId : fallbackHunk++)
    hunkIdSet.add(hunkId)
    if (prev && prev.kind === 'hunk' && prev.hunkId === hunkId) {
      prev.parts.push(part)
    } else {
      blocks.push({ kind: 'hunk', hunkId, parts: [part] })
    }
  }

  let hunkIds = Array.from(hunkIdSet).sort((a, b) => a - b)
  if (hunkIds.length === 0 && suggestion.hunks > 0) {
    hunkIds = Array.from({ length: suggestion.hunks }, (_, index) => index)
  }
  return { blocks, hunkIds }
}

/** Parse CLI argument string supporting single/double quotes and escaped spaces. */
export function parseCommandArgs(raw: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasToken = false

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < raw.length) {
        current += raw[++i]
      } else if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasToken = true
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        args.push(current)
        current = ''
        hasToken = false
      }
    } else if (ch === '\\' && i + 1 < raw.length) {
      current += raw[++i]
      hasToken = true
    } else {
      current += ch
      hasToken = true
    }
  }
  if (hasToken) args.push(current)
  return args
}

export function formatCommandArgs(args?: string[]): string {
  if (!args || args.length === 0) return ''
  return args.map(arg => (/\s|["']/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')
}

export function buildSchemaStarterArgs(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return {}
  const record = schema as Record<string, unknown>
  const props = record.properties
  if (!props || typeof props !== 'object') return {}
  const starter: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') {
      starter[key] = ''
      continue
    }
    const def = value as Record<string, unknown>
    if ('default' in def) {
      starter[key] = def.default
    } else if (Array.isArray(def.enum) && def.enum.length > 0) {
      starter[key] = def.enum[0]
    } else if (def.type === 'number' || def.type === 'integer') {
      starter[key] = 0
    } else if (def.type === 'boolean') {
      starter[key] = false
    } else if (def.type === 'array') {
      starter[key] = []
    } else if (def.type === 'object') {
      starter[key] = {}
    } else {
      starter[key] = ''
    }
  }
  return starter
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fallback below
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    area.style.pointerEvents = 'none'
    document.body.append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options?: {
    className?: string
    text?: string
    html?: string
    attrs?: Record<string, string>
    title?: string
    type?: string
  },
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (options?.className) node.className = options.className
  if (options?.text !== undefined) node.textContent = options.text
  if (options?.html !== undefined) node.innerHTML = options.html
  if (options?.title) node.title = options.title
  if (options?.type && 'type' in node) {
    ;(node as HTMLButtonElement | HTMLInputElement).type = options.type
  }
  if (options?.attrs) {
    for (const [k, v] of Object.entries(options.attrs)) {
      node.setAttribute(k, v)
    }
  }
  for (const child of children) node.append(child)
  return node
}

export function isEditableFormElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('#write')) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}
