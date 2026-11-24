import type {
  AiView,
  EditorFormat,
  ImageMode,
  McpView,
  OutlineEntry,
  SearchResult,
  Shell,
  ShellAction,
  ShellActions,
  ShellState,
  Theme,
  WorkspaceEntry,
} from '../contracts'
import { AiPanel } from './ai-panel'
import { ModalManager } from './dialogs'
import { FindBar } from './find-bar'
import { el, isEditableFormElement } from './helpers'
import { icons } from './icons'
import { LeftPanel, type LeftTab } from './left-panel'
import { McpPanel } from './mcp-panel'
import { MenuBar } from './menus'
import { ShortcutRegistry, detectMac, type ShortcutCommandId } from './shortcuts'
import './shell.css'

type RightTab = 'ai' | 'mcp'

const INITIAL_STATE: ShellState = {
  title: '未命名.md',
  path: null,
  dirty: false,
  mode: 'live',
  detail: '',
  words: 0,
  characters: 0,
  line: 1,
  column: 1,
  workspace: null,
  autosave: false,
  presentation: {
    focus: false,
    typewriter: false,
    spellcheck: false,
    readonly: false,
  },
}

const FORMAT_COMMANDS: Partial<Record<ShortcutCommandId, EditorFormat>> = {
  'format.bold': 'bold',
  'format.italic': 'italic',
  'format.underline': 'underline',
  'format.strike': 'strike',
  'format.inlineCode': 'inline-code',
  'format.link': 'link',
  'format.heading1': 'heading-1',
  'format.heading2': 'heading-2',
  'format.heading3': 'heading-3',
  'format.quote': 'quote',
  'format.codeBlock': 'code-block',
}

export function mountShell(root: HTMLElement, actions: ShellActions): Shell {
  const dispatch = (action: ShellAction) => {
    void actions.dispatch(action)
  }

  let state: ShellState = { ...INITIAL_STATE, presentation: { ...INITIAL_STATE.presentation } }
  let workspaceEntries: WorkspaceEntry[] = []
  let themes: Theme[] = []
  let activeThemeId = ''
  let imageMode: ImageMode = 'copy'
  let leftOpen = typeof window === 'undefined' ? true : window.innerWidth >= 920
  let rightOpen = false
  let rightTab: RightTab = 'ai'
  let aiHasPending = false
  let aiSuggestionId: string | null = null
  let aiSuggestionSource: 'ai' | 'mcp' | null = null
  let aiSuggestionTitle = ''
  let mcpProposals = 0
  let transientNotice = ''
  let noticeTimer: ReturnType<typeof setTimeout> | null = null

  const shortcuts = new ShortcutRegistry()
  const isMac = detectMac()

  // Append theme stylesheet after shell/editor styles so user themes win on #write & .document-theme,
  // while higher-specificity .yy-shell .yy-chrome rules keep UI chrome isolated.
  const themeStyle = document.createElement('style')
  themeStyle.dataset.yeyuTheme = 'true'
  document.head.append(themeStyle)

  // Root shell container
  const shellEl = el('div', {
    className: 'yy-shell',
    attrs: { 'data-mode': state.mode, 'data-focus': 'false', 'data-readonly': 'false' },
  })
  root.replaceChildren(shellEl)

  // Document scroll container & editorHost (editor core sets editorHost.id = 'write')
  const paperEl = el('main', {
    className: 'yy-paper document-theme',
    attrs: {
      'data-mode': state.mode,
      'data-focus': 'false',
      'data-typewriter': 'false',
      'data-spellcheck': 'false',
      'data-readonly': 'false',
      'data-editable': 'true',
      'aria-readonly': 'false',
      tabindex: '-1',
    },
  })
  const editorHost = el('div', { className: 'editor-host' })
  paperEl.append(editorHost)

  const focusEditor = () => {
    const editable = editorHost.querySelector<HTMLElement>('.cm-content, [contenteditable="true"]')
    if (editable) {
      editable.focus()
    } else if (editorHost.tabIndex >= 0) {
      editorHost.focus()
    } else {
      paperEl.focus()
    }
  }

  const showNotice = (message: string) => {
    transientNotice = message
    if (noticeTimer) clearTimeout(noticeTimer)
    renderStatusBar()
    noticeTimer = setTimeout(() => {
      transientNotice = ''
      noticeTimer = null
      renderStatusBar()
    }, 2400)
  }

  const modals = new ModalManager(shellEl, focusEditor)

  const openQuickOpen = () => {
    modals.openQuickOpen({
      entries: workspaceEntries,
      workspaceRoot: state.workspace,
      activePath: state.path,
      onSelect: path => dispatch({ type: 'open-path', path }),
      onOpenFolder: () => dispatch({ type: 'open-folder' }),
    })
  }

  const openShortcuts = () => {
    modals.openShortcutsModal(shortcuts)
  }

  const toggleLeftSidebar = (tab?: LeftTab) => {
    if (tab) {
      if (leftOpen && leftPanel.getTab() === tab) {
        leftOpen = false
      } else {
        leftOpen = true
        leftPanel.setTab(tab)
      }
    } else {
      leftOpen = !leftOpen
    }
    syncLayout()
  }

  const toggleRightPanel = (tab?: RightTab) => {
    if (tab) {
      if (rightOpen && rightTab === tab) {
        rightOpen = false
      } else {
        rightOpen = true
        rightTab = tab
      }
    } else {
      rightOpen = !rightOpen
    }
    syncLayout()
    if (rightOpen && rightTab === 'ai') aiPanel.focusInput()
  }

  const openRightTab = (tab: RightTab) => {
    rightOpen = true
    rightTab = tab
    syncLayout()
  }

  // Menus
  const menuBar = new MenuBar({
    dispatch,
    shortcuts,
    getState: () => state,
    getThemes: () => ({ themes, active: activeThemeId }),
    getImageMode: () => imageMode,
    setImageMode: mode => {
      imageMode = mode
    },
    onOpenQuickOpen: openQuickOpen,
    onOpenFind: replace => findBar.open(replace),
    onOpenWorkspaceSearch: () => {
      leftOpen = true
      syncLayout()
      leftPanel.focusSearch()
    },
    onOpenShortcuts: openShortcuts,
    onToggleLeftSidebar: toggleLeftSidebar,
    onToggleRightPanel: toggleRightPanel,
    isLeftOpen: () => leftOpen,
    isRightOpen: () => rightOpen,
    restoreEditorFocus: focusEditor,
  })

  // Topbar
  const topbar = el('header', { className: 'yy-topbar yy-chrome' })

  const topLeft = el('div', { className: 'yy-topbar-left' })
  const brand = el('div', { className: 'yy-brand', attrs: { 'aria-label': '页屿' } })
  brand.append(
    el('span', { className: 'yy-brand-mark', html: icons.brand }),
    el('span', { className: 'yy-brand-name', text: '页屿' }),
  )
  topLeft.append(brand, menuBar.element)

  const topCenter = el('div', { className: 'yy-topbar-center' })
  const titleBtn = el('button', {
    className: 'yy-doc-title-btn',
    type: 'button',
    title: '点击快速打开工作区文件',
    attrs: { 'aria-label': '当前文档，点击快速打开文件' },
  })
  const titleTextEl = el('span', { className: 'yy-doc-title-text', text: state.title })
  const dirtyDotEl = el('span', { className: 'yy-dirty-dot', title: '有未保存的更改', attrs: { hidden: '' } })
  const readonlyBadgeEl = el('span', {
    className: 'yy-badge is-readonly',
    text: '只读',
    attrs: { hidden: '' },
  })
  titleBtn.append(titleTextEl, dirtyDotEl, readonlyBadgeEl)
  titleBtn.addEventListener('click', openQuickOpen)
  topCenter.append(titleBtn)

  const topRight = el('div', { className: 'yy-topbar-right' })

  const leftToggleBtn = el('button', {
    className: 'yy-icon-btn',
    type: 'button',
    html: icons.sidebar,
    title: '显示 / 隐藏左侧栏',
    attrs: { 'aria-pressed': String(leftOpen), 'aria-label': '切换左侧导览栏', 'data-toggle': 'left' },
  })
  leftToggleBtn.addEventListener('click', () => toggleLeftSidebar())

  // Mode switch pill
  const modeGroup = el('div', { className: 'yy-mode-pill', attrs: { role: 'group', 'aria-label': '编辑模式' } })
  const liveModeBtn = el('button', {
    className: 'yy-mode-btn is-active',
    type: 'button',
    text: '实时',
    attrs: { 'aria-pressed': 'true', 'data-mode-btn': 'live' },
  })
  const sourceModeBtn = el('button', {
    className: 'yy-mode-btn',
    type: 'button',
    text: '源码',
    attrs: { 'aria-pressed': 'false', 'data-mode-btn': 'source' },
  })
  liveModeBtn.addEventListener('click', () => dispatch({ type: 'mode', mode: 'live' }))
  sourceModeBtn.addEventListener('click', () => dispatch({ type: 'mode', mode: 'source' }))
  modeGroup.append(liveModeBtn, sourceModeBtn)

  // Quick theme popover
  const themeWrap = el('div', { className: 'yy-popover-wrap' })
  const themeBtn = el('button', {
    className: 'yy-tool-btn',
    type: 'button',
    title: '切换或导入文档主题',
    attrs: { 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-toggle': 'theme-popover' },
  })
  const themeBtnLabel = el('span', { text: '主题' })
  themeBtn.append(el('span', { className: 'yy-icon', html: icons.palette }), themeBtnLabel)

  const themePopover = el('div', {
    className: 'yy-popover-panel',
    attrs: { role: 'menu', hidden: '' },
  })
  let themePopoverOpen = false
  const closeThemePopover = () => {
    if (!themePopoverOpen) return
    themePopoverOpen = false
    themePopover.setAttribute('hidden', '')
    themeBtn.setAttribute('aria-expanded', 'false')
  }
  const renderThemePopover = () => {
    themePopover.replaceChildren()
    themePopover.append(el('div', { className: 'yy-menu-heading', text: '文档主题' }))
    if (themes.length === 0) {
      themePopover.append(el('div', { className: 'yy-popover-empty', text: '当前使用默认纸墨样式' }))
    } else {
      for (const theme of themes) {
        const active = theme.id === activeThemeId
        const item = el('button', {
          className: `yy-menu-item${active ? ' is-selected' : ''}`,
          type: 'button',
          attrs: { role: 'menuitemradio', 'aria-checked': String(active), 'data-theme-id': theme.id },
        })
        item.append(
          el('span', { className: 'yy-menu-check', html: active ? icons.check : '' }),
          el('span', { className: 'yy-menu-label', text: theme.name }),
        )
        item.addEventListener('click', () => {
          closeThemePopover()
          dispatch({ type: 'theme', id: theme.id })
        })
        themePopover.append(item)
      }
    }
    themePopover.append(el('div', { className: 'yy-menu-sep', attrs: { role: 'separator' } }))
    const importBtn = el('button', { className: 'yy-menu-item', type: 'button', attrs: { role: 'menuitem' } })
    importBtn.append(
      el('span', { className: 'yy-menu-check', html: icons.plus }),
      el('span', { className: 'yy-menu-label', text: '导入本地主题 CSS…' }),
    )
    importBtn.addEventListener('click', () => {
      closeThemePopover()
      dispatch({ type: 'theme-import' })
    })
    themePopover.append(importBtn)
  }
  themeBtn.addEventListener('click', event => {
    event.stopPropagation()
    if (themePopoverOpen) {
      closeThemePopover()
    } else {
      themePopoverOpen = true
      renderThemePopover()
      themePopover.removeAttribute('hidden')
      themeBtn.setAttribute('aria-expanded', 'true')
    }
  })
  themeWrap.append(themeBtn, themePopover)

  // Right workbench triggers
  const aiToggleBtn = el('button', {
    className: 'yy-tool-btn',
    type: 'button',
    title: '打开 / 关闭 AI 写作助手',
    attrs: { 'aria-pressed': 'false', 'data-toggle': 'ai' },
  })
  const aiBadgeEl = el('span', { className: 'yy-pill-dot', attrs: { hidden: '' } })
  aiToggleBtn.append(el('span', { className: 'yy-icon', html: icons.sparkles }), el('span', { text: 'AI' }), aiBadgeEl)
  aiToggleBtn.addEventListener('click', () => toggleRightPanel('ai'))

  const mcpToggleBtn = el('button', {
    className: 'yy-tool-btn',
    type: 'button',
    title: '打开 / 关闭 MCP 连接与工具',
    attrs: { 'aria-pressed': 'false', 'data-toggle': 'mcp' },
  })
  const mcpCountEl = el('span', { className: 'yy-count-badge', attrs: { hidden: '' } })
  mcpToggleBtn.append(el('span', { className: 'yy-icon', html: icons.plug }), el('span', { text: 'MCP' }), mcpCountEl)
  mcpToggleBtn.addEventListener('click', () => toggleRightPanel('mcp'))

  const shortcutsBtn = el('button', {
    className: 'yy-icon-btn',
    type: 'button',
    html: icons.keyboard,
    title: '快捷键设置',
    attrs: { 'aria-label': '快捷键设置', 'data-toggle': 'shortcuts' },
  })
  shortcutsBtn.addEventListener('click', openShortcuts)

  topRight.append(leftToggleBtn, modeGroup, themeWrap, aiToggleBtn, mcpToggleBtn, shortcutsBtn)
  topbar.append(topLeft, topCenter, topRight)

  // Body 3-column layout
  const bodyEl = el('div', { className: 'yy-body' })

  const leftPanel = new LeftPanel({
    dispatch,
    modals,
    onAfterNavigate: focusEditor,
  })

  // Center writing stage
  const stageEl = el('div', { className: 'yy-stage' })
  const findBar = new FindBar({
    dispatch,
    onClose: focusEditor,
  })

  const readonlyBanner = el('div', {
    className: 'yy-stage-banner yy-chrome',
    attrs: { hidden: '', role: 'status' },
  })
  const readonlyMsg = el('span', { className: 'yy-row-gap' })
  readonlyMsg.append(el('span', { className: 'yy-icon', html: icons.lock }), el('span', { text: '当前处于只读保护模式，文档修改已锁定' }))
  const exitReadonlyBtn = el('button', { className: 'yy-btn yy-btn-xs', type: 'button', text: '切换为可编辑' })
  exitReadonlyBtn.addEventListener('click', () => {
    dispatch({ type: 'presentation', value: { ...state.presentation, readonly: false } })
  })
  readonlyBanner.append(readonlyMsg, exitReadonlyBtn)

  const suggestionBanner = el('div', {
    className: 'yy-stage-banner yy-stage-banner-accent yy-chrome',
    attrs: { hidden: '', role: 'status' },
  })
  const suggestionBannerText = el('span', { text: '' })
  const openSuggestionBtn = el('button', { className: 'yy-btn yy-btn-xs yy-btn-primary', type: 'button', text: '查看差异建议' })
  openSuggestionBtn.addEventListener('click', () => openRightTab('ai'))
  suggestionBanner.append(suggestionBannerText, openSuggestionBtn)

  stageEl.append(findBar.element, readonlyBanner, suggestionBanner, paperEl)

  // Drag & drop image files directly into writing sheet
  let dragDepth = 0
  paperEl.addEventListener('dragenter', event => {
    if (event.dataTransfer?.types.includes('Files')) {
      dragDepth++
      paperEl.classList.add('is-dragover')
    }
  })
  paperEl.addEventListener('dragover', event => {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault()
    }
  })
  paperEl.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) paperEl.classList.remove('is-dragover')
  })
  paperEl.addEventListener('drop', event => {
    dragDepth = 0
    paperEl.classList.remove('is-dragover')
    const files = Array.from(event.dataTransfer?.files ?? []).filter(file => file.type.startsWith('image/'))
    if (files.length > 0) {
      event.preventDefault()
      dispatch({ type: 'image-import', files })
    }
  })

  // Right workbench (AI + MCP)
  const rightPanel = el('aside', {
    className: 'yy-right-panel yy-chrome',
    attrs: { 'aria-label': 'AI 与 MCP 协作侧栏', hidden: '' },
  })
  const rightTabs = el('div', { className: 'yy-seg-tabs', attrs: { role: 'tablist', 'aria-label': '右侧栏视图' } })
  const rightAiTabBtn = el('button', {
    className: 'yy-seg-tab is-active',
    type: 'button',
    attrs: { role: 'tab', 'aria-selected': 'true', 'data-right-tab': 'ai' },
  })
  rightAiTabBtn.append(el('span', { className: 'yy-icon', html: icons.sparkles }), el('span', { text: 'AI 助手' }))
  rightAiTabBtn.addEventListener('click', () => openRightTab('ai'))

  const rightMcpTabBtn = el('button', {
    className: 'yy-seg-tab',
    type: 'button',
    attrs: { role: 'tab', 'aria-selected': 'false', 'data-right-tab': 'mcp' },
  })
  const rightMcpBadge = el('span', { className: 'yy-count-badge', attrs: { hidden: '' } })
  rightMcpTabBtn.append(el('span', { className: 'yy-icon', html: icons.plug }), el('span', { text: 'MCP 工具' }), rightMcpBadge)
  rightMcpTabBtn.addEventListener('click', () => openRightTab('mcp'))

  const closeRightBtn = el('button', {
    className: 'yy-icon-btn yy-icon-btn-sm',
    type: 'button',
    html: icons.close,
    title: '关闭右侧栏',
    attrs: { 'aria-label': '关闭右侧协作栏' },
  })
  closeRightBtn.addEventListener('click', () => {
    rightOpen = false
    syncLayout()
    focusEditor()
  })

  const rightHead = el('div', { className: 'yy-right-head' })
  rightTabs.append(rightAiTabBtn, rightMcpTabBtn)
  rightHead.append(rightTabs, closeRightBtn)

  const aiPanel = new AiPanel({
    dispatch,
    onSuggestionFocus: () => {
      syncSuggestionBanner()
    },
  })
  const mcpPanel = new McpPanel({
    dispatch,
    onNotify: showNotice,
  })
  rightPanel.append(rightHead, aiPanel.element, mcpPanel.element)

  bodyEl.append(leftPanel.element, stageEl, rightPanel)

  // Bottom Status Bar
  const statusBar = el('footer', { className: 'yy-statusbar yy-chrome' })
  const statusDetailEl = el('div', { className: 'yy-status-detail', attrs: { 'aria-live': 'polite' } })

  const statusCenter = el('div', { className: 'yy-status-toggles' })
  const makeStatusToggle = (label: string, attrName: string, onClick: () => void) => {
    const btn = el('button', {
      className: 'yy-status-chip',
      type: 'button',
      text: label,
      attrs: { 'aria-pressed': 'false', 'data-status-toggle': attrName },
    })
    btn.addEventListener('click', onClick)
    return btn
  }

  const autosaveChip = makeStatusToggle('自动保存', 'autosave', () => {
    dispatch({ type: 'autosave', enabled: !state.autosave })
  })
  const focusChip = makeStatusToggle('专注', 'focus', () => {
    dispatch({ type: 'presentation', value: { ...state.presentation, focus: !state.presentation.focus } })
  })
  const typewriterChip = makeStatusToggle('打字机', 'typewriter', () => {
    dispatch({ type: 'presentation', value: { ...state.presentation, typewriter: !state.presentation.typewriter } })
  })
  const spellcheckChip = makeStatusToggle('拼写', 'spellcheck', () => {
    dispatch({ type: 'presentation', value: { ...state.presentation, spellcheck: !state.presentation.spellcheck } })
  })
  const readonlyChip = makeStatusToggle('只读', 'readonly', () => {
    dispatch({ type: 'presentation', value: { ...state.presentation, readonly: !state.presentation.readonly } })
  })
  statusCenter.append(autosaveChip, focusChip, typewriterChip, spellcheckChip, readonlyChip)

  const statusRight = el('div', { className: 'yy-status-metrics' })
  const cursorPosEl = el('span', { className: 'yy-status-metric', text: '行 1 · 列 1' })
  const countEl = el('span', { className: 'yy-status-metric', text: '0 词 · 0 字符' })
  const activeThemeChip = el('button', {
    className: 'yy-status-chip',
    type: 'button',
    text: '默认纸墨',
    title: '点击切换主题',
  })
  activeThemeChip.addEventListener('click', event => {
    event.stopPropagation()
    themeBtn.click()
  })
  statusRight.append(cursorPosEl, countEl, activeThemeChip)

  statusBar.append(statusDetailEl, statusCenter, statusRight)
  shellEl.append(topbar, bodyEl, statusBar)

  function syncSuggestionBanner() {
    const showBanner = Boolean(aiSuggestionSource) && (!rightOpen || rightTab !== 'ai')
    suggestionBanner.toggleAttribute('hidden', !showBanner)
    if (showBanner) {
      const prefix = aiSuggestionSource === 'mcp' ? '收到 MCP 差异建议' : 'AI 已生成差异建议'
      suggestionBannerText.textContent = aiSuggestionTitle ? `${prefix}：${aiSuggestionTitle}` : prefix
    }
  }

  function syncLayout() {
    leftPanel.element.toggleAttribute('hidden', !leftOpen)
    leftToggleBtn.classList.toggle('is-active', leftOpen)
    leftToggleBtn.setAttribute('aria-pressed', String(leftOpen))

    rightPanel.toggleAttribute('hidden', !rightOpen)
    aiPanel.element.toggleAttribute('hidden', rightTab !== 'ai')
    mcpPanel.element.toggleAttribute('hidden', rightTab !== 'mcp')

    rightAiTabBtn.classList.toggle('is-active', rightTab === 'ai')
    rightAiTabBtn.setAttribute('aria-selected', String(rightTab === 'ai'))
    rightMcpTabBtn.classList.toggle('is-active', rightTab === 'mcp')
    rightMcpTabBtn.setAttribute('aria-selected', String(rightTab === 'mcp'))

    aiToggleBtn.classList.toggle('is-active', rightOpen && rightTab === 'ai')
    aiToggleBtn.setAttribute('aria-pressed', String(rightOpen && rightTab === 'ai'))
    mcpToggleBtn.classList.toggle('is-active', rightOpen && rightTab === 'mcp')
    mcpToggleBtn.setAttribute('aria-pressed', String(rightOpen && rightTab === 'mcp'))

    aiBadgeEl.toggleAttribute('hidden', !aiHasPending && !aiSuggestionSource)
    mcpCountEl.textContent = String(mcpProposals)
    mcpCountEl.toggleAttribute('hidden', mcpProposals <= 0)
    rightMcpBadge.textContent = String(mcpProposals)
    rightMcpBadge.toggleAttribute('hidden', mcpProposals <= 0)

    syncSuggestionBanner()
  }

  function renderStatusBar() {
    const modeText = state.mode === 'source' ? '源码模式' : '实时编辑'
    statusDetailEl.textContent = transientNotice || state.detail || modeText
    cursorPosEl.textContent = `行 ${state.line} · 列 ${state.column}`
    countEl.textContent = `${state.words} 词 · ${state.characters} 字符`

    const syncChip = (btn: HTMLButtonElement, active: boolean) => {
      btn.classList.toggle('is-active', active)
      btn.setAttribute('aria-pressed', String(active))
    }
    syncChip(autosaveChip, state.autosave)
    syncChip(focusChip, state.presentation.focus)
    syncChip(typewriterChip, state.presentation.typewriter)
    syncChip(spellcheckChip, state.presentation.spellcheck)
    syncChip(readonlyChip, Boolean(state.presentation.readonly))
  }

  function applyState(next: ShellState) {
    state = { ...next, presentation: { ...next.presentation } }
    const isReadonly = Boolean(state.presentation.readonly)

    shellEl.dataset.mode = state.mode
    shellEl.dataset.focus = String(state.presentation.focus)
    shellEl.dataset.readonly = String(isReadonly)

    // Update editable document scroll container attributes
    paperEl.dataset.mode = state.mode
    paperEl.dataset.focus = String(state.presentation.focus)
    paperEl.dataset.typewriter = String(state.presentation.typewriter)
    paperEl.dataset.spellcheck = String(state.presentation.spellcheck)
    paperEl.dataset.readonly = String(isReadonly)
    paperEl.dataset.editable = String(!isReadonly)
    paperEl.setAttribute('aria-readonly', String(isReadonly))

    titleTextEl.textContent = state.title
    titleBtn.title = state.path ? `${state.path}（点击快速打开）` : '点击快速打开工作区文件'
    dirtyDotEl.toggleAttribute('hidden', !state.dirty)
    readonlyBadgeEl.toggleAttribute('hidden', !isReadonly)
    readonlyBanner.toggleAttribute('hidden', !isReadonly)

    liveModeBtn.classList.toggle('is-active', state.mode === 'live')
    liveModeBtn.setAttribute('aria-pressed', String(state.mode === 'live'))
    sourceModeBtn.classList.toggle('is-active', state.mode === 'source')
    sourceModeBtn.setAttribute('aria-pressed', String(state.mode === 'source'))

    leftPanel.setContextState(state.workspace, state.path)
    renderStatusBar()
  }

  function executeCommand(id: ShortcutCommandId) {
    const format = FORMAT_COMMANDS[id]
    if (format) {
      dispatch({ type: 'format', format })
      return
    }
    switch (id) {
      case 'file.new': dispatch({ type: 'new' }); break
      case 'file.open': dispatch({ type: 'open' }); break
      case 'file.openFolder': dispatch({ type: 'open-folder' }); break
      case 'file.save': dispatch({ type: 'save' }); break
      case 'file.saveAs': dispatch({ type: 'save-as' }); break
      case 'file.exportAgain': dispatch({ type: 'export-again' }); break
      case 'file.print': dispatch({ type: 'print' }); break
      case 'nav.quickOpen': openQuickOpen(); break
      case 'nav.find': findBar.open(false); break
      case 'nav.replace': findBar.open(true); break
      case 'nav.searchWorkspace':
        leftOpen = true
        syncLayout()
        leftPanel.focusSearch()
        break
      case 'view.toggleMode':
        dispatch({ type: 'mode', mode: state.mode === 'source' ? 'live' : 'source' })
        break
      case 'view.toggleSidebar':
        toggleLeftSidebar()
        break
      case 'view.toggleOutline':
        toggleLeftSidebar('outline')
        break
      case 'view.toggleAI':
        toggleRightPanel('ai')
        break
      case 'view.toggleMcp':
        toggleRightPanel('mcp')
        break
      case 'view.toggleFocus':
        dispatch({ type: 'presentation', value: { ...state.presentation, focus: !state.presentation.focus } })
        break
      case 'view.toggleTypewriter':
        dispatch({ type: 'presentation', value: { ...state.presentation, typewriter: !state.presentation.typewriter } })
        break
      case 'view.toggleReadonly':
        dispatch({ type: 'presentation', value: { ...state.presentation, readonly: !state.presentation.readonly } })
        break
      case 'edit.pastePlain':
        dispatch({ type: 'paste-plain' })
        break
      case 'settings.shortcuts':
        openShortcuts()
        break
    }
  }

  const onWindowKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
    if (modals.isOpen) return

    const matched = shortcuts.match(event, isEditableFormElement(event.target), isMac)
    if (!matched) return
    event.preventDefault()
    menuBar.close(false)
    closeThemePopover()
    executeCommand(matched.id)
  }

  const onDocMouseDown = (event: MouseEvent) => {
    if (!themePopoverOpen) return
    if (event.target instanceof Node && themeWrap.contains(event.target)) return
    closeThemePopover()
  }

  window.addEventListener('keydown', onWindowKeyDown)
  document.addEventListener('mousedown', onDocMouseDown)

  syncLayout()
  applyState(state)

  return {
    editorHost,

    setState(nextState: ShellState) {
      applyState(nextState)
    },

    setOutline(outline: OutlineEntry[]) {
      leftPanel.setOutline(outline)
    },

    setWorkspace(entries: WorkspaceEntry[]) {
      workspaceEntries = entries
      leftPanel.setWorkspace(entries)
    },

    setSearchResults(results: SearchResult[]) {
      leftPanel.setSearchResults(results)
    },

    setThemes(nextThemes: Theme[], active: string) {
      themes = nextThemes
      activeThemeId = active
      const current = themes.find(theme => theme.id === active)
      themeStyle.textContent = current ? current.styles.join('\n') : ''
      const activeName = current?.name ?? '默认纸墨'
      themeBtnLabel.textContent = current ? current.name : '主题'
      activeThemeChip.textContent = activeName
      if (themePopoverOpen) renderThemePopover()
    },

    setAI(view: AiView) {
      const prevId = aiSuggestionId
      aiHasPending = view.pending
      aiSuggestionId = view.suggestion?.id ?? null
      aiSuggestionSource = view.suggestion?.source ?? null
      aiSuggestionTitle = view.suggestion?.title ?? ''
      aiPanel.setView(view)
      if (view.suggestion && view.suggestion.id !== prevId && view.suggestion.source === 'mcp') {
        rightOpen = true
        rightTab = 'ai'
      }
      syncLayout()
    },

    setMcp(view: McpView) {
      mcpProposals = view.proposals
      mcpPanel.setView(view)
      syncLayout()
    },

    destroy() {
      if (noticeTimer) clearTimeout(noticeTimer)
      window.removeEventListener('keydown', onWindowKeyDown)
      document.removeEventListener('mousedown', onDocMouseDown)
      menuBar.destroy()
      leftPanel.destroy()
      modals.destroy()
      themeStyle.remove()
      root.replaceChildren()
    },
  }
}
