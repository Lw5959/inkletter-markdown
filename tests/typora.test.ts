import { describe, expect, it } from 'vitest'
import { readTyporaProfiles, typoraThemeKey } from '../src/typora'
import { ShortcutRegistry } from '../src/ui/shortcuts'

describe('Typora 配置迁移', () => {
  it('读取属性列表转换结果和带注释的高级设置，保留地址及有效键位', () => {
    const imported = readTyporaProfiles([
      { name: 'abnerworks.Typora.plist', text: JSON.stringify({ theme: 'Vue', darkTheme: 'Night', schemeAwareness: true,
        image_uploader: 'picgo-app', sidebar_tab: 'outline', caseSensitive: true, wholeWord: false,
        NSUserKeyEquivalents: { '\u001bFile\u001bSave': '@$s', '打开…': '@o', '始终置顶': '@t' } }) },
      { name: 'conf.user.json', text: '\uFEFF{ // 兼容 Typora 的高级设置\n"keyBinding": {"Print":"Ctrl+Alt+P",}, "autoSaveTimer": 2.5, "enableAutoSave": true, "ignoreSpell": true, }' },
    ], true)
    expect(imported).toMatchObject({ theme: 'Night', sidebar: 'outline', matchCase: true, wholeWord: false, autosave: true,
      autosaveDelay: 150_000, spellcheck: false, unsupportedShortcuts: 1, upload: { service: 'picgo', endpoint: 'http://127.0.0.1:36677/upload' },
      shortcuts: { 'file.save': 'Mod+Shift+S', 'file.open': 'Mod+O', 'file.print': 'Mod+Alt+P' } })
    expect(typoraThemeKey('Vue Dark')).toBe(typoraThemeKey('vue-dark.css'))
  })

  it('保留普通 HTTP 上传接口，识别无法迁移的图床工具', () => {
    const read = (values: unknown) => readTyporaProfiles([{ name: 'settings.json', text: JSON.stringify(values) }], false)
    expect(read({ uploadEndpoint: 'https://upload.example.test/images?url=https://example.test' }).upload)
      .toEqual({ service: 'multipart', endpoint: 'https://upload.example.test/images?url=https://example.test' })
    expect(read({ image_uploader: 'ipic', uploadEndpoint: 'http://127.example.test/upload' }))
      .toMatchObject({ unsupportedUpload: true, upload: undefined })
    expect(() => readTyporaProfiles([{ name: 'conf.user.json', text: '{"broken":' }], false)).toThrow('无法解析设置文件')
  })

  it('整批应用快捷键互换并保留产生冲突的现有键位', () => {
    const shortcuts = new ShortcutRegistry(null)
    expect(shortcuts.importBindings({ 'file.open': 'Mod+S', 'file.save': 'Mod+O', 'file.print': 'Meta+P' }, true))
      .toEqual({ applied: 2, conflicts: 1 })
    expect(shortcuts.get('file.open')).toBe('Mod+S')
    expect(shortcuts.get('file.save')).toBe('Mod+O')
    expect(shortcuts.get('file.print')).toBe('Mod+Alt+P')
  })
})
