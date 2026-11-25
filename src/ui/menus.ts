import type {
  EditorFormat,
  ExportFormat,
  ImageMode,
  ShellAction,
  ShellState,
  Theme,
  TitlebarView,
} from '../contracts'
import { el } from './helpers'
import { icons } from './icons'
import { detectMac, type ShortcutCommandId, type ShortcutRegistry } from './shortcuts'

export const EXPORT_OPTIONS: readonly { format: ExportFormat; label: string; group: string }[] = [
  { format: 'html', label: 'HTML（含主题样式）', group: '常用' },
  { format: 'plain-html', label: '纯 HTML（无样式）', group: '常用' },
  { format: 'pdf', label: 'PDF 文档', group: '常用' },
  { format: 'png', label: '长图 PNG', group: '常用' },
  { format: 'docx', label: 'Word (.docx)', group: '办公与出版' },
  { format: 'epub', label: '电子书 (.epub)', group: '办公与出版' },
  { format: 'odt', label: 'OpenDocument (.odt)', group: '办公与出版' },
  { format: 'rtf', label: '富文本 (.rtf)', group: '办公与出版' },
  { format: 'latex', label: 'LaTeX (.tex)', group: '标记与演示' },
  { format: 'rst', label: 'reStructuredText (.rst)', group: '标记与演示' },
  { format: 'textile', label: 'Textile', group: '标记与演示' },
  { format: 'opml', label: 'OPML 大纲', group: '标记与演示' },
  { format: 'revealjs', label: 'Reveal.js 演示稿', group: '标记与演示' },
  { format: 'json', label: 'Pandoc JSON', group: '标记与演示' },
  { format: 'commonmark', label: 'CommonMark', group: '标记与演示' },
]

export const IMAGE_MODES: readonly { mode: ImageMode; label: string }[] = [
  { mode: 'copy', label: '复制到文档资源目录' },
  { mode: 'move', label: '移动到文档资源目录' },
  { mode: 'upload', label: '按配置上传图片' },
]

type MenuEntry =
  | { kind: 'separator' }
  | { kind: 'heading'; label: string }
  | {
      kind: 'item'
      label: string
      shortcutId?: ShortcutCommandId
      checked?: boolean
      disabled?: boolean
      onSelect: () => void
    }
  | {
      kind: 'submenu'
      label: string
      items: MenuEntry[]
    }

export interface MenuBarContext {
  dispatch: (action: ShellAction) => void
  shortcuts: ShortcutRegistry
  getState: () => ShellState
  getThemes: () => { themes: Theme[]; active: string }
  getImageMode: () => ImageMode
  setImageMode: (mode: ImageMode) => void
  onOpenQuickOpen: () => void
  onOpenFind: (replace: boolean) => void
  onOpenWorkspaceSearch: () => void
  onOpenShortcuts: () => void
  onOpenPlugins: () => void
  getTitlebar: () => TitlebarView | null
  onToggleLeftSidebar: (tab?: 'files' | 'outline' | 'search') => void
  onToggleRightPanel: (tab?: 'ai' | 'mcp') => void
  isLeftOpen: () => boolean
  isRightOpen: () => boolean
  restoreEditorFocus: () => void
}

type TopMenuKey = 'file' | 'edit' | 'format' | 'view'

const TOP_MENUS: readonly { key: TopMenuKey; label: string }[] = [
  { key: 'file', label: '文件' },
  { key: 'edit', label: '编辑' },
  { key: 'format', label: '格式' },
  { key: 'view', label: '视图' },
]

export class MenuBar {
  readonly element: HTMLElement
  private triggers = new Map<TopMenuKey, HTMLButtonElement>()
  private dropdown: HTMLElement
  private openMenu: TopMenuKey | null = null
  private docPointerDown: (event: MouseEvent) => void
  private docKeyDown: (event: KeyboardEvent) => void
  private isMac = detectMac()

  constructor(private ctx: MenuBarContext) {
    this.element = el('div', {
      className: 'yy-menubar',
      attrs: { role: 'menubar', 'aria-label': '主菜单' },
    })

    for (const def of TOP_MENUS) {
      const btn = el('button', {
        className: 'yy-menu-trigger',
        type: 'button',
        text: def.label,
        attrs: {
          role: 'menuitem',
          'aria-haspopup': 'menu',
          'aria-expanded': 'false',
          'data-menu': def.key,
        },
      })
      btn.addEventListener('click', event => {
        event.stopPropagation()
        if (this.openMenu === def.key) {
          this.close(false)
        } else {
          this.open(def.key)
        }
      })
      btn.addEventListener('mouseenter', () => {
        if (this.openMenu && this.openMenu !== def.key) {
          this.open(def.key)
        }
      })
      btn.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          this.open(def.key, true)
        } else if (event.key === 'ArrowRight') {
          event.preventDefault()
          this.moveTopMenu(def.key, 1)
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault()
          this.moveTopMenu(def.key, -1)
        }
      })
      this.triggers.set(def.key, btn)
      this.element.append(btn)
    }

    this.dropdown = el('div', {
      className: 'yy-menu-popover',
      attrs: { role: 'menu', hidden: '' },
    })
    this.element.append(this.dropdown)

    this.docPointerDown = event => {
      if (!this.openMenu) return
      if (event.target instanceof Node && this.element.contains(event.target)) return
      this.close(false)
    }
    this.docKeyDown = event => {
      if (!this.openMenu) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        const key = this.openMenu
        this.close(false)
        this.triggers.get(key)?.focus()
      }
    }
    document.addEventListener('mousedown', this.docPointerDown)
    window.addEventListener('keydown', this.docKeyDown, true)
  }

  private moveTopMenu(current: TopMenuKey, delta: number) {
    const idx = TOP_MENUS.findIndex(item => item.key === current)
    const next = TOP_MENUS[(idx + delta + TOP_MENUS.length) % TOP_MENUS.length]
    if (this.openMenu) {
      this.open(next.key, true)
    } else {
      this.triggers.get(next.key)?.focus()
    }
  }

  private buildEntries(key: TopMenuKey): MenuEntry[] {
    const state = this.ctx.getState()
    const { themes, active } = this.ctx.getThemes()
    const imageMode = this.ctx.getImageMode()
    const dispatchFormat = (format: EditorFormat) => this.ctx.dispatch({ type: 'format', format })
    const togglePres = (field: keyof ShellState['presentation']) => {
      const next = { ...state.presentation, [field]: !state.presentation[field] }
      this.ctx.dispatch({ type: 'presentation', value: next })
    }

    if (key === 'file') {
      return [
        { kind: 'item', label: '新建文档', shortcutId: 'file.new', onSelect: () => this.ctx.dispatch({ type: 'new' }) },
        { kind: 'item', label: '打开文件…', shortcutId: 'file.open', onSelect: () => this.ctx.dispatch({ type: 'open' }) },
        { kind: 'item', label: '打开文件夹…', shortcutId: 'file.openFolder', onSelect: () => this.ctx.dispatch({ type: 'open-folder' }) },
        { kind: 'item', label: '快速打开…', shortcutId: 'nav.quickOpen', onSelect: () => this.ctx.onOpenQuickOpen() },
        { kind: 'item', label: '重新打开最近关闭', onSelect: () => this.ctx.dispatch({ type: 'reopen' }) },
        { kind: 'separator' },
        { kind: 'item', label: '保存', shortcutId: 'file.save', onSelect: () => this.ctx.dispatch({ type: 'save' }) },
        { kind: 'item', label: '另存为…', shortcutId: 'file.saveAs', onSelect: () => this.ctx.dispatch({ type: 'save-as' }) },
        { kind: 'item', label: '重新载入磁盘版本', onSelect: () => this.ctx.dispatch({ type: 'reload' }) },
        {
          kind: 'item',
          label: '自动保存',
          checked: state.autosave,
          onSelect: () => this.ctx.dispatch({ type: 'autosave', enabled: !state.autosave }),
        },
        { kind: 'separator' },
        { kind: 'item', label: '导入其他格式文档…', onSelect: () => this.ctx.dispatch({ type: 'import' }) },
        {
          kind: 'submenu',
          label: '导出为',
          items: EXPORT_OPTIONS.map(opt => ({
            kind: 'item' as const,
            label: opt.label,
            onSelect: () => this.ctx.dispatch({ type: 'export', format: opt.format }),
          })),
        },
        {
          kind: 'item',
          label: '使用上次设置再次导出',
          shortcutId: 'file.exportAgain',
          onSelect: () => this.ctx.dispatch({ type: 'export-again' }),
        },
        { kind: 'separator' },
        { kind: 'item', label: '打印…', shortcutId: 'file.print', onSelect: () => this.ctx.dispatch({ type: 'print' }) },
      ]
    }

    if (key === 'edit') {
      return [
        { kind: 'item', label: '撤销', onSelect: () => this.ctx.dispatch({ type: 'undo' }) },
        { kind: 'item', label: '重做', onSelect: () => this.ctx.dispatch({ type: 'redo' }) },
        { kind: 'separator' },
        { kind: 'item', label: '复制为 Markdown', onSelect: () => this.ctx.dispatch({ type: 'copy-markdown' }) },
        { kind: 'item', label: '复制为 HTML', onSelect: () => this.ctx.dispatch({ type: 'copy-html' }) },
        { kind: 'item', label: '粘贴为纯文本', shortcutId: 'edit.pastePlain', onSelect: () => this.ctx.dispatch({ type: 'paste-plain' }) },
        { kind: 'separator' },
        { kind: 'item', label: '文内查找…', shortcutId: 'nav.find', onSelect: () => this.ctx.onOpenFind(false) },
        { kind: 'item', label: '文内查找与替换…', shortcutId: 'nav.replace', onSelect: () => this.ctx.onOpenFind(true) },
        { kind: 'item', label: '跨文件检索…', shortcutId: 'nav.searchWorkspace', onSelect: () => this.ctx.onOpenWorkspaceSearch() },
        { kind: 'separator' },
        { kind: 'item', label: '快捷键设置…', shortcutId: 'settings.shortcuts', onSelect: () => this.ctx.onOpenShortcuts() },
        { kind: 'item', label: '插件管理…', onSelect: () => this.ctx.onOpenPlugins() },
      ]
    }

    if (key === 'format') {
      return [
        { kind: 'heading', label: '行内样式' },
        { kind: 'item', label: '加粗', shortcutId: 'format.bold', onSelect: () => dispatchFormat('bold') },
        { kind: 'item', label: '斜体', shortcutId: 'format.italic', onSelect: () => dispatchFormat('italic') },
        { kind: 'item', label: '下划线', shortcutId: 'format.underline', onSelect: () => dispatchFormat('underline') },
        { kind: 'item', label: '高亮', onSelect: () => dispatchFormat('highlight') },
        { kind: 'item', label: '上标', onSelect: () => dispatchFormat('superscript') },
        { kind: 'item', label: '下标', onSelect: () => dispatchFormat('subscript') },
        { kind: 'item', label: '删除线', shortcutId: 'format.strike', onSelect: () => dispatchFormat('strike') },
        { kind: 'item', label: '行内代码', shortcutId: 'format.inlineCode', onSelect: () => dispatchFormat('inline-code') },
        { kind: 'item', label: '插入链接', shortcutId: 'format.link', onSelect: () => dispatchFormat('link') },
        { kind: 'item', label: '清除格式', onSelect: () => dispatchFormat('clear') },
        { kind: 'separator' },
        { kind: 'heading', label: '段落与块级结构' },
        { kind: 'item', label: '一级标题', shortcutId: 'format.heading1', onSelect: () => dispatchFormat('heading-1') },
        { kind: 'item', label: '二级标题', shortcutId: 'format.heading2', onSelect: () => dispatchFormat('heading-2') },
        { kind: 'item', label: '三级标题', shortcutId: 'format.heading3', onSelect: () => dispatchFormat('heading-3') },
        { kind: 'item', label: '引用块', shortcutId: 'format.quote', onSelect: () => dispatchFormat('quote') },
        { kind: 'item', label: '无序列表', onSelect: () => dispatchFormat('bullet-list') },
        { kind: 'item', label: '有序列表', onSelect: () => dispatchFormat('ordered-list') },
        { kind: 'item', label: '任务列表', onSelect: () => dispatchFormat('task') },
        { kind: 'item', label: '表格', onSelect: () => dispatchFormat('table') },
        { kind: 'item', label: '代码块', shortcutId: 'format.codeBlock', onSelect: () => dispatchFormat('code-block') },
        { kind: 'item', label: '数学公式块 (LaTeX)', onSelect: () => dispatchFormat('math') },
        { kind: 'item', label: 'Mermaid 图表', onSelect: () => dispatchFormat('mermaid') },
        { kind: 'item', label: '分割线', onSelect: () => dispatchFormat('rule') },
        { kind: 'item', label: '插入目录 [TOC]', onSelect: () => dispatchFormat('toc') },
        { kind: 'item', label: '插入脚注', onSelect: () => dispatchFormat('footnote') },
        { kind: 'separator' },
        { kind: 'item', label: '插入图片语法', onSelect: () => dispatchFormat('image') },
        { kind: 'item', label: '导入本地图片…', onSelect: () => this.ctx.dispatch({ type: 'image-import' }) },
        {
          kind: 'submenu',
          label: '图片资源策略',
          items: IMAGE_MODES.map(item => ({
            kind: 'item' as const,
            label: item.label,
            checked: imageMode === item.mode,
            onSelect: () => {
              this.ctx.setImageMode(item.mode)
              this.ctx.dispatch({ type: 'images', mode: item.mode })
            },
          })),
        },
      ]
    }

    // view menu
    const titlebar = this.ctx.getTitlebar()
    const themeItems: MenuEntry[] = [{ id: 'default', name: '默认' }, ...themes].map(theme => ({
      kind: 'item',
      label: theme.name,
      checked: theme.id === active,
      onSelect: () => this.ctx.dispatch({ type: 'theme', id: theme.id }),
    }))

    themeItems.push(
      { kind: 'separator' },
      { kind: 'item', label: '导入本机 Typora 主题', onSelect: () => this.ctx.dispatch({ type: 'theme-import-typora' }) },
      { kind: 'item', label: '导入主题 CSS…', onSelect: () => this.ctx.dispatch({ type: 'theme-import' }) },
    )

    return [
      {
        kind: 'item',
        label: '实时编辑模式',
        checked: state.mode === 'live',
        shortcutId: 'view.toggleMode',
        onSelect: () => this.ctx.dispatch({ type: 'mode', mode: 'live' }),
      },
      {
        kind: 'item',
        label: '源码模式',
        checked: state.mode === 'source',
        onSelect: () => this.ctx.dispatch({ type: 'mode', mode: 'source' }),
      },
      { kind: 'separator' },
      {
        kind: 'item',
        label: '显示左侧导览栏',
        checked: this.ctx.isLeftOpen(),
        shortcutId: 'view.toggleSidebar',
        onSelect: () => this.ctx.onToggleLeftSidebar(),
      },
      {
        kind: 'item',
        label: '切换至大纲面板',
        shortcutId: 'view.toggleOutline',
        onSelect: () => this.ctx.onToggleLeftSidebar('outline'),
      },
      {
        kind: 'item',
        label: 'AI 写作助手侧栏',
        checked: this.ctx.isRightOpen(),
        shortcutId: 'view.toggleAI',
        onSelect: () => this.ctx.onToggleRightPanel('ai'),
      },
      {
        kind: 'item',
        label: 'MCP 工具与连接侧栏',
        shortcutId: 'view.toggleMcp',
        onSelect: () => this.ctx.onToggleRightPanel('mcp'),
      },
      { kind: 'separator' },
      {
        kind: 'item',
        label: '专注模式',
        checked: state.presentation.focus,
        shortcutId: 'view.toggleFocus',
        onSelect: () => togglePres('focus'),
      },
      {
        kind: 'item',
        label: '打字机模式',
        checked: state.presentation.typewriter,
        shortcutId: 'view.toggleTypewriter',
        onSelect: () => togglePres('typewriter'),
      },
      {
        kind: 'item',
        label: '拼写检查',
        checked: state.presentation.spellcheck,
        onSelect: () => togglePres('spellcheck'),
      },
      {
        kind: 'item',
        label: '只读保护模式',
        checked: Boolean(state.presentation.readonly),
        shortcutId: 'view.toggleReadonly',
        onSelect: () => togglePres('readonly'),
      },
      { kind: 'separator' },
      {
        kind: 'submenu', label: '文件树筛选', items: [
          { kind: 'item', label: '显示隐藏项', checked: state.workspaceFilter?.hidden ?? false, onSelect: () => this.ctx.dispatch({ type: 'workspace-filter', option: 'hidden' }) },
          { kind: 'item', label: '显示非 Markdown 项', checked: state.workspaceFilter?.all ?? false, onSelect: () => this.ctx.dispatch({ type: 'workspace-filter', option: 'all' }) },
          { kind: 'item', label: '设置路径规则…', checked: !!state.workspaceFilter?.glob, onSelect: () => this.ctx.dispatch({ type: 'workspace-filter', option: 'glob' }) },
        ],
      },
      {
        kind: 'submenu', label: '缩放', items: [
          { kind: 'item', label: '放大', onSelect: () => this.ctx.dispatch({ type: 'window-view', operation: 'zoom-in' }) },
          { kind: 'item', label: '缩小', onSelect: () => this.ctx.dispatch({ type: 'window-view', operation: 'zoom-out' }) },
          { kind: 'item', label: '实际大小', onSelect: () => this.ctx.dispatch({ type: 'window-view', operation: 'zoom-default' }) },
        ],
      },
      { kind: 'item', label: '切换全屏', onSelect: () => this.ctx.dispatch({ type: 'window-view', operation: 'fullscreen' }) },
      ...(titlebar ? [{
        kind: 'submenu' as const, label: '标题栏材质',
        items: [
          { kind: 'item' as const, label: '毛玻璃', checked: titlebar.material === 'frosted', onSelect: () => this.ctx.dispatch({ type: 'titlebar-material', material: 'frosted' }) },
          { kind: 'item' as const, label: '液态玻璃', checked: titlebar.material === 'liquid', disabled: !titlebar.liquidAvailable, onSelect: () => this.ctx.dispatch({ type: 'titlebar-material', material: 'liquid' }) },
        ],
      }] : []),
      { kind: 'submenu', label: '文档主题', items: themeItems },
      { kind: 'item', label: '导入主题 CSS…', onSelect: () => this.ctx.dispatch({ type: 'theme-import' }) },
    ]
  }

  private renderEntries(container: HTMLElement, entries: MenuEntry[], menuKey: TopMenuKey) {
    container.replaceChildren()
    for (const entry of entries) {
      if (entry.kind === 'separator') {
        container.append(el('div', { className: 'yy-menu-sep', attrs: { role: 'separator' } }))
        continue
      }
      if (entry.kind === 'heading') {
        container.append(el('div', { className: 'yy-menu-heading', text: entry.label }))
        continue
      }
      if (entry.kind === 'submenu') {
        const subWrap = el('div', { className: 'yy-submenu-wrap' })
        const btn = el('button', {
          className: 'yy-menu-item yy-submenu-trigger',
          type: 'button',
          attrs: { role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
        })
        btn.append(
          el('span', { className: 'yy-menu-check' }),
          el('span', { className: 'yy-menu-label', text: entry.label }),
          el('span', { className: 'yy-icon yy-menu-arrow', html: icons.chevronRight }),
        )
        const subPanel = el('div', { className: 'yy-submenu-panel', attrs: { role: 'menu' } })
        this.renderEntries(subPanel, entry.items, menuKey)

        const toggleSub = (open: boolean) => {
          subWrap.classList.toggle('is-open', open)
          btn.setAttribute('aria-expanded', String(open))
        }
        btn.addEventListener('click', event => {
          event.stopPropagation()
          toggleSub(!subWrap.classList.contains('is-open'))
        })
        btn.addEventListener('keydown', event => {
          if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            event.stopPropagation()
            toggleSub(true)
            subPanel.querySelector<HTMLButtonElement>('.yy-menu-item:not([disabled])')?.focus()
          }
        })
        subPanel.addEventListener('keydown', event => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            event.stopPropagation()
            toggleSub(false)
            btn.focus()
          }
        })
        subWrap.append(btn, subPanel)
        container.append(subWrap)
        continue
      }

      const btn = el('button', {
        className: 'yy-menu-item',
        type: 'button',
        attrs: {
          role: entry.checked !== undefined ? 'menuitemcheckbox' : 'menuitem',
          ...(entry.checked !== undefined ? { 'aria-checked': String(entry.checked) } : {}),
        },
      })
      if (entry.disabled) btn.disabled = true
      const checkSlot = el('span', {
        className: 'yy-menu-check',
        html: entry.checked ? icons.check : '',
      })
      const labelEl = el('span', { className: 'yy-menu-label', text: entry.label })
      btn.append(checkSlot, labelEl)
      if (entry.shortcutId) {
        const kbdText = this.ctx.shortcuts.getLabel(entry.shortcutId, this.isMac)
        if (kbdText) {
          btn.append(el('kbd', { className: 'yy-menu-kbd', text: kbdText }))
        }
      }
      btn.addEventListener('click', () => {
        if (entry.disabled) return
        this.close(false)
        entry.onSelect()
      })
      container.append(btn)
    }

    container.addEventListener('keydown', event => {
      const items = Array.from(container.children)
        .map(child => (child.classList.contains('yy-submenu-wrap')
          ? child.querySelector<HTMLButtonElement>(':scope > .yy-menu-item')
          : (child instanceof HTMLButtonElement ? child : null)))
        .filter((item): item is HTMLButtonElement => Boolean(item && !item.disabled))
      const active = document.activeElement as HTMLButtonElement | null
      const idx = active ? items.indexOf(active) : -1
      if (event.key === 'ArrowDown' && items.length > 0) {
        event.preventDefault()
        event.stopPropagation()
        items[(idx + 1 + items.length) % items.length].focus()
      } else if (event.key === 'ArrowUp' && items.length > 0) {
        event.preventDefault()
        event.stopPropagation()
        items[(idx - 1 + items.length) % items.length].focus()
      } else if (container === this.dropdown && event.key === 'ArrowRight') {
        event.preventDefault()
        this.moveTopMenu(menuKey, 1)
      } else if (container === this.dropdown && event.key === 'ArrowLeft') {
        event.preventDefault()
        this.moveTopMenu(menuKey, -1)
      }
    })
  }

  open(key: TopMenuKey, focusFirst = false) {
    this.openMenu = key
    for (const [menuKey, trigger] of this.triggers) {
      const active = menuKey === key
      trigger.classList.toggle('is-open', active)
      trigger.setAttribute('aria-expanded', String(active))
    }
    const trigger = this.triggers.get(key)!
    this.renderEntries(this.dropdown, this.buildEntries(key), key)
    this.dropdown.style.left = `${trigger.offsetLeft}px`
    this.dropdown.removeAttribute('hidden')
    if (focusFirst) {
      queueMicrotask(() => {
        this.dropdown.querySelector<HTMLButtonElement>('.yy-menu-item:not([disabled])')?.focus()
      })
    }
  }

  close(restoreFocus = false) {
    if (!this.openMenu) return
    this.openMenu = null
    for (const trigger of this.triggers.values()) {
      trigger.classList.remove('is-open')
      trigger.setAttribute('aria-expanded', 'false')
    }
    this.dropdown.setAttribute('hidden', '')
    this.dropdown.replaceChildren()
    if (restoreFocus) this.ctx.restoreEditorFocus()
  }

  destroy() {
    document.removeEventListener('mousedown', this.docPointerDown)
    window.removeEventListener('keydown', this.docKeyDown, true)
  }
}
