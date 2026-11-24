import { existsSync } from 'node:fs'
import { platform } from 'node:os'
import { chromium, type Browser, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const browserPath = process.env.YEYU_CHROME || (platform() === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : '/usr/bin/chromium')

const hasBrowser = existsSync(browserPath)

describe.skipIf(!hasBrowser)('页屿桌面界面浏览器集成验证', () => {
  let server: ViteDevServer
  let browser: Browser
  let page: Page
  let baseUrl = ''

  beforeAll(async () => {
    server = await createServer({
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      logLevel: 'silent',
    })
    await server.listen()
    const addr = server.httpServer?.address()
    const port = typeof addr === 'object' && addr ? addr.port : 1420
    baseUrl = `http://127.0.0.1:${port}`
    browser = await chromium.launch({ executablePath: browserPath, headless: true })
    page = await browser.newPage({ viewport: { width: 1360, height: 860 } })
    await page.route(`${baseUrl}/__ui_harness__`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><div id="app"></div></body></html>',
      })
    })
  }, 30000)

  afterAll(async () => {
    await browser?.close()
    await server?.close()
  })

  async function mountTestHarness() {
    await page.goto(`${baseUrl}/__ui_harness__`, { waitUntil: 'domcontentloaded' })
    await page.evaluate(`(async () => {
      localStorage.clear()
      const { mountShell } = await import('/src/ui/index.ts')
      const { createEditor } = await import('/src/editor/index.ts')
      const root = document.getElementById('app')
      const actions = []
      const shell = mountShell(root, {
        dispatch(action) {
          actions.push(action)
        },
      })
      const editor = createEditor(shell.editorHost, {
        onChange() {},
        onSelectionChange() {},
      })
      editor.setMarkdown('# 页屿测试文档\\n\\n第一段正文。\\n\\n## 二级标题\\n\\n第二段正文。\\n')
      window.__test = { shell, editor, actions }
    })()`)
  }

  it('默认主题用系统外观并可从导入主题切回', async () => {
    await mountTestHarness()
    await page.emulateMedia({ colorScheme: 'light' })
    await page.evaluate(() => (window as unknown as Record<string, any>).__test.shell.setThemes([
      { id: 'dark', name: '测试深色', styles: ['.document-theme { --bg-color: #181a20; --text-color: #e4e8ee; }'] },
    ], 'dark'))
    const paper = page.locator('.document-theme')
    expect(await paper.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(24, 26, 32)')
    await page.locator('[data-toggle="theme-popover"]').click()
    await page.getByRole('menuitemradio', { name: '默认', exact: true }).click()
    expect(await page.evaluate(() => (window as unknown as Record<string, any>).__test.actions.at(-1))).toEqual({ type: 'theme', id: 'default' })
    await page.evaluate(() => (window as unknown as Record<string, any>).__test.shell.setThemes([], 'default'))
    expect(await paper.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(255, 255, 255)')
    expect(await paper.evaluate(element => getComputedStyle(element).color)).toBe('rgb(34, 34, 34)')
    const editorFont = paper.locator('.cm-scroller')
    expect(await editorFont.evaluate(element => getComputedStyle(element).fontFamily)).not.toContain('monospace')
    await page.evaluate(() => (window as unknown as Record<string, any>).__test.editor.setMode('source'))
    expect(await editorFont.evaluate(element => getComputedStyle(element).fontFamily)).toContain('monospace')
    expect(await page.locator('.yy-seg-tab.is-active').first().evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(237, 237, 237)')
    await page.emulateMedia({ colorScheme: 'dark' })
    expect(await paper.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(32, 32, 32)')
    await page.emulateMedia({ colorScheme: 'light' })
  })

  it('挂载外壳、文档容器状态、主题作用域隔离与切换', async () => {
    await mountTestHarness()

    const result = await page.evaluate(() => {
      const { shell, actions } = (window as unknown as Record<string, any>).__test
      shell.setState({
        title: '设计稿.md',
        path: '/ws/设计稿.md',
        dirty: true,
        mode: 'live',
        detail: '已同步',
        words: 128,
        characters: 512,
        line: 4,
        column: 9,
        workspace: '/ws',
        autosave: true,
        presentation: { focus: true, typewriter: true, spellcheck: true, readonly: true },
      })

      shell.setThemes([
        {
          id: 'warm-ink',
          name: '墨绿纸张',
          styles: [
            // Scoped theme styling for document container and #write
            '.document-theme { background-color: rgb(250, 245, 232); }',
            '#write { color: rgb(22, 91, 76); }',
            // Adversarial global button rule that must NOT break .yy-chrome buttons
            'button { background: rgb(255, 0, 0); color: rgb(255, 255, 0); }',
          ],
        },
        {
          id: 'night-pine',
          name: '夜松',
          styles: ['.document-theme { background-color: rgb(24, 32, 30); }'],
        },
      ], 'warm-ink')

      const paper = document.querySelector<HTMLElement>('.yy-paper.document-theme')!
      const write = document.querySelector<HTMLElement>('#write')!
      const modeBtn = document.querySelector<HTMLElement>('.yy-topbar .yy-btn, .yy-topbar .yy-tool-btn')!
      return {
        hasWriteInsideDocumentTheme: paper.contains(write),
        paperEditable: paper.dataset.editable,
        paperReadonly: paper.dataset.readonly,
        paperAriaReadonly: paper.getAttribute('aria-readonly'),
        paperBg: getComputedStyle(paper).backgroundColor,
        writeColor: getComputedStyle(write).color,
        chromeBtnBg: getComputedStyle(modeBtn).backgroundColor,
        title: document.querySelector('.yy-doc-title-text')?.textContent,
        dirtyVisible: !document.querySelector('.yy-dirty-dot')?.hasAttribute('hidden'),
        statusText: document.querySelector('.yy-status-detail')?.textContent,
        actionsCount: actions.length,
      }
    })

    expect(result.hasWriteInsideDocumentTheme).toBe(true)
    expect(result.paperEditable).toBe('false')
    expect(result.paperReadonly).toBe('true')
    expect(result.paperAriaReadonly).toBe('true')
    expect(result.paperBg).toBe('rgb(250, 245, 232)')
    expect(result.writeColor).toBe('rgb(22, 91, 76)')
    expect(result.chromeBtnBg).not.toBe('rgb(255, 0, 0)')
    expect(result.title).toBe('设计稿.md')
    expect(result.dirtyVisible).toBe(true)
    expect(result.statusText).toBe('已同步')

    // Switch theme via theme popover
    await page.click('[data-toggle="theme-popover"]')
    await page.click('[data-theme-id="night-pine"]')

    const dispatched = await page.evaluate(() => (window as unknown as Record<string, any>).__test.actions)
    expect(dispatched).toContainEqual({ type: 'theme', id: 'night-pine' })
  })

  it('文件树增删改、快速打开、大纲、跨文件检索与文内查找替换', async () => {
    await mountTestHarness()

    await page.evaluate(() => {
      const { shell } = (window as unknown as Record<string, any>).__test
      shell.setState({
        title: 'guide.md',
        path: '/ws/docs/guide.md',
        dirty: false,
        mode: 'live',
        detail: '',
        words: 10,
        characters: 30,
        line: 1,
        column: 1,
        workspace: '/ws',
        autosave: false,
        presentation: { focus: false, typewriter: false, spellcheck: false, readonly: false },
      })
      shell.setWorkspace([
        {
          path: '/ws/docs',
          name: 'docs',
          children: [
            { path: '/ws/docs/guide.md', name: 'guide.md' },
            { path: '/ws/docs/notes.md', name: 'notes.md' },
          ],
        },
        { path: '/ws/README.md', name: 'README.md' },
      ])
      shell.setOutline([
        { level: 1, title: '页屿测试文档', from: 0 },
        { level: 2, title: '二级标题', from: 18 },
      ])
      shell.setSearchResults([
        { path: '/ws/docs/notes.md', name: 'notes.md', line: 7, preview: '包含页屿关键字的段落' },
      ])
    })

    // Expand folder and open notes.md
    await page.click('[data-path="/ws/docs"] .yy-tree-main')
    await page.click('[data-path="/ws/docs/notes.md"] .yy-tree-main')

    // Create a file in workspace
    await page.click('[aria-label="新建文件"]')
    await page.fill('.yy-modal-prompt input', '草稿')
    await page.click('.yy-modal-prompt button[type="submit"]')

    // Rename README.md
    await page.click('[aria-label="重命名 README.md"]')
    await page.fill('.yy-modal-prompt input', 'INDEX.md')
    await page.click('.yy-modal-prompt button[type="submit"]')

    // Move README.md to trash with confirmation dialog
    await page.click('[aria-label="将 README.md 移入废纸篓"]')
    await page.click('.yy-modal-prompt .yy-btn-danger')

    // Quick Open via title button + keyboard Enter
    await page.click('.yy-doc-title-btn')
    await page.fill('.yy-quickopen-input', 'guide')
    await page.keyboard.press('Enter')

    // Outline jump
    await page.click('[data-left-tab="outline"]')
    await page.click('.yy-outline-item[data-from="18"]')

    // Workspace search + jump
    await page.click('[data-left-tab="search"]')
    await page.click('[aria-label="切换正则检索"]')
    await page.fill('[aria-label="跨文件检索关键词"]', '页屿.*段落')
    await page.click('.yy-search-form button[type="submit"]')
    await page.click('.yy-search-item[data-line="7"]')

    // Find & Replace via keyboard + Escape restores focus to editor
    const modKey = platform() === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${modKey}+h`)
    await page.fill('.yy-find-input[aria-label="查找文本"]', '正文')
    await page.fill('.yy-find-input[aria-label="替换文本"]', '内容')
    await page.click('[aria-label="区分大小写"]')
    await page.keyboard.press('Enter')
    await page.click('.yy-replace-row button:has-text("全部替换")')
    await page.keyboard.press('Escape')

    const { actions, findHidden, focusInEditor } = await page.evaluate(() => {
      const testObj = (window as unknown as Record<string, any>).__test
      return {
        actions: testObj.actions,
        findHidden: document.querySelector('.yy-findbar')?.hasAttribute('hidden'),
        focusInEditor: Boolean(document.activeElement?.closest('#write, .yy-paper')),
      }
    })

    expect(findHidden).toBe(true)
    expect(focusInEditor).toBe(true)
    expect(actions).toContainEqual({ type: 'open-path', path: '/ws/docs/notes.md' })
    expect(actions).toContainEqual({ type: 'workspace-create', parent: '/ws/docs', name: '草稿.md', folder: false })
    expect(actions).toContainEqual({ type: 'workspace-rename', path: '/ws/README.md', name: 'INDEX.md' })
    expect(actions).toContainEqual({ type: 'workspace-trash', path: '/ws/README.md' })
    expect(actions).toContainEqual({ type: 'open-path', path: '/ws/docs/guide.md' })
    expect(actions).toContainEqual({ type: 'outline', from: 18 })
    expect(actions).toContainEqual({ type: 'search-workspace', text: '页屿.*段落', regex: true })
    expect(actions).toContainEqual({ type: 'open-path', path: '/ws/docs/notes.md', line: 7 })
    expect(actions).toContainEqual({
      type: 'find',
      query: { text: '正文', replacement: '内容', regex: false, matchCase: true, wholeWord: false },
      operation: 'next',
    })
    expect(actions).toContainEqual({
      type: 'find',
      query: { text: '正文', replacement: '内容', regex: false, matchCase: true, wholeWord: false },
      operation: 'replace-all',
    })

    // Menus: File -> Export PDF, Format -> Table, View -> Autosave / Presentation
    await page.click('[data-menu="file"]')
    await page.click('.yy-submenu-trigger:has-text("导出为")')
    await page.click('.yy-submenu-panel .yy-menu-item:has-text("PDF 文档")')

    await page.click('[data-menu="format"]')
    await page.click('.yy-menu-popover .yy-menu-item:has-text("表格")')

    await page.click('[data-status-toggle="autosave"]')
    await page.click('[data-status-toggle="typewriter"]')

    const menuActions = await page.evaluate(() => (window as unknown as Record<string, any>).__test.actions)
    expect(menuActions).toContainEqual({ type: 'export', format: 'pdf' })
    expect(menuActions).toContainEqual({ type: 'format', format: 'table' })
    expect(menuActions).toContainEqual({ type: 'autosave', enabled: true })
    expect(menuActions).toContainEqual({
      type: 'presentation',
      value: { focus: false, typewriter: true, spellcheck: false, readonly: false },
    })
  })

  it('AI 侧栏配置、上下文全文预览、九类操作、取消重试与差异全部/逐段应用', async () => {
    await mountTestHarness()

    const fullContextText = '第一行上下文\n' + '超长全文预览内容不会被截断。'.repeat(12)
    await page.click('[data-toggle="ai"]')

    // Configure endpoint, model, optional key
    await page.click('.yy-ai-pane button:has-text("接口配置")')
    await page.fill('.yy-config-card input[type="url"]', 'https://api.example.com/v1')
    await page.fill('.yy-config-card input[type="text"]', 'qwen-plus')
    await page.fill('.yy-config-card input[type="password"]', 'sk-test-123')
    await page.click('.yy-config-card button[type="submit"]')

    // Pick context scope & push full context + diff suggestion
    await page.click('[data-ai-scope="document"]')
    await page.evaluate(text => {
      const { shell } = (window as unknown as Record<string, any>).__test
      shell.setAI({
        settings: { endpoint: 'https://api.example.com/v1', model: 'qwen-plus', hasKey: true },
        context: { scope: 'document', label: '设计稿.md', text },
        messages: [{ role: 'user', text: '请润色两处表述' }],
        stream: '正在输出建议…',
        pending: true,
        error: '',
        canRetry: false,
        suggestion: {
          id: 'sug-1',
          title: '润色两段正文',
          source: 'ai',
          hunks: 2,
          parts: [
            { kind: 'keep', text: '# 标题\n' },
            { kind: 'remove', text: '原始段落一', hunk: 0 },
            { kind: 'add', text: '润色段落一', hunk: 0 },
            { kind: 'keep', text: '\n间隔\n' },
            { kind: 'remove', text: '原始段落二', hunk: 1 },
            { kind: 'add', text: '润色段落二', hunk: 1 },
          ],
        },
      })
    }, fullContextText)

    // Verify all 9 intents exist and context full text is rendered completely
    const aiCheck = await page.evaluate(() => ({
      intentCount: document.querySelectorAll('[data-ai-intent]').length,
      previewText: document.querySelector('.yy-context-fulltext')?.textContent,
    }))
    expect(aiCheck.intentCount).toBe(9)
    expect(aiCheck.previewText).toBe(fullContextText)

    // Cancel while pending
    await page.click('.yy-ai-composer button:has-text("取消")')

    // Switch to retryable non-pending state, send a polish intent, and test per-hunk & all diff apply
    await page.evaluate(() => {
      const { shell } = (window as unknown as Record<string, any>).__test
      shell.setAI({
        settings: { endpoint: 'https://api.example.com/v1', model: 'qwen-plus', hasKey: true },
        context: null,
        messages: [{ role: 'user', text: '润色' }],
        stream: '',
        pending: false,
        error: '',
        canRetry: true,
        suggestion: {
          id: 'sug-1',
          title: '润色两段正文',
          source: 'ai',
          hunks: 2,
          parts: [
            { kind: 'remove', text: '原始段落一', hunk: 0 },
            { kind: 'add', text: '润色段落一', hunk: 0 },
            { kind: 'remove', text: '原始段落二', hunk: 1 },
            { kind: 'add', text: '润色段落二', hunk: 1 },
          ],
        },
      })
    })

    await page.click('.yy-ai-composer button:has-text("重试")')
    await page.click('[data-ai-intent="translate"]')
    await page.fill('.yy-ai-composer textarea', '翻译为英文')
    await page.click('.yy-ai-composer button[type="submit"]')

    // Apply single hunk #1, then apply all, then dismiss
    await page.click('[data-apply-hunk="1"]')
    await page.click('[data-suggestion-action="apply-all"]')
    await page.click('[data-suggestion-action="dismiss"]')

    const actions = await page.evaluate(() => (window as unknown as Record<string, any>).__test.actions)
    expect(actions).toContainEqual({
      type: 'ai-config',
      endpoint: 'https://api.example.com/v1',
      model: 'qwen-plus',
      key: 'sk-test-123',
    })
    expect(actions).toContainEqual({ type: 'ai-context', scope: 'document' })
    expect(actions).toContainEqual({ type: 'ai-cancel' })
    expect(actions).toContainEqual({ type: 'ai-retry' })
    expect(actions).toContainEqual({ type: 'ai-send', intent: 'translate', prompt: '翻译为英文' })
    expect(actions).toContainEqual({ type: 'suggestion-apply', id: 'sug-1', hunks: [1] })
    expect(actions).toContainEqual({ type: 'suggestion-apply', id: 'sug-1', hunks: [0, 1] })
    expect(actions).toContainEqual({ type: 'suggestion-dismiss', id: 'sug-1' })
  })

  it('MCP 侧栏 stdio/HTTP 配置、调用前参数预览与显式许可、授权与待审建议', async () => {
    await mountTestHarness()

    await page.click('[data-toggle="mcp"]')

    // Add stdio server
    await page.click('[data-mcp-action="toggle-form"]')
    await page.fill('.yy-mcp-pane .yy-config-card input[placeholder*="本地知识库"]', '本地文档服务')
    await page.fill('.yy-mcp-pane .yy-config-card input[placeholder*="docs-mcp"]', 'local-docs')
    await page.fill('.yy-mcp-pane .yy-config-card input[placeholder*="npx"]', 'npx')
    await page.fill('.yy-mcp-pane .yy-config-card input[placeholder*="server-filesystem"]', '-y @mcp/docs "./my notes"')
    await page.click('.yy-mcp-pane .yy-config-card button[type="submit"]')

    // Add HTTP server
    await page.click('[data-mcp-action="toggle-form"]')
    await page.click('[data-transport="http"]')
    await page.fill('.yy-mcp-pane .yy-config-card input[placeholder*="本地知识库"]', '远端检索')
    await page.fill('.yy-mcp-pane .yy-config-card input[placeholder*="docs-mcp"]', 'remote-http')
    await page.fill('.yy-mcp-pane .yy-config-card input[type="url"]', 'http://127.0.0.1:8787/mcp')
    await page.click('.yy-mcp-pane .yy-config-card button[type="submit"]')

    // Push connected MCP view with tools/resources/prompts + command + proposals
    await page.evaluate(() => {
      const { shell } = (window as unknown as Record<string, any>).__test
      shell.setMcp({
        workspaceAllowed: false,
        command: 'yeyu-mcp --workspace /ws',
        proposals: 2,
        result: '{"ok":true}',
        error: '',
        connections: [
          {
            server: { id: 'local-docs', name: '本地文档服务', transport: 'stdio', command: 'npx', args: ['-y', '@mcp/docs'] },
            status: 'connected',
            items: [
              {
                kind: 'tool',
                name: 'search_notes',
                title: '检索笔记',
                description: '按关键字检索笔记',
                schema: { type: 'object', properties: { keyword: { type: 'string', default: '页屿' } } },
              },
              { kind: 'resource', name: 'doc://readme', title: '说明文档' },
              { kind: 'prompt', name: 'summarize_doc', title: '总结模板' },
            ],
          },
        ],
      })
    })

    // Authorize workspace & open pending proposals
    await page.click('[data-mcp-action="authorize"]')
    await page.click('[data-mcp-action="open-proposal"]')

    // Select tool -> verify pre-call parameter preview & explicit consent gate
    await page.click('[data-mcp-item="search_notes"] button')
    const beforeConsent = await page.evaluate(() => ({
      disabled: (document.querySelector('[data-mcp-action="confirm-call"]') as HTMLButtonElement).disabled,
      preview: document.querySelector('.yy-args-preview')?.textContent,
    }))
    expect(beforeConsent.disabled).toBe(true)
    expect(beforeConsent.preview).toContain('"keyword": "页屿"')

    // Edit args, verify explicit consent required, check consent, execute
    await page.fill('[aria-label="MCP 调用参数 JSON"]', '{"keyword":"架构","limit":3}')
    await page.check('[data-mcp-consent="true"]')
    await page.click('[data-mcp-action="confirm-call"]')

    const actions = await page.evaluate(() => (window as unknown as Record<string, any>).__test.actions)
    expect(actions).toContainEqual({
      type: 'mcp-config',
      server: { id: 'local-docs', name: '本地文档服务', transport: 'stdio', command: 'npx', args: ['-y', '@mcp/docs', './my notes'] },
    })
    expect(actions).toContainEqual({
      type: 'mcp-config',
      server: { id: 'remote-http', name: '远端检索', transport: 'http', url: 'http://127.0.0.1:8787/mcp' },
    })
    expect(actions).toContainEqual({ type: 'mcp-authorize', allow: true })
    expect(actions).toContainEqual({ type: 'mcp-next' })
    expect(actions).toContainEqual({
      type: 'mcp-call',
      id: 'local-docs',
      item: {
        kind: 'tool',
        name: 'search_notes',
        title: '检索笔记',
        description: '按关键字检索笔记',
        schema: { type: 'object', properties: { keyword: { type: 'string', default: '页屿' } } },
      },
      args: { keyword: '架构', limit: 3 },
    })
  })

  it('可配置快捷键录制、表单输入保护与 destroy 清理', async () => {
    await mountTestHarness()
    const modKey = platform() === 'darwin' ? 'Meta' : 'Control'

    // Record custom shortcut for file.save (Mod+Alt+S)
    await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
    await page.getByRole('menuitem', { name: /快捷键设置/ }).click()
    await page.click('[data-shortcut-id="file.save"]')
    await page.keyboard.press(`${modKey}+Alt+s`)
    await page.keyboard.press('Escape')

    // Trigger custom shortcut
    await page.keyboard.press(`${modKey}+Alt+s`)

    // Format shortcut inside AI textarea must NOT fire format.bold
    await page.click('[data-toggle="ai"]')
    await page.focus('.yy-ai-composer textarea')
    await page.keyboard.press(`${modKey}+b`)

    // Format shortcut inside editor DOES fire format.bold
    await page.evaluate(() => {
      const { editor } = (window as unknown as Record<string, any>).__test
      editor.focus()
    })
    await page.keyboard.press(`${modKey}+b`)

    // Destroy shell and verify listeners/styles are removed
    const summary = await page.evaluate(() => {
      const { shell, actions } = (window as unknown as Record<string, any>).__test
      const countBeforeDestroy = actions.length
      const stored = localStorage.getItem('yeyu.shortcuts.v1')
      shell.destroy()
      return {
        stored,
        countBeforeDestroy,
        actions: [...actions],
        hasThemeStyleAfterDestroy: Boolean(document.querySelector('style[data-yeyu-theme]')),
      }
    })

    expect(summary.stored).toContain('Mod+Alt+S')
    expect(summary.actions).toContainEqual({ type: 'save' })
    expect(summary.actions.filter((a: { type: string }) => a.type === 'format')).toEqual([{ type: 'format', format: 'bold' }])
    expect(summary.hasThemeStyleAfterDestroy).toBe(false)

    // Keypress after destroy should not dispatch further actions
    await page.keyboard.press(`${modKey}+Alt+s`)
    const countAfterDestroy = await page.evaluate(() => (window as unknown as Record<string, any>).__test.actions.length)
    expect(countAfterDestroy).toBe(summary.countBeforeDestroy)
  })
})
