import type { OutlineEntry, SearchResult, ShellAction, WorkspaceEntry } from '../contracts'
import type { ModalManager } from './dialogs'
import { el } from './helpers'
import { icons } from './icons'

export type LeftTab = 'files' | 'outline' | 'search'

export interface LeftPanelOptions {
  dispatch: (action: ShellAction) => void
  modals: ModalManager
  onAfterNavigate: () => void
}

export class LeftPanel {
  readonly element: HTMLElement
  private tabButtons = new Map<LeftTab, HTMLButtonElement>()
  private panes = new Map<LeftTab, HTMLElement>()
  private activeTab: LeftTab = 'files'

  // Workspace state
  private workspaceRoot: string | null = null
  private activeFilePath: string | null = null
  private entries: WorkspaceEntry[] = []
  private expandedFolders = new Set<string>()
  private selectedFolderPath: string | null = null
  private workspaceMetaEl!: HTMLElement
  private treeContainer!: HTMLElement
  private createFileBtn!: HTMLButtonElement
  private createFolderBtn!: HTMLButtonElement

  // Outline state
  private outline: OutlineEntry[] = []
  private outlineFilter = ''
  private outlineList!: HTMLElement

  // Search state
  private searchInput!: HTMLInputElement
  private searchRegexBtn!: HTMLButtonElement
  private searchRegex = false
  private searchResults: SearchResult[] = []
  private searchCountEl!: HTMLElement
  private searchList!: HTMLElement
  private searchTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private options: LeftPanelOptions) {
    this.element = el('aside', {
      className: 'yy-left-panel yy-chrome',
      attrs: { 'aria-label': '左侧导览栏' },
    })

    const tabBar = el('div', { className: 'yy-seg-tabs', attrs: { role: 'tablist', 'aria-label': '左侧栏视图' } })
    const tabs: { id: LeftTab; label: string; icon: string }[] = [
      { id: 'files', label: '文件', icon: icons.folder },
      { id: 'outline', label: '大纲', icon: icons.outline },
      { id: 'search', label: '检索', icon: icons.search },
    ]
    for (const tab of tabs) {
      const btn = el('button', {
        className: 'yy-seg-tab',
        type: 'button',
        attrs: {
          role: 'tab',
          'aria-selected': String(tab.id === this.activeTab),
          'data-left-tab': tab.id,
        },
      })
      btn.append(el('span', { className: 'yy-icon', html: tab.icon }), el('span', { text: tab.label }))
      btn.addEventListener('click', () => this.setTab(tab.id))
      this.tabButtons.set(tab.id, btn)
      tabBar.append(btn)
    }

    const filesPane = this.buildFilesPane()
    const outlinePane = this.buildOutlinePane()
    const searchPane = this.buildSearchPane()
    this.panes.set('files', filesPane)
    this.panes.set('outline', outlinePane)
    this.panes.set('search', searchPane)

    this.element.append(tabBar, filesPane, outlinePane, searchPane)
    this.syncTabs()
  }

  private buildFilesPane(): HTMLElement {
    const pane = el('div', { className: 'yy-pane', attrs: { role: 'tabpanel', 'data-pane': 'files' } })

    const toolbar = el('div', { className: 'yy-pane-toolbar' })
    this.workspaceMetaEl = el('div', { className: 'yy-workspace-name', text: '未打开文件夹' })

    const actions = el('div', { className: 'yy-pane-actions' })
    this.createFileBtn = el('button', {
      className: 'yy-icon-btn',
      type: 'button',
      html: icons.filePlus,
      title: '新建文件',
      attrs: { 'aria-label': '新建文件' },
    })
    this.createFileBtn.addEventListener('click', () => this.promptCreate(false))

    this.createFolderBtn = el('button', {
      className: 'yy-icon-btn',
      type: 'button',
      html: icons.folderPlus,
      title: '新建文件夹',
      attrs: { 'aria-label': '新建文件夹' },
    })
    this.createFolderBtn.addEventListener('click', () => this.promptCreate(true))

    const openFolderBtn = el('button', {
      className: 'yy-icon-btn',
      type: 'button',
      html: icons.folderOpen,
      title: '打开文件夹',
      attrs: { 'aria-label': '打开文件夹' },
    })
    openFolderBtn.addEventListener('click', () => this.options.dispatch({ type: 'open-folder' }))

    actions.append(this.createFileBtn, this.createFolderBtn, openFolderBtn)
    toolbar.append(this.workspaceMetaEl, actions)

    this.treeContainer = el('div', {
      className: 'yy-scroll-area yy-file-tree',
      attrs: { role: 'tree', 'aria-label': '工作区文件树' },
    })
    this.treeContainer.addEventListener('keydown', event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const items = Array.from(this.treeContainer.querySelectorAll<HTMLButtonElement>('.yy-tree-main'))
      if (items.length === 0) return
      const current = document.activeElement instanceof HTMLButtonElement ? items.indexOf(document.activeElement) : -1
      if (current === -1) return
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      items[(current + delta + items.length) % items.length].focus()
    })

    pane.append(toolbar, this.treeContainer)
    this.renderWorkspace()
    return pane
  }

  private buildOutlinePane(): HTMLElement {
    const pane = el('div', { className: 'yy-pane', attrs: { role: 'tabpanel', 'data-pane': 'outline' } })
    const filterWrap = el('div', { className: 'yy-pane-search' })
    const filterInput = el('input', {
      className: 'yy-input yy-input-sm',
      type: 'text',
      attrs: { placeholder: '筛选标题…', 'aria-label': '筛选文档大纲' },
    })
    filterInput.addEventListener('input', () => {
      this.outlineFilter = filterInput.value.trim().toLowerCase()
      this.renderOutline()
    })
    filterWrap.append(filterInput)

    this.outlineList = el('div', {
      className: 'yy-scroll-area yy-outline-list',
      attrs: { role: 'list', 'aria-label': '文档大纲' },
    })
    pane.append(filterWrap, this.outlineList)
    this.renderOutline()
    return pane
  }

  private buildSearchPane(): HTMLElement {
    const pane = el('div', { className: 'yy-pane', attrs: { role: 'tabpanel', 'data-pane': 'search' } })
    const form = el('form', { className: 'yy-search-form' })
    const row = el('div', { className: 'yy-input-group' })

    this.searchInput = el('input', {
      className: 'yy-input yy-input-sm',
      type: 'text',
      attrs: { placeholder: '在工作区中检索…', 'aria-label': '跨文件检索关键词' },
    })
    this.searchRegexBtn = el('button', {
      className: 'yy-toggle-chip',
      type: 'button',
      text: '.*',
      title: '使用正则表达式',
      attrs: { 'aria-pressed': 'false', 'aria-label': '切换正则检索' },
    })
    this.searchRegexBtn.addEventListener('click', () => {
      this.searchRegex = !this.searchRegex
      this.searchRegexBtn.classList.toggle('is-active', this.searchRegex)
      this.searchRegexBtn.setAttribute('aria-pressed', String(this.searchRegex))
      this.triggerSearchNow()
    })
    const submitBtn = el('button', {
      className: 'yy-btn yy-btn-sm yy-btn-primary',
      type: 'submit',
      text: '检索',
    })

    row.append(this.searchInput, this.searchRegexBtn, submitBtn)
    this.searchCountEl = el('div', { className: 'yy-search-meta', text: '输入关键词跨文件搜索' })
    form.append(row, this.searchCountEl)

    form.addEventListener('submit', event => {
      event.preventDefault()
      this.triggerSearchNow()
    })
    this.searchInput.addEventListener('input', () => {
      if (this.searchTimer) clearTimeout(this.searchTimer)
      this.searchTimer = setTimeout(() => this.triggerSearchNow(), 220)
    })

    this.searchList = el('div', {
      className: 'yy-scroll-area yy-search-results',
      attrs: { role: 'list', 'aria-label': '跨文件检索结果' },
    })
    pane.append(form, this.searchList)
    return pane
  }

  private triggerSearchNow() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer)
      this.searchTimer = null
    }
    const text = this.searchInput.value.trim()
    this.options.dispatch({ type: 'search-workspace', text, regex: this.searchRegex })
    if (!text) {
      this.searchCountEl.textContent = '输入关键词跨文件搜索'
    } else {
      this.searchCountEl.textContent = `正在检索「${text}」…`
    }
  }

  private promptCreate(folder: boolean, parentPath?: string) {
    const parent = parentPath ?? this.selectedFolderPath ?? this.workspaceRoot
    if (!parent) {
      this.options.dispatch({ type: 'open-folder' })
      return
    }
    this.options.modals.openTextPrompt({
      title: folder ? '新建文件夹' : '新建 Markdown 文件',
      label: folder ? '文件夹名称' : '文件名称（如 笔记.md）',
      placeholder: folder ? '例如：参考资料' : '例如：新文档.md',
      initialValue: folder ? '' : '未命名.md',
      confirmText: '创建',
      onConfirm: name => {
        const finalName = !folder && !/\.[a-z0-9]+$/i.test(name) ? `${name}.md` : name
        this.expandedFolders.add(parent)
        this.options.dispatch({ type: 'workspace-create', parent, name: finalName, folder })
      },
    })
  }

  private promptRename(entry: WorkspaceEntry) {
    this.options.modals.openTextPrompt({
      title: '重命名',
      label: `将「${entry.name}」重命名为`,
      initialValue: entry.name,
      confirmText: '重命名',
      onConfirm: name => {
        if (name !== entry.name) {
          this.options.dispatch({ type: 'workspace-rename', path: entry.path, name })
        }
      },
    })
  }

  private promptTrash(entry: WorkspaceEntry) {
    const isDir = Array.isArray(entry.children)
    this.options.modals.openConfirm({
      title: '移入废纸篓',
      message: `确定将${isDir ? '文件夹' : '文件'}「${entry.name}」移入系统废纸篓？`,
      confirmText: '移入废纸篓',
      danger: true,
      onConfirm: () => {
        this.options.dispatch({ type: 'workspace-trash', path: entry.path })
      },
    })
  }

  getTab(): LeftTab {
    return this.activeTab
  }

  setTab(tab: LeftTab) {
    this.activeTab = tab
    this.syncTabs()
  }

  focusSearch() {
    this.setTab('search')
    queueMicrotask(() => {
      this.searchInput.focus()
      this.searchInput.select()
    })
  }

  private syncTabs() {
    for (const [id, btn] of this.tabButtons) {
      const active = id === this.activeTab
      btn.classList.toggle('is-active', active)
      btn.setAttribute('aria-selected', String(active))
    }
    for (const [id, pane] of this.panes) {
      pane.toggleAttribute('hidden', id !== this.activeTab)
    }
  }

  setContextState(workspace: string | null, activePath: string | null) {
    const rootChanged = this.workspaceRoot !== workspace
    this.workspaceRoot = workspace
    this.activeFilePath = activePath
    if (rootChanged) {
      this.selectedFolderPath = workspace
    }
    const baseName = workspace ? workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || workspace : '未打开文件夹'
    this.workspaceMetaEl.textContent = baseName
    this.workspaceMetaEl.title = workspace ?? '点击右侧按钮打开文件夹'
    this.createFileBtn.disabled = !workspace
    this.createFolderBtn.disabled = !workspace
    this.renderWorkspace()
  }

  setWorkspace(entries: WorkspaceEntry[]) {
    this.entries = entries
    this.renderWorkspace()
  }

  private renderWorkspace() {
    this.treeContainer.replaceChildren()
    if (!this.workspaceRoot && this.entries.length === 0) {
      const empty = el('div', { className: 'yy-empty-box' })
      empty.append(el('p', { text: '尚未打开工作区文件夹' }))
      const btn = el('button', { className: 'yy-btn yy-btn-primary yy-btn-sm', type: 'button', text: '打开文件夹…' })
      btn.addEventListener('click', () => this.options.dispatch({ type: 'open-folder' }))
      empty.append(btn)
      this.treeContainer.append(empty)
      return
    }
    if (this.entries.length === 0) {
      const empty = el('div', { className: 'yy-empty-box' })
      empty.append(el('p', { text: '文件夹为空' }))
      const btn = el('button', { className: 'yy-btn yy-btn-sm', type: 'button', text: '新建文件' })
      btn.addEventListener('click', () => this.promptCreate(false))
      empty.append(btn)
      this.treeContainer.append(empty)
      return
    }

    const renderNodes = (list: WorkspaceEntry[], depth: number, parentEl: HTMLElement) => {
      for (const entry of list) {
        const isDir = Array.isArray(entry.children)
        const isExpanded = isDir && this.expandedFolders.has(entry.path)
        const isCurrent = !isDir && this.activeFilePath === entry.path
        const isSelectedDir = isDir && this.selectedFolderPath === entry.path

        const itemWrap = el('div', {
          className: 'yy-tree-node',
          attrs: { role: 'treeitem', ...(isDir ? { 'aria-expanded': String(isExpanded) } : {}) },
        })
        const row = el('div', {
          className: `yy-tree-row${isCurrent ? ' is-active' : ''}${isSelectedDir ? ' is-selected-dir' : ''}`,
          attrs: { 'data-path': entry.path },
        })
        row.style.paddingLeft = `${10 + depth * 14}px`

        const mainBtn = el('button', { className: 'yy-tree-main', type: 'button', title: entry.path })
        if (isDir) {
          mainBtn.append(
            el('span', { className: 'yy-icon yy-tree-caret', html: isExpanded ? icons.chevronDown : icons.chevronRight }),
            el('span', { className: 'yy-icon yy-tree-type', html: isExpanded ? icons.folderOpen : icons.folder }),
          )
        } else {
          mainBtn.append(
            el('span', { className: 'yy-tree-spacer' }),
            el('span', { className: 'yy-icon yy-tree-type', html: icons.file }),
          )
        }
        mainBtn.append(el('span', { className: 'yy-tree-label', text: entry.name }))
        mainBtn.addEventListener('click', () => {
          if (isDir) {
            this.selectedFolderPath = entry.path
            if (this.expandedFolders.has(entry.path)) {
              this.expandedFolders.delete(entry.path)
            } else {
              this.expandedFolders.add(entry.path)
            }
            this.renderWorkspace()
          } else {
            this.options.dispatch({ type: 'open-path', path: entry.path })
            this.options.onAfterNavigate()
          }
        })

        const rowActions = el('div', { className: 'yy-tree-actions' })
        if (isDir) {
          const addFileBtn = el('button', {
            className: 'yy-icon-btn yy-icon-btn-xs',
            type: 'button',
            html: icons.filePlus,
            title: '在此文件夹新建文件',
            attrs: { 'aria-label': `在 ${entry.name} 中新建文件` },
          })
          addFileBtn.addEventListener('click', event => {
            event.stopPropagation()
            this.promptCreate(false, entry.path)
          })
          const addFolderBtn = el('button', {
            className: 'yy-icon-btn yy-icon-btn-xs',
            type: 'button',
            html: icons.folderPlus,
            title: '在此文件夹新建子文件夹',
            attrs: { 'aria-label': `在 ${entry.name} 中新建文件夹` },
          })
          addFolderBtn.addEventListener('click', event => {
            event.stopPropagation()
            this.promptCreate(true, entry.path)
          })
          rowActions.append(addFileBtn, addFolderBtn)
        }

        const renameBtn = el('button', {
          className: 'yy-icon-btn yy-icon-btn-xs',
          type: 'button',
          html: icons.edit,
          title: '重命名',
          attrs: { 'aria-label': `重命名 ${entry.name}` },
        })
        renameBtn.addEventListener('click', event => {
          event.stopPropagation()
          this.promptRename(entry)
        })

        const trashBtn = el('button', {
          className: 'yy-icon-btn yy-icon-btn-xs yy-icon-btn-danger',
          type: 'button',
          html: icons.trash,
          title: '移入废纸篓',
          attrs: { 'aria-label': `将 ${entry.name} 移入废纸篓` },
        })
        trashBtn.addEventListener('click', event => {
          event.stopPropagation()
          this.promptTrash(entry)
        })

        rowActions.append(renameBtn, trashBtn)
        row.append(mainBtn, rowActions)
        itemWrap.append(row)

        if (isDir && isExpanded && entry.children) {
          const group = el('div', { className: 'yy-tree-children', attrs: { role: 'group' } })
          renderNodes(entry.children, depth + 1, group)
          itemWrap.append(group)
        }
        parentEl.append(itemWrap)
      }
    }

    renderNodes(this.entries, 0, this.treeContainer)
  }

  setOutline(outline: OutlineEntry[]) {
    this.outline = outline
    this.renderOutline()
  }

  private renderOutline() {
    this.outlineList.replaceChildren()
    const visible = this.outlineFilter
      ? this.outline.filter(item => item.title.toLowerCase().includes(this.outlineFilter))
      : this.outline

    if (visible.length === 0) {
      this.outlineList.append(
        el('div', {
          className: 'yy-empty-box',
          text: this.outline.length === 0 ? '当前文档暂无标题大纲' : '没有匹配的标题',
        }),
      )
      return
    }

    const minLevel = Math.min(...visible.map(item => item.level))
    for (const entry of visible) {
      const btn = el('button', {
        className: 'yy-outline-item',
        type: 'button',
        title: entry.title,
        attrs: { role: 'listitem', 'data-from': String(entry.from), 'data-level': String(entry.level) },
      })
      btn.style.paddingLeft = `${12 + Math.max(0, entry.level - minLevel) * 14}px`
      btn.append(
        el('span', { className: 'yy-outline-level', text: `H${entry.level}` }),
        el('span', { className: 'yy-outline-title', text: entry.title }),
      )
      btn.addEventListener('click', () => {
        this.options.dispatch({ type: 'outline', from: entry.from })
        this.options.onAfterNavigate()
      })
      this.outlineList.append(btn)
    }
  }

  setSearchResults(results: SearchResult[]) {
    this.searchResults = results
    this.renderSearchResults()
  }

  private renderSearchResults() {
    this.searchList.replaceChildren()
    const query = this.searchInput.value.trim()
    if (!query && this.searchResults.length === 0) {
      this.searchCountEl.textContent = '输入关键词跨文件搜索'
      return
    }
    this.searchCountEl.textContent = `找到 ${this.searchResults.length} 处匹配`
    if (this.searchResults.length === 0) {
      this.searchList.append(el('div', { className: 'yy-empty-box', text: '未找到匹配内容' }))
      return
    }

    for (const result of this.searchResults) {
      const item = el('button', {
        className: 'yy-search-item',
        type: 'button',
        attrs: { role: 'listitem', 'data-path': result.path, 'data-line': String(result.line) },
      })
      const head = el('div', { className: 'yy-search-item-head' })
      head.append(
        el('span', { className: 'yy-search-file', text: result.name }),
        el('span', { className: 'yy-search-line', text: `第 ${result.line} 行` }),
      )
      const preview = el('div', { className: 'yy-search-preview', text: result.preview })
      item.append(head, preview)
      item.addEventListener('click', () => {
        this.options.dispatch({ type: 'open-path', path: result.path, line: result.line })
        this.options.onAfterNavigate()
      })
      this.searchList.append(item)
    }
  }

  destroy() {
    if (this.searchTimer) clearTimeout(this.searchTimer)
  }
}
