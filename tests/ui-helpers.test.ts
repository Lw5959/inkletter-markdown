import { describe, expect, it } from 'vitest'
import {
  SHORTCUT_STORAGE_KEY,
  ShortcutRegistry,
  eventToCombo,
  formatComboLabel,
  matchCombo,
  parseCombo,
  type StorageLike,
} from '../src/ui/shortcuts'
import {
  buildSchemaStarterArgs,
  filterWorkspaceFiles,
  flattenWorkspaceFiles,
  formatCommandArgs,
  groupDiffParts,
  parseCommandArgs,
} from '../src/ui/helpers'

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>()
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
    removeItem: key => { map.delete(key) },
  }
}

describe('快捷键与本地配置', () => {
  it('正确解析与格式化跨平台快捷键', () => {
    expect(parseCombo('Mod+Shift+S')).toEqual({
      mod: true,
      ctrl: false,
      meta: false,
      alt: false,
      shift: true,
      key: 'S',
    })
    expect(formatComboLabel('Mod+Shift+S', true)).toBe('⇧⌘S')
    expect(formatComboLabel('Mod+Shift+S', false)).toBe('Ctrl+Shift+S')
    expect(formatComboLabel('F8', true)).toBe('F8')
  })

  it('匹配按键时忽略输入法组合并区分表单上下文', () => {
    const registry = new ShortcutRegistry(createMemoryStorage())
    const saveMac = { key: 's', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }
    const boldMac = { key: 'b', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }
    const composing = { ...saveMac, isComposing: true }

    expect(matchCombo(saveMac, 'Mod+S', true)).toBe(true)
    expect(matchCombo(saveMac, 'Mod+S', false)).toBe(false)
    expect(matchCombo(composing, 'Mod+S', true)).toBe(false)

    expect(registry.match(saveMac, true, true)?.id).toBe('file.save')
    expect(registry.match(boldMac, true, true)).toBeNull()
    expect(registry.match(boldMac, false, true)?.id).toBe('format.bold')
  })

  it('支持录制、冲突检测与 localStorage 持久化恢复', () => {
    const storage = createMemoryStorage()
    const registry = new ShortcutRegistry(storage)

    const combo = eventToCombo({
      key: 'j',
      code: 'KeyJ',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    }, true)
    expect(combo).toBe('Mod+Shift+J')

    const res = registry.set('nav.quickOpen', combo!)
    expect(res.ok).toBe(true)
    expect(res.conflict).toBeUndefined()
    expect(storage.getItem(SHORTCUT_STORAGE_KEY)).toContain('Mod+Shift+J')

    const conflictRes = registry.set('file.new', 'Mod+S')
    expect(conflictRes.ok).toBe(true)
    expect(conflictRes.conflict?.id).toBe('file.save')

    const reloaded = new ShortcutRegistry(storage)
    expect(reloaded.get('nav.quickOpen')).toBe('Mod+Shift+J')
    expect(reloaded.get('file.new')).toBe('Mod+S')

    reloaded.resetDefaults(true)
    expect(reloaded.get('nav.quickOpen')).toBe('Mod+P')
    expect(storage.getItem(SHORTCUT_STORAGE_KEY)).toBeNull()
  })
})

describe('界面辅助工具', () => {
  it('扁平化并模糊筛选工作区文件树', () => {
    const files = flattenWorkspaceFiles([
      {
        path: '/ws/docs',
        name: 'docs',
        children: [
          { path: '/ws/docs/guide.md', name: 'guide.md' },
          { path: '/ws/docs/中文笔记.md', name: '中文笔记.md' },
        ],
      },
      { path: '/ws/README.md', name: 'README.md' },
    ], '/ws')

    expect(files.map(f => f.relative)).toEqual(['docs/guide.md', 'docs/中文笔记.md', 'README.md'])
    expect(filterWorkspaceFiles(files, '笔记').map(f => f.name)).toEqual(['中文笔记.md'])
    expect(filterWorkspaceFiles(files, 'dgm').map(f => f.name)).toEqual(['guide.md'])
  })

  it('按 hunk 分组差异建议以支持全部与逐段应用', () => {
    const grouped = groupDiffParts({
      id: 's1',
      title: '润色两处段落',
      source: 'ai',
      hunks: 2,
      parts: [
        { kind: 'keep', text: '# 标题\n' },
        { kind: 'remove', text: '旧第一段', hunk: 0 },
        { kind: 'add', text: '新第一段', hunk: 0 },
        { kind: 'keep', text: '\n中间内容\n' },
        { kind: 'remove', text: '旧第二段', hunk: 1 },
        { kind: 'add', text: '新第二段', hunk: 1 },
      ],
    })
    expect(grouped.hunkIds).toEqual([0, 1])
    expect(grouped.blocks.map(b => b.kind)).toEqual(['context', 'hunk', 'context', 'hunk'])
  })

  it('解析并还原 MCP stdio 参数及 JSON Schema 初始参数', () => {
    const parsed = parseCommandArgs('-y "@scope/mcp server" --dir \'./my docs\'')
    expect(parsed).toEqual(['-y', '@scope/mcp server', '--dir', './my docs'])
    expect(formatCommandArgs(parsed)).toBe('-y "@scope/mcp server" --dir "./my docs"')

    const starter = buildSchemaStarterArgs({
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', default: 5 },
        mode: { enum: ['fast', 'deep'] },
        recursive: { type: 'boolean' },
      },
    })
    expect(starter).toEqual({ query: '', limit: 5, mode: 'fast', recursive: false })
  })
})
