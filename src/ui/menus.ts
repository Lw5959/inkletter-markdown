import type {
  EditorFormat,
  ExportFormat,
  ImageMode,
  PluginInfo,
  ShellAction,
  ShellState,
  Theme,
  TitlebarView,
  DocumentWidth,
} from '../contracts'
import { el } from './helpers'
import type { ContextItem } from './context-menu'
import { icons } from './icons'
import { detectMac, type ShortcutCommandId, type ShortcutRegistry } from './shortcuts'

const documentWidths: Record<DocumentWidth, string> = {
  default: '主题默认', wide: '宽', 'extra-wide': '超宽', full: '铺满',
}

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

type MenuItem = {
  kind: 'item'
  label: string
  location?: string
  shortcutId?: ShortcutCommandId
  checked?: boolean
  disabled?: boolean
  icon?: string
  count?: number
  theme?: Pick<Theme, 'id' | 'swatch'>
  onSelect: () => void
}
type MenuCommand =
  | { kind: 'separator' }
  | { kind: 'heading'; label: string }
  | MenuItem

type MenuItems = MenuCommand[] | (() => MenuCommand[])
type MenuEntry = MenuCommand | { kind: 'submenu'; label: string; items: MenuItems }

export interface MenuBarContext {
  dispatch: (action: ShellAction) => void
  shortcuts: ShortcutRegistry
  getState: () => ShellState
  loadRecentFiles: () => Promise<readonly string[]>
  getThemes: () => { themes: Theme[]; local: Theme[]; active: string }
  getImageMode: () => ImageMode
  setImageMode: (mode: ImageMode) => void
  onOpenQuickOpen: () => void
  onOpenFind: (replace: boolean) => void
  onOpenWorkspaceSearch: () => void
  onOpenShortcuts: () => void
  getEnabledPlugins: () => PluginInfo[]
  onOpenPlugins: () => void
  onOpenPluginMarket?: () => void
  getTitlebar: () => TitlebarView | null
  onToggleLeftSidebar: (tab?: 'files' | 'outline' | 'search') => void
  onToggleRightPanel: (tab: 'ai' | 'mcp') => void
  isLeftOpen: () => boolean
  isRightOpen: (tab: 'ai' | 'mcp') => boolean
  getMcpProposals: () => number
  restoreEditorFocus: () => void
}

type TopMenuKey = 'file' | 'edit' | 'format' | 'view' | 'help'

const TOP_MENUS: readonly { key: TopMenuKey; label: string }[] = [
  { key: 'file', label: '文件' },
  { key: 'edit', label: '编辑' },
  { key: 'format', label: '格式' },
  { key: 'view', label: '视图' },
  { key: 'help', label: '帮助' },
]
const menuMargin = 8

export class MenuBar {
  readonly element: HTMLElement
  private triggers = new Map<TopMenuKey, HTMLButtonElement>()
  private dropdown: HTMLElement
  private submenu: HTMLElement
  private submenuTrigger: HTMLButtonElement | null = null
  private liveSubmenuItems: (() => MenuCommand[]) | null = null
  private submenuCloseTimer = 0
  private openMenu: TopMenuKey | null = null
  private recentFiles: readonly string[] | undefined
  private recentError = false
  private recentRequest: Promise<readonly string[]> | undefined
  private docPointerDown: (event: MouseEvent) => void
  private docKeyDown: (event: KeyboardEvent) => void
  private onResize: () => void
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
    this.submenu = el('div', {
      className: 'yy-submenu-panel',
      attrs: { role: 'menu', hidden: '', tabindex: '-1' },
    })
    // 子菜单独立于可滚动的一级菜单，避免滚动容器裁切展开的内容。
    this.element.append(this.dropdown, this.submenu)
    for (const panel of [this.dropdown, this.submenu]) {
      panel.addEventListener('keydown', event => this.navigatePanel(event, panel))
      panel.addEventListener('pointerenter', () => this.cancelSubmenuClose())
      panel.addEventListener('pointerleave', () => {
        if (!this.submenu.contains(document.activeElement)) this.deferSubmenuClose()
      })
    }
    this.dropdown.addEventListener('scroll', () => this.positionSubmenu())

    this.onResize = () => {
      if (!this.openMenu) return
      this.positionDropdown(this.triggers.get(this.openMenu)!)
      this.positionSubmenu()
    }
    window.addEventListener('resize', this.onResize)

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
        if (this.submenuTrigger) {
          this.closeSubmenu(true)
          return
        }
        const key = this.openMenu
        this.close(false)
        this.triggers.get(key)?.focus()
      } else if (event.key === 'Tab') {
        const key = this.openMenu
        this.close(false)
        this.triggers.get(key)?.focus({ preventScroll: true })
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
    const imageMode = this.ctx.getImageMode()
    const togglePres = (field: keyof ShellState['presentation']) => {
      const next = { ...state.presentation, [field]: !state.presentation[field] }
      this.ctx.dispatch({ type: 'presentation', value: next })
    }

    if (key === 'help') {
      return [{
        kind: 'item', label: '检查更新…', icon: icons.refresh,
        onSelect: () => {
          // 菜单项已移除，先把焦点放回入口，让对话框关闭后能恢复焦点。
          this.triggers.get('help')?.focus()
          this.ctx.dispatch({ type: 'check-update' })
        },
      }]
    }

    if (key === 'file') {
      return [
        { kind: 'item', label: '新建文档', shortcutId: 'file.new', onSelect: () => this.ctx.dispatch({ type: 'new' }) },
        { kind: 'item', label: '打开文件…', shortcutId: 'file.open', onSelect: () => this.ctx.dispatch({ type: 'open' }) },
        { kind: 'submenu', label: '最近打开', items: () => this.buildRecentItems() },
        { kind: 'item', label: '打开文件夹…', shortcutId: 'file.openFolder', onSelect: () => this.ctx.dispatch({ type: 'open-folder' }) },
        { kind: 'item', label: '快速打开…', shortcutId: 'nav.quickOpen', onSelect: () => this.ctx.onOpenQuickOpen() },
        { kind: 'item', label: '重新打开最近关闭', onSelect: () => this.ctx.dispatch({ type: 'reopen' }) },
        { kind: 'item', label: '设为 Markdown 默认打开方式…', onSelect: () => this.ctx.dispatch({ type: 'markdown-default' }) },
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
      const plugins = this.ctx.getEnabledPlugins()
      const commands: MenuCommand[] = plugins.flatMap(plugin => [
        { kind: 'heading', label: plugin.name },
        ...plugin.commands.map(command => ({
          kind: 'item' as const,
          label: command.label,
          disabled: state.presentation.readonly && command.workflow !== 'mcp',
          onSelect: () => this.ctx.dispatch({
            type: 'plugin-run', id: plugin.id, command: command.id, scope: command.scope ?? 'selection',
          }),
        })),
      ])
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
        { kind: 'item', label: '导入 Typora 配置…', onSelect: () => this.ctx.dispatch({ type: 'typora-config-import' }) },
        ...(commands.length ? [{ kind: 'submenu' as const, label: '运行插件', items: commands }] : []),
        { kind: 'item', label: '插件管理…', onSelect: () => this.ctx.onOpenPlugins() },
        ...(this.ctx.onOpenPluginMarket
          ? [{ kind: 'item' as const, label: '插件市场…', onSelect: this.ctx.onOpenPluginMarket }]
          : []),
      ]
    }

    if (key === 'format') {
      const { inline, blocks, media } = this.formatItems()
      return [
        { kind: 'heading', label: '行内样式' },
        ...inline,
        { kind: 'separator' },
        { kind: 'heading', label: '段落与块级结构' },
        ...blocks,
        { kind: 'separator' },
        ...media,
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
      { kind: 'submenu', label: '文档主题', items: () => this.buildThemeItems() },
      { kind: 'submenu', label: '正文宽度', items: (Object.keys(documentWidths) as DocumentWidth[]).map(width => ({
        kind: 'item' as const, label: documentWidths[width], checked: width === (state.documentWidth ?? 'default'),
        onSelect: () => this.ctx.dispatch({ type: 'document-width', width }),
      })) },
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
        kind: 'submenu', label: '协作侧栏', items: [
          {
            kind: 'item',
            label: 'AI 写作助手',
            checked: this.ctx.isRightOpen('ai'),
            shortcutId: 'view.toggleAI',
            onSelect: () => this.ctx.onToggleRightPanel('ai'),
          },
          {
            kind: 'item',
            label: 'MCP 工具与连接',
            checked: this.ctx.isRightOpen('mcp'),
            shortcutId: 'view.toggleMcp',
            count: this.ctx.getMcpProposals(),
            onSelect: () => this.ctx.onToggleRightPanel('mcp'),
          },
        ],
      },
      { kind: 'separator' },
      {
        kind: 'item',
        label: '界面动画',
        checked: state.animations !== false,
        onSelect: () => this.ctx.dispatch({ type: 'animations', enabled: state.animations === false }),
      },
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
          { kind: 'item', label: '显示其他文件', checked: state.workspaceFilter?.all ?? false, onSelect: () => this.ctx.dispatch({ type: 'workspace-filter', option: 'all' }) },
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
    ]
  }

  private formatItems() {
    const item = (label: string, format: EditorFormat, shortcutId?: ShortcutCommandId): MenuItem => ({
      kind: 'item', label, shortcutId, onSelect: () => this.ctx.dispatch({ type: 'format', format }),
    })
    return {
      inline: [
        item('加粗', 'bold', 'format.bold'), item('斜体', 'italic', 'format.italic'), item('下划线', 'underline', 'format.underline'),
        item('高亮', 'highlight'), item('上标', 'superscript'), item('下标', 'subscript'), item('删除线', 'strike', 'format.strike'),
        item('行内代码', 'inline-code', 'format.inlineCode'), item('插入链接', 'link', 'format.link'), item('清除格式', 'clear'),
      ],
      blocks: [
        item('一级标题', 'heading-1', 'format.heading1'), item('二级标题', 'heading-2', 'format.heading2'),
        item('三级标题', 'heading-3', 'format.heading3'), item('引用块', 'quote', 'format.quote'), item('无序列表', 'bullet-list'),
        item('有序列表', 'ordered-list'), item('任务列表', 'task'), item('表格', 'table'), item('代码块', 'code-block', 'format.codeBlock'),
        item('数学公式块 (LaTeX)', 'math'), item('Mermaid 图表', 'mermaid'), item('分割线', 'rule'),
        item('插入目录 [TOC]', 'toc'), item('插入脚注', 'footnote'),
      ],
      media: [item('插入图片语法', 'image'), {
        kind: 'item' as const, label: '导入本地图片…', onSelect: () => this.ctx.dispatch({ type: 'image-import' }),
      }],
    }
  }

  editorFormatCommands(): ContextItem[] {
    const { inline, blocks, media } = this.formatItems()
    const commands = (items: MenuItem[]) => items.map(({ label, onSelect }) => ({ label, run: onSelect }))
    return [
      { label: '行内样式', items: commands(inline) },
      { label: '段落与块级结构', items: commands(blocks) },
      ...commands(media),
    ]
  }

  private buildRecentItems(): MenuCommand[] {
    if (!this.recentFiles?.length) return [{
      kind: 'heading',
      label: this.recentError ? '无法读取最近打开的文档' : this.recentFiles ? '暂无最近打开的文档' : '正在读取最近记录…',
    }]
    const current = this.ctx.getState().path
    return this.recentFiles.map(path => {
      // Windows 路径也可能使用正斜杠，POSIX 文件名里的反斜杠应保留。
      const nameStart = Math.max(path.lastIndexOf('/'), path.startsWith('/') ? -1 : path.lastIndexOf('\\')) + 1
      return {
        kind: 'item',
        label: path.slice(nameStart),
        location: path.slice(0, nameStart),
        icon: path === current ? icons.check : icons.file,
        onSelect: () => this.ctx.dispatch({ type: 'open-recent', path }),
      }
    })
  }

  private loadRecentFiles() {
    // 各窗口共用磁盘记录。打开文件菜单时重新读取，并丢弃旧请求的结果。
    const request = this.recentRequest = this.ctx.loadRecentFiles()
    const sync = (files?: readonly string[]) => {
      if (this.recentRequest !== request) return
      this.recentFiles = files ?? this.recentFiles
      this.recentError = files === undefined
      if (this.openMenu === 'file') this.refreshSubmenu()
    }
    void request.then(sync, () => sync())
  }

  private buildThemeItems(): MenuCommand[] {
    const { themes, local, active } = this.ctx.getThemes()
    const groups = [
      { label: '内置主题', themes: [{ id: 'default', name: '默认' }, ...themes.filter(theme => theme.swatch)] },
      { label: '本机 Typora', themes: local },
      { label: '已导入', themes: themes.filter(theme => !theme.swatch) },
    ]
    const items: MenuCommand[] = []
    for (const group of groups) {
      if (!group.themes.length) continue
      items.push({ kind: 'heading', label: group.label })
      for (const theme of group.themes) {
        items.push({
          kind: 'item',
          label: theme.name,
          theme,
          checked: theme.id === active,
          onSelect: () => this.ctx.dispatch({ type: 'theme', id: theme.id }),
        })
      }
    }
    items.push(
      { kind: 'separator' },
      { kind: 'item', label: '导入本机 Typora 主题', icon: icons.plus, onSelect: () => this.ctx.dispatch({ type: 'theme-import-typora' }) },
      { kind: 'item', label: '导入主题 CSS…', icon: icons.plus, onSelect: () => this.ctx.dispatch({ type: 'theme-import' }) },
    )
    return items
  }

  private renderEntries(container: HTMLElement, entries: MenuEntry[]) {
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
        btn.addEventListener('pointerenter', event => {
          if (event.pointerType !== 'touch') this.openSubmenu(btn, entry.items)
        })
        btn.addEventListener('click', () => this.openSubmenu(btn, entry.items))
        btn.addEventListener('keydown', event => {
          if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            event.stopPropagation()
            this.openSubmenu(btn, entry.items)
            const first = this.submenu.querySelector<HTMLButtonElement>('.yy-menu-item:not([disabled])') ?? this.submenu
            first.focus()
          }
        })
        container.append(btn)
        continue
      }

      const btn = el('button', {
        className: 'yy-menu-item',
        type: 'button',
        title: entry.location ? entry.location + entry.label : undefined,
        attrs: {
          role: entry.theme ? 'menuitemradio' : entry.checked !== undefined ? 'menuitemcheckbox' : 'menuitem',
          ...(entry.checked !== undefined ? { 'aria-checked': String(entry.checked) } : {}),
          ...(entry.theme ? { 'data-theme-id': entry.theme.id } : {}),
        },
      })
      if (entry.disabled) btn.disabled = true
      const checkSlot = el('span', {
        className: 'yy-menu-check',
        html: entry.checked ? icons.check : entry.icon ?? '',
      })
      const labelEl = entry.location
        ? el('span', { className: 'yy-menu-label yy-menu-file' },
          el('span', { text: entry.label }), el('span', { className: 'yy-menu-file-location', text: entry.location }))
        : el('span', { className: 'yy-menu-label', text: entry.label })
      btn.append(checkSlot, labelEl)
      if (entry.theme?.swatch) {
        const sample = el('span', {
          className: 'yy-theme-sample',
          html: '<svg viewBox="0 0 18 12" width="18" height="12" aria-hidden="true"><path d="M3 4h12M3 8h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
        })
        sample.style.backgroundColor = entry.theme.swatch.paper
        sample.style.color = entry.theme.swatch.ink
        btn.append(sample)
      }
      if (entry.count) {
        btn.append(el('span', {
          className: 'yy-count-badge',
          text: String(entry.count),
          attrs: { 'aria-label': `${entry.count} 条待审建议` },
        }))
      }
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
      if (container === this.dropdown) btn.addEventListener('pointerenter', () => this.deferSubmenuClose())
      container.append(btn)
    }
  }

  private navigatePanel(event: KeyboardEvent, panel: HTMLElement) {
    const { key } = event
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      const items = [...panel.querySelectorAll<HTMLButtonElement>('.yy-menu-item:not([disabled])')]
      if (!items.length) return
      event.preventDefault()
      event.stopPropagation()
      this.cancelSubmenuClose()
      if (panel === this.dropdown) this.closeSubmenu()
      const index = items.findIndex(item => item === document.activeElement)
      let target = 0
      if (key === 'End' || (key === 'ArrowUp' && index < 0)) target = items.length - 1
      else if (key !== 'Home') target = (index + (key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[target].focus()
    } else if (key === 'ArrowLeft' && panel === this.submenu) {
      event.preventDefault()
      event.stopPropagation()
      this.closeSubmenu(true)
    } else if ((key === 'ArrowLeft' || key === 'ArrowRight') && panel === this.dropdown && this.openMenu) {
      event.preventDefault()
      event.stopPropagation()
      this.moveTopMenu(this.openMenu, key === 'ArrowRight' ? 1 : -1)
    }
  }

  private openSubmenu(trigger: HTMLButtonElement, entries: MenuItems) {
    this.cancelSubmenuClose()
    if (this.submenuTrigger === trigger) return
    this.closeSubmenu()
    this.submenuTrigger = trigger
    this.liveSubmenuItems = typeof entries === 'function' ? entries : null
    this.renderEntries(this.submenu, typeof entries === 'function' ? entries() : entries)
    trigger.setAttribute('aria-expanded', 'true')
    this.submenu.setAttribute('aria-label', trigger.textContent ?? '')
    this.submenu.hidden = false
    this.submenu.scrollTop = 0
    this.positionSubmenu()
  }

  refreshSubmenu() {
    if (!this.liveSubmenuItems) return
    // 主题和最近记录可能晚于菜单加载。刷新时保留位置和键盘焦点。
    const active = document.activeElement
    const previous = active instanceof HTMLButtonElement && this.submenu.contains(active) ? active : null
    const scroll = this.submenu.scrollTop
    this.renderEntries(this.submenu, this.liveSubmenuItems())
    this.submenu.scrollTop = scroll
    if (previous || active === this.submenu) {
      const options = [...this.submenu.querySelectorAll<HTMLButtonElement>('button:not([disabled])')]
      const match = options.find(option => previous?.dataset.themeId
        ? option.dataset.themeId === previous.dataset.themeId
        : option.textContent === previous?.textContent)
      const next = match ?? options[0] ?? this.submenu
      next.focus({ preventScroll: next === match })
    }
    this.positionSubmenu()
  }

  private cancelSubmenuClose() {
    window.clearTimeout(this.submenuCloseTimer)
  }

  private deferSubmenuClose() {
    if (!this.submenuTrigger) return
    this.cancelSubmenuClose()
    // 允许鼠标斜向移入子菜单，经过一级菜单相邻条目时保留短暂的过渡时间。
    this.submenuCloseTimer = window.setTimeout(() => {
      this.closeSubmenu(this.submenu.contains(document.activeElement))
    }, 180)
  }

  private closeSubmenu(restoreFocus = false) {
    this.cancelSubmenuClose()
    const trigger = this.submenuTrigger
    if (!trigger) return
    this.submenuTrigger = null
    this.liveSubmenuItems = null
    trigger.setAttribute('aria-expanded', 'false')
    this.submenu.hidden = true
    this.submenu.replaceChildren()
    if (restoreFocus) trigger.focus({ preventScroll: true })
  }

  private menuBounds() {
    const bar = this.element.getBoundingClientRect()
    const height = Number.parseFloat(getComputedStyle(this.element).height)
    return { bar, scale: height > 0 ? bar.height / height : 1 }
  }

  private positionDropdown(trigger: HTMLButtonElement) {
    const { bar, scale } = this.menuBounds()
    this.dropdown.style.left = `${trigger.offsetLeft}px`
    const overflow = this.dropdown.getBoundingClientRect().right + menuMargin - window.innerWidth
    if (overflow > 0) {
      const left = Math.max((menuMargin - bar.left) / scale, trigger.offsetLeft - overflow / scale)
      this.dropdown.style.left = `${left}px`
    }
  }

  private positionSubmenu() {
    if (!this.submenuTrigger) return
    // macOS 标题栏有反向缩放，先在窗口坐标夹紧，再换回菜单栏自己的坐标。
    const { bar, scale } = this.menuBounds()
    const anchor = this.submenuTrigger.getBoundingClientRect()
    const parent = this.dropdown.getBoundingClientRect()
    if (anchor.bottom <= parent.top || anchor.top >= parent.bottom) {
      this.closeSubmenu()
      return
    }
    this.submenu.style.maxHeight = `${(window.innerHeight - menuMargin * 2) / scale}px`
    const viewportRight = window.innerWidth - menuMargin
    const rightSpace = viewportRight - parent.right + 1
    const leftSpace = parent.left - menuMargin + 1
    this.submenu.style.maxWidth = ''
    const preferredWidth = this.submenu.getBoundingClientRect().width
    const openRight = preferredWidth <= rightSpace || rightSpace >= leftSpace
    // 空间不足时先缩窄并允许标签换行，极窄视口再让两个菜单少量重叠。
    const availableWidth = (openRight ? rightSpace : leftSpace) / scale
    this.submenu.style.maxWidth = `${Math.min(Math.max(availableWidth, 144), (viewportRight - menuMargin) / scale)}px`
    const panel = this.submenu.getBoundingClientRect()
    const left = openRight ? parent.right - 1 : parent.left - panel.width + 1
    const x = Math.max(menuMargin, Math.min(left, viewportRight - panel.width))
    const y = Math.max(menuMargin, Math.min(Math.max(anchor.top - 6 * scale, parent.top), window.innerHeight - menuMargin - panel.height))
    this.submenu.style.left = `${(x - bar.left) / scale}px`
    this.submenu.style.top = `${(y - bar.top) / scale}px`
  }

  open(key: TopMenuKey, focusFirst = false) {
    this.closeSubmenu()
    this.openMenu = key
    if (key === 'file') this.loadRecentFiles()
    for (const [menuKey, trigger] of this.triggers) {
      const active = menuKey === key
      trigger.classList.toggle('is-open', active)
      trigger.setAttribute('aria-expanded', String(active))
    }
    const trigger = this.triggers.get(key)!
    this.renderEntries(this.dropdown, this.buildEntries(key))
    this.dropdown.setAttribute('aria-label', trigger.textContent ?? '')
    this.dropdown.removeAttribute('hidden')
    this.dropdown.scrollTop = 0
    this.positionDropdown(trigger)
    if (focusFirst) {
      queueMicrotask(() => {
        if (this.openMenu === key) this.dropdown.querySelector<HTMLButtonElement>('.yy-menu-item:not([disabled])')?.focus()
      })
    }
  }

  close(restoreFocus = false) {
    if (!this.openMenu) return
    this.closeSubmenu()
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
    this.close()
    document.removeEventListener('mousedown', this.docPointerDown)
    window.removeEventListener('keydown', this.docKeyDown, true)
    window.removeEventListener('resize', this.onResize)
  }
}
