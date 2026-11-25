import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { platform } from 'node:os'
import { join } from 'node:path'
import { chromium, webkit, type Browser, type Locator, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AiSettings, Theme } from '../src/contracts'

const useWebKit = process.env.YEYU_TEST_WEBKIT === '1'
const browserPath = process.env.YEYU_CHROME || (platform() === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : '/usr/bin/chromium')

const hasBrowser = existsSync(useWebKit ? webkit.executablePath() : browserPath)

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
    browser = useWebKit ? await webkit.launch() : await chromium.launch({ executablePath: browserPath, headless: true })
    page = await browser.newPage({ viewport: { width: 1360, height: 860 } })
    page.setDefaultTimeout(5000)
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

  async function mountTestHarness(macTitlebar = false) {
    await page.goto(`${baseUrl}/__ui_harness__`, { waitUntil: 'domcontentloaded' })
    await page.evaluate(`(async () => {
      localStorage.clear()
      const { mountShell } = await import('/src/ui/index.ts')
      const { createEditor } = await import('/src/editor/index.ts')
      const { builtinThemes } = await import('/src/builtin-themes.ts')
      const root = document.getElementById('app')
      const actions = []
      const nativeThemes = []
      const shell = mountShell(root, {
        macTitlebar: ${macTitlebar},
        onWindowAppearance(theme) { nativeThemes.push(theme) },
        dispatch(action) {
          actions.push(action)
        },
      })
      const editor = createEditor(shell.editorHost, {
        onChange() {},
        onSelectionChange() {},
      })
      editor.setMarkdown('# 页屿测试文档\\n\\n第一段正文。\\n\\n## 二级标题\\n\\n第二段正文。\\n')
      window.__test = { shell, editor, actions, nativeThemes, builtinThemes }
    })()`)
  }

  async function openViewSubmenu(name: '文档主题' | '协作侧栏') {
    await page.locator('[data-menu="view"]').click()
    await page.locator('.yy-menu-popover').getByRole('menuitem', { name, exact: true }).click()
    return page.locator('.yy-submenu-panel')
  }

  async function toggleMcp() {
    const submenu = await openViewSubmenu('协作侧栏')
    await submenu.getByRole('menuitemcheckbox', { name: /^MCP 工具与连接/ }).click()
  }

  async function controlColors(control: Locator) {
    return control.evaluate(element => {
      const context = (window as unknown as Record<string, any>).__test.contrastPixel as CanvasRenderingContext2D
      const read = (color: string) => {
        context.clearRect(0, 0, 1, 1)
        context.fillStyle = 'transparent'
        context.fillStyle = color
        context.fillRect(0, 0, 1, 1)
        return Array.from(context.getImageData(0, 0, 1, 1).data)
      }
      const layers: number[][] = []
      for (let node: Element | null = element; node; node = node.parentElement) {
        const color = read(getComputedStyle(node).backgroundColor)
        layers.unshift(color)
        if (color[3] === 255) break
      }
      const blend = (background: number[], color: number[]) => {
        const alpha = color[3] / 255
        return background.map((channel, index) => channel * (1 - alpha) + color[index] * alpha)
      }
      const background = layers.reduce(blend, [255, 255, 255])
      const style = getComputedStyle(element)
      const foreground = blend(background, read(style.color))
      const luminance = (channels: number[]) => {
        const [red, green, blue] = channels.map(channel => {
          const normalized = channel / 255
          return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4
        })
        return .2126 * red + .7152 * green + .0722 * blue
      }
      const luminances = [luminance(foreground) + .05, luminance(background) + .05]
      return { contrast: Math.max(...luminances) / Math.min(...luminances), background: background.join(','), active: element.matches(':active') }
    })
  }

  it('各主题的恢复按钮、菜单、侧栏和协作控件在悬停及按下时可读', async () => {
    await mountTestHarness(true)
    const directory = process.env.YEYU_TEST_THEME_SNAPSHOTS
    const imported = directory ? readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory())
      .map(entry => JSON.parse(readFileSync(join(directory, entry.name, 'theme.json'), 'utf8')) as Theme) : []
    const themes = await page.evaluate(extra => {
      const test = (window as unknown as Record<string, any>).__test
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      test.contrastPixel = canvas.getContext('2d', { willReadFrequently: true })
      test.interactionThemes = [...test.builtinThemes as Theme[], ...extra]
      return (test.interactionThemes as Theme[]).map(({ id, name }) => ({ id, name }))
    }, imported)
    let lowestContrast = Number.POSITIVE_INFINITY
    const samples = [
      { id: 'default', name: '默认浅色', scheme: 'light' as const },
      { id: 'default', name: '默认深色', scheme: 'dark' as const },
      ...themes.map(theme => ({ id: theme.id, name: theme.name, scheme: 'light' as const })),
    ]
    await page.evaluate(() => {
      const { shell } = (window as unknown as Record<string, any>).__test
      const path = '/ws/交互检查.md'
      shell.setState({ title: '交互检查.md', path, mode: 'live', workspace: '/ws', autosave: true,
        presentation: { focus: false, typewriter: false, spellcheck: false, readonly: false } })
      shell.setWorkspace([{ path, name: '交互检查.md' }])
    })
    for (const sample of samples) {
      await page.emulateMedia({ colorScheme: sample.scheme })
      await page.evaluate(id => {
        const test = (window as unknown as Record<string, any>).__test
        test.shell.setThemes(test.interactionThemes, id)
      }, sample.id)

      const inspect = async (control: Locator, name: string) => {
        const normal = await controlColors(control)
        await control.hover()
        const hover = await controlColors(control)
        await page.mouse.down()
        const pressed = await controlColors(control)
        await page.mouse.move(2, 850)
        await page.mouse.up()
        expect.soft(pressed.active, `${sample.name} ${name} 按下态`).toBe(true)
        for (const [state, colors] of [['默认或选中', normal], ['悬停', hover], ['按下', pressed]] as const) {
          lowestContrast = Math.min(lowestContrast, colors.contrast)
          expect.soft(colors.contrast, `${sample.name} ${name} ${state}`).toBeGreaterThanOrEqual(4.5)
        }
        expect.soft(hover.background, `${sample.name} ${name} 悬停反馈`).not.toBe(normal.background)
        expect.soft(pressed.background, `${sample.name} ${name} 按下反馈`).not.toBe(hover.background)
      }

      await page.evaluate(`(async () => {
        const { choose } = await import('/src/dialogs.ts')
        window.__test.recovery = choose('恢复未保存文档', '恢复上次保留的文档。', [
          { label: '放弃草稿', value: 'discard' }, { label: '恢复草稿', value: 'recover', primary: true, autofocus: true }
        ])
      })()`)
      const recovery = page.getByRole('button', { name: '恢复草稿' })
      expect(await recovery.evaluate(element => element === document.activeElement)).toBe(true)
      await inspect(recovery, '恢复草稿')
      await inspect(page.getByRole('button', { name: '放弃草稿' }), '放弃草稿')
      await recovery.click()
      expect(await page.evaluate(() => (window as unknown as Record<string, any>).__test.recovery)).toBe('recover')

      await inspect(page.locator('.yy-doc-title-btn'), '文档标题')
      await inspect(page.locator('[data-mode-btn="live"]'), '当前编辑模式')
      await inspect(page.locator('[data-left-tab="files"]'), '选中文件侧栏')
      await inspect(page.locator('.yy-tree-row.is-active .yy-tree-main'), '当前文件')
      await inspect(page.locator('[data-status-toggle="autosave"]'), '自动保存')
      const file = page.locator('[data-menu="file"]')
      await inspect(file, '文件菜单入口')
      await file.click()
      const popover = page.locator('.yy-menu-popover')
      await inspect(popover.getByRole('menuitemcheckbox', { name: '自动保存' }), '已勾选菜单项')
      await popover.getByRole('menuitem', { name: '导出为' }).hover()
      await inspect(page.locator('.yy-submenu-panel').getByRole('menuitem', { name: 'PDF 文档' }), '二级菜单项')
      await page.mouse.click(760, 800)

      const ai = page.locator('[data-toggle="ai"]')
      await ai.click()
      await page.mouse.move(2, 850)
      await inspect(ai, '已展开的 AI 侧栏')
      await page.getByRole('textbox', { name: 'AI 指令输入' }).fill('交互样稿')
      await inspect(page.getByRole('button', { name: '发送', exact: true }), 'AI 发送')
      await inspect(page.getByRole('combobox', { name: '写作操作' }), '写作操作选择器')
      await page.getByRole('button', { name: '模型配置', exact: true }).click()
      await inspect(page.locator('.yy-ai-provider-choice[aria-pressed="true"]'), '选中的模型供应商')
      const apiProtocol = page.getByRole('combobox', { name: 'API 协议' })
      await inspect(apiProtocol, 'API 协议选择器')
      await apiProtocol.press('ArrowDown')
      await inspect(page.getByRole('option', { name: 'Chat Completions' }), '选中的 API 协议')
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: '默认提示词', exact: true }).click()
      await inspect(page.locator('.yy-ai-task-choice[aria-pressed="true"]'), '选中的提示词')
      await page.keyboard.press('Escape')
      await toggleMcp()
      await page.locator('[data-mcp-action="toggle-form"]').click()
      await inspect(page.locator('.yy-seg-mini-btn.is-active'), '选中的 MCP 连接方式')
      await page.locator('[data-mcp-action="toggle-form"]').click()
      await toggleMcp()
    }
    await page.emulateMedia({ colorScheme: 'light' })
    if (directory) {
      console.log(`已检查 ${samples.length} 套外观的悬停、按下和选中态，包含 ${imported.length} 套导入主题，最低对比度 ${lowestContrast.toFixed(2)}:1`)
    }
  }, 120_000)

  it('二级菜单向侧边展开，独立滚动并支持鼠标和键盘逐级返回', async () => {
    try {
      await page.setViewportSize({ width: 640, height: 360 })
      await mountTestHarness(true)
      const file = page.locator('[data-menu="file"]')
      const popover = page.locator('.yy-menu-popover')
      const submenu = page.locator('.yy-submenu-panel')
      const exportMenu = popover.getByRole('menuitem', { name: '导出为' })
      await file.click()
      const parentHeight = await popover.evaluate(element => element.scrollHeight)
      await exportMenu.hover()
      expect(await exportMenu.getAttribute('aria-expanded')).toBe('true')
      expect(await popover.evaluate(element => element.scrollHeight)).toBe(parentHeight)
      expect(await submenu.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
      const parent = (await popover.boundingBox())!
      const child = (await submenu.boundingBox())!
      expect(child.x).toBeGreaterThanOrEqual(parent.x + parent.width - 2)
      expect(child.y).toBeGreaterThanOrEqual(7)
      expect(child.y + child.height).toBeLessThanOrEqual(353)
      const row = (await exportMenu.boundingBox())!
      await page.mouse.move(child.x + 16, row.y + row.height / 2, { steps: 8 })
      await page.waitForTimeout(220)
      expect(await submenu.isVisible()).toBe(true)
      const parentScroll = await popover.evaluate(element => element.scrollTop)
      await page.mouse.wheel(0, 800)
      await expect.poll(() => submenu.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
      expect(await popover.evaluate(element => element.scrollTop)).toBe(parentScroll)
      await submenu.getByRole('menuitem', { name: 'CommonMark' }).click()
      expect(await submenu.isVisible()).toBe(false)
      expect(await page.evaluate(() => (window as unknown as Record<string, any>).__test.actions.at(-1))).toEqual({ type: 'export', format: 'commonmark' })

      for (let repeat = 0; repeat < 2; repeat++) {
        await file.focus()
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowDown')
        expect(await popover.getByRole('menuitem', { name: /^打开文件…/ }).evaluate(element => element === document.activeElement)).toBe(true)
        await exportMenu.focus()
        await page.keyboard.press('ArrowRight')
        await page.keyboard.press('ArrowDown')
        expect(await submenu.getByRole('menuitem', { name: '纯 HTML（无样式）' }).evaluate(element => element === document.activeElement)).toBe(true)
        await page.keyboard.press('ArrowLeft')
        expect(await exportMenu.evaluate(element => element === document.activeElement)).toBe(true)
        await page.keyboard.press('ArrowRight')
        await page.keyboard.press('Escape')
        expect(await submenu.isVisible()).toBe(false)
        expect(await popover.isVisible()).toBe(true)
        await page.keyboard.press('Escape')
        expect(await popover.isVisible()).toBe(false)
        expect(await file.evaluate(element => element === document.activeElement)).toBe(true)
      }

      await page.evaluate(() => document.documentElement.style.setProperty('--yy-titlebar-zoom', '0.8'))
      await page.locator('[data-menu="view"]').click()
      await popover.getByRole('menuitem', { name: '文档主题' }).hover()
      const view = (await popover.boundingBox())!
      const theme = (await submenu.boundingBox())!
      expect(theme.x).toBeGreaterThanOrEqual(7)
      expect(theme.x + theme.width).toBeLessThanOrEqual(view.x + 2)
    } finally {
      await page.setViewportSize({ width: 1360, height: 860 })
    }
  }, 30_000)

  it('默认主题用系统外观并可从导入主题切回', async () => {
    await mountTestHarness()
    await page.emulateMedia({ colorScheme: 'light' })
    await page.evaluate(() => (window as unknown as Record<string, any>).__test.shell.setThemes([
      { id: 'dark', name: '测试深色', styles: ['.document-theme { --bg-color: #181a20; --text-color: #e4e8ee; }'] },
    ], 'dark'))
    const paper = page.locator('.document-theme')
    expect(await paper.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(24, 26, 32)')
    expect(await page.locator('html').getAttribute('data-yeyu-appearance')).toBe('dark')
    const scrollbar = () => paper.evaluate(element => ({
      width: getComputedStyle(element, '::-webkit-scrollbar').width,
      track: getComputedStyle(element, '::-webkit-scrollbar-track').backgroundColor,
      thumb: getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor,
    }))
    const darkBar = await scrollbar()
    expect(darkBar.width).toBe('8px')
    expect(darkBar.track).toBe('rgba(0, 0, 0, 0)')
    await page.locator('[data-toggle="ai"]').click()
    const chrome = await page.locator('.yy-shell').evaluate(element => {
      const fields = ['.yy-topbar', '.yy-left-panel', '.yy-right-panel', '.yy-statusbar']
      return fields.map(selector => {
        const style = getComputedStyle(element.querySelector(selector)!)
        return [style.backgroundColor, style.colorScheme]
      })
    })
    for (const [background, scheme] of chrome) {
      expect(background).not.toContain('255, 255, 255')
      expect(scheme).toBe('dark')
    }
    const themes = await openViewSubmenu('文档主题')
    await themes.getByRole('menuitemradio', { name: '默认', exact: true }).click()
    expect(await page.evaluate(() => (window as unknown as Record<string, any>).__test.actions.at(-1))).toEqual({ type: 'theme', id: 'default' })
    await page.evaluate(() => (window as unknown as Record<string, any>).__test.shell.setThemes([], 'default'))
    const lightBar = await scrollbar()
    expect(lightBar.thumb).not.toBe(darkBar.thumb)
    expect(lightBar.track).toBe(darkBar.track)
    expect(await page.evaluate(() => (window as unknown as Record<string, any>).__test.nativeThemes)).toEqual(['dark', null])
    expect(await page.locator('html').getAttribute('data-yeyu-appearance')).toBe('light')
    expect(await page.locator('.yy-left-panel').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(255, 255, 255)')
    expect(await paper.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(255, 255, 255)')
    expect(await paper.evaluate(element => getComputedStyle(element).color)).toBe('rgb(34, 34, 34)')
    const editorFont = paper.locator('.cm-scroller')
    expect(await editorFont.evaluate(element => getComputedStyle(element).fontFamily)).not.toContain('monospace')
    await page.evaluate(() => (window as unknown as Record<string, any>).__test.editor.setMode('source'))
    expect(await editorFont.evaluate(element => getComputedStyle(element).fontFamily)).toContain('monospace')
    expect(await page.locator('.yy-seg-tab.is-active').first().evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(237, 237, 237)')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => page.locator('html').getAttribute('data-yeyu-appearance')).toBe('dark')
    expect(await paper.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(32, 32, 32)')
    await page.emulateMedia({ colorScheme: 'light' })
  })

  it('青瓷和松夜同步标题栏、工作区、AI、MCP 与弹窗的配色', async () => {
    await mountTestHarness(true)
    await page.emulateMedia({ colorScheme: 'light' })
    await page.evaluate(() => {
      const { shell } = (window as unknown as Record<string, any>).__test
      const path = '/ws/设计稿.md'
      shell.setState({ title: '设计稿.md', path, mode: 'live', workspace: '/ws', autosave: true,
        presentation: { focus: false, typewriter: false, spellcheck: false, readonly: false } })
      shell.setWorkspace([{ path, name: '设计稿.md' }])
    })

    const tint = async (selector: string, property = 'background-color') => {
      const color = await page.locator(selector).first().evaluate((element, propertyName) => {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')!
        context.fillStyle = getComputedStyle(element).getPropertyValue(propertyName)
        context.fillRect(0, 0, 1, 1)
        return Array.from(context.getImageData(0, 0, 1, 1).data)
      }, property)
      const [red, green, blue, alpha] = color
      expect(green, selector).toBeGreaterThan(Math.max(red, blue))
      expect(alpha, selector).toBeGreaterThan(0)
      return color
    }

    for (const [id, colorScheme] of [['builtin-jade', 'light'], ['builtin-pine', 'dark']]) {
      await page.evaluate(id => {
        const { shell, builtinThemes } = (window as unknown as Record<string, any>).__test
        shell.setThemes(builtinThemes, id)
        shell.setTitlebar({ material: 'frosted' })
      }, id)
      expect(await page.locator('html').getAttribute('data-yeyu-appearance')).toBe(colorScheme)
      expect((await tint('.yy-topbar'))[3]).toBeLessThan(255)
      await page.evaluate(() => (window as unknown as Record<string, any>).__test.shell.setTitlebar({ material: 'liquid' }))
      expect((await tint('.yy-topbar'))[3]).toBeLessThan(255)
      await tint('.yy-left-panel')
      await tint('.yy-tree-row.is-active')
      await tint('.yy-tree-row.is-active .yy-tree-main', 'color')
      await tint('.yy-status-chip.is-active')
      await page.locator('[data-left-tab="search"]').click()
      await tint('.yy-search-form .yy-input')
      await page.locator('[data-left-tab="files"]').click()

      await page.locator('[data-toggle="ai"]').click()
      await tint('.yy-right-panel')
      await tint('.yy-ai-input-box')
      await page.getByLabel('AI 指令输入').fill('润色正文')
      await tint('.yy-ai-send')
      await page.getByRole('button', { name: '模型配置', exact: true }).click()
      await tint('.yy-ai-settings')
      await tint('.yy-ai-settings [role="combobox"]')
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: '默认提示词', exact: true }).click()
      await tint('.yy-ai-task-choice[aria-pressed="true"]')
      await tint('.yy-ai-template')
      await page.keyboard.press('Escape')

      await toggleMcp()
      await tint('.yy-mcp-bridge')
      await page.locator('[data-mcp-action="toggle-form"]').click()
      await tint('.yy-mcp-pane .yy-config-card input')
      await page.locator('[data-mcp-action="toggle-form"]').click()
      await toggleMcp()

      await page.locator('.yy-doc-title-btn').click()
      await tint('.yy-modal-quickopen')
      await page.keyboard.press('Escape')
      await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
      await page.getByRole('menuitem', { name: /插件管理/ }).click()
      await tint('.yy-plugin-manager')
      await page.keyboard.press('Escape')
      await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
      await page.getByRole('menuitem', { name: /快捷键设置/ }).click()
      await tint('.yy-modal-shortcuts')
      await page.keyboard.press('Escape')

      await page.evaluate(`(async () => {
        const { readSetting } = await import('/src/dialogs.ts')
        void readSetting('资源设置', '输入地址。', 'https://example.test')
      })()`)
      await tint('.app-dialog')
      await tint('.app-dialog input')
      await tint('.app-dialog-primary')
      await page.keyboard.press('Escape')
    }
    const imported = await page.evaluate(() => {
      const { shell } = (window as unknown as Record<string, any>).__test
      shell.setThemes([{ id: 'imported', name: '导入的低对比度主题', styles: [`.document-theme {
        --side-bar-bg-color: #dfe6f2;
        --primary-color: #cdd5e6;
        color: #b2bcce;
      }`] }], 'imported')
      const styles = getComputedStyle(document.documentElement)
      const luminance = (name: string) => {
        const [red, green, blue] = styles.getPropertyValue(name).match(/\d+/g)!.map(value => {
          const channel = Number(value) / 255
          return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4
        })
        return .2126 * red + .7152 * green + .0722 * blue
      }
      return {
        sidebar: getComputedStyle(document.querySelector('.yy-left-panel')!).backgroundColor,
        accentContrast: (luminance('--yy-theme-surface') + .05) / (luminance('--yy-theme-accent') + .05),
      }
    })
    expect(imported.sidebar).toBe('rgb(223, 230, 242)')
    expect(imported.accentContrast).toBeGreaterThanOrEqual(4.5)
    await page.evaluate(() => (window as unknown as Record<string, any>).__test.shell.setThemes([], 'default'))
    expect(await page.locator('.yy-left-panel').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(255, 255, 255)')
    expect(await page.locator('html').getAttribute('data-yeyu-theme')).toBeNull()
  }, 15_000)

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

    const themes = await openViewSubmenu('文档主题')
    const night = themes.getByRole('menuitemradio', { name: '夜松' })
    await night.focus()
    await page.evaluate(() => {
      const { shell, builtinThemes } = (window as unknown as Record<string, any>).__test
      shell.setThemes([...builtinThemes, { id: 'night-pine', name: '夜松', styles: [] }], 'night-pine', [
        { id: 'typora-local', name: '本机新发现主题', styles: [] },
      ])
    })
    expect(await themes.getByRole('menuitemradio', { name: '本机新发现主题' }).isVisible()).toBe(true)
    expect(await night.getAttribute('aria-checked')).toBe('true')
    expect(await night.evaluate(element => element === document.activeElement)).toBe(true)
    expect(await themes.locator('.yy-theme-sample svg').count()).toBeGreaterThan(0)
    await page.keyboard.press('Enter')

    const imports = await openViewSubmenu('文档主题')
    await imports.getByRole('menuitem', { name: '导入本机 Typora 主题', exact: true }).click()
    const cssImport = await openViewSubmenu('文档主题')
    await cssImport.getByRole('menuitem', { name: '导入主题 CSS…', exact: true }).click()

    const dispatched = await page.evaluate(() => (window as unknown as Record<string, any>).__test.actions)
    expect(dispatched).toContainEqual({ type: 'theme', id: 'night-pine' })
    expect(dispatched).toContainEqual({ type: 'theme-import-typora' })
    expect(dispatched).toContainEqual({ type: 'theme-import' })
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
    expect(await page.locator('.yy-findbar .yy-toggle-chip svg').count()).toBe(3)
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

  it('左右侧栏平滑展开收起，动画期间正文列宽固定，支持关闭动效', async () => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await mountTestHarness()
    const toggle = (side: 'left' | 'right') => page.evaluate(async side => {
      const slot = document.querySelector<HTMLElement>('.yy-sidebar-slot-' + side)!
      const panel = slot.querySelector('aside')!
      const paper = document.querySelector('.yy-paper')!
      const button = document.querySelector<HTMLButtonElement>(`[data-toggle="${side === 'left' ? 'left' : 'ai'}"]`)!
      const width = () => slot.getBoundingClientRect().width
      const start = width()
      if (start) slot.querySelector<HTMLElement>('button')?.focus()
      button.click()
      const inert = slot.inert
      const focusReturned = document.activeElement?.matches('.cm-content')
      const animation = panel.getAnimations().find(item => (item as CSSTransition).transitionProperty === 'transform')
      const column = paper.getBoundingClientRect().width
      let translation = 0
      let middleColumn = column
      if (animation) {
        animation.pause()
        animation.currentTime = 80
        translation = Math.abs(new DOMMatrixReadOnly(getComputedStyle(panel).transform).m41)
        middleColumn = paper.getBoundingClientRect().width
        animation.finish()
      }
      return { start, translation, columns: [column, middleColumn, paper.getBoundingClientRect().width], end: width(), animated: !!animation, inert, focusReturned }
    }, side)

    for (const [side, size] of [['left', 220], ['right', 360]] as const) {
      if (side === 'right') await toggle(side)
      const close = await toggle(side)
      expect(close).toMatchObject({ start: size, end: 0, animated: true, inert: true, focusReturned: true })
      expect(close.translation).toBeGreaterThan(0)
      expect(close.translation).toBeLessThan(size)
      expect(new Set(close.columns).size).toBe(1)
      const open = await toggle(side)
      expect(open).toMatchObject({ start: 0, end: size, animated: true, inert: false })
      expect(open.translation).toBeGreaterThan(0)
      expect(open.translation).toBeLessThan(size)
      expect(new Set(open.columns).size).toBe(1)
    }

    const viewMenu = page.locator('[data-menu="view"]')
    const motion = page.getByRole('menuitemcheckbox', { name: '界面动画' })
    await viewMenu.click()
    expect(await motion.getAttribute('aria-checked')).toBe('true')
    await motion.click()
    expect(await page.evaluate(() => (window as unknown as Record<string, any>).__test.actions)).toContainEqual({ type: 'animations', enabled: false })
    const preference = (animations: boolean) => page.evaluate(animations => {
      const { shell } = (window as unknown as Record<string, any>).__test
      shell.setState({ title: '未命名.md', path: null, mode: 'live', workspace: null, animations,
        presentation: { focus: false, typewriter: false, spellcheck: false } })
    }, animations)
    await preference(false)
    expect(await toggle('left')).toMatchObject({ start: 220, end: 0, animated: false })
    await viewMenu.click()
    expect(await motion.getAttribute('aria-checked')).toBe('false')
    expect(await page.locator('.yy-menu-popover').evaluate(item => getComputedStyle(item).animationDuration)).toBe('0s')
    await page.keyboard.press('Escape')

    await page.emulateMedia({ reducedMotion: 'reduce' })
    await preference(true)
    expect(await toggle('left')).toMatchObject({ start: 0, end: 220, animated: false })
    await page.locator('.yy-doc-title-btn').click()
    expect(await page.locator('.yy-modal-backdrop').evaluate(item => getComputedStyle(item).animationDuration)).toBe('0s')
    await page.keyboard.press('Escape')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  })

  it('AI 模型配置与提示词页面、上下文全文预览、流式会话和差异逐段应用', async () => {
    await mountTestHarness()

    const fullContextText = '第一行上下文\n' + '超长全文预览内容不会被截断。'.repeat(12)
    const settings: AiSettings = { providers: [
      { id: 'cloud', name: '云端写作', endpoint: 'https://api.example.com/v1/responses', protocol: 'responses', models: ['qwen-plus', 'qwen-long'], hasKey: true },
      { id: 'local', name: '本地推理', endpoint: 'http://localhost:11434/v1/chat/completions', protocol: 'chat', models: ['qwen-plus'], hasKey: false },
    ], active: { providerId: 'cloud', model: 'qwen-plus' } }
    await page.click('[data-toggle="ai"]')

    const composer = page.getByLabel('AI 指令输入')
    const send = page.getByRole('button', { name: '发送', exact: true })
    const singleLine = (await composer.boundingBox())!.height
    expect(await send.isEnabled()).toBe(false)
    await composer.fill('第一行\n第二行\n第三行\n第四行')
    expect((await composer.boundingBox())!.height).toBeGreaterThan(singleLine + 32)
    expect(await send.isEnabled()).toBe(true)
    await composer.fill('')
    expect((await composer.boundingBox())!.height).toBe(singleLine)

    const modelDialog = page.getByRole('dialog', { name: '模型配置' })
    await page.getByRole('button', { name: '模型配置', exact: true }).click()
    const protocols = modelDialog.getByRole('combobox', { name: 'API 协议' })
    expect(await modelDialog.locator('select').count()).toBe(0)
    await protocols.press('ArrowDown')
    expect(await page.getByRole('option').count()).toBe(3)
    await protocols.press('Escape')
    expect(await modelDialog.isVisible()).toBe(true)
    expect(await protocols.getAttribute('aria-expanded')).toBe('false')
    await protocols.press('ArrowDown')
    await protocols.press('End')
    await protocols.press('Enter')
    expect(await protocols.textContent()).toContain('Responses')
    await modelDialog.getByLabel('供应商名称').fill('云端写作')
    await modelDialog.getByLabel('API 地址').fill('https://api.example.com/v1')
    await modelDialog.getByLabel('模型 ID 1').fill('qwen-plus')
    await modelDialog.getByRole('button', { name: '添加模型' }).click()
    await modelDialog.getByLabel('模型 ID 2').fill('qwen-long')
    await modelDialog.locator('input[type="password"]').fill('sk-test-123')
    await modelDialog.getByRole('button', { name: '保存配置' }).click()
    await modelDialog.getByRole('button', { name: '关闭', exact: true }).click()
    expect(await modelDialog.count()).toBe(0)

    await page.getByRole('button', { name: '默认提示词', exact: true }).click()
    const promptsDialog = page.getByRole('dialog', { name: '默认提示词' })
    const template = promptsDialog.getByLabel('提示词内容')
    expect(await promptsDialog.locator('.yy-ai-task-choice').count()).toBe(9)
    await promptsDialog.getByRole('button', { name: '改写', exact: true }).click()
    const defaultRewrite = await template.inputValue()
    expect(defaultRewrite).toContain('保留原有事实')
    await template.fill('保留专名，将段落缩为两句。')
    await promptsDialog.getByRole('button', { name: '摘要', exact: true }).click()
    await promptsDialog.getByRole('button', { name: '改写', exact: true }).click()
    expect(await template.inputValue()).toBe('保留专名，将段落缩为两句。')
    await promptsDialog.getByRole('button', { name: '保存提示词' }).click()
    expect(await promptsDialog.count()).toBe(0)

    // Pick context scope & push full context + diff suggestion
    await page.getByRole('combobox', { name: '添加上下文' }).click()
    await page.getByRole('option', { name: '全文' }).click()
    expect(await page.locator('.yy-ai-pane select').count()).toBe(0)
    await page.evaluate(({ text, settings }) => {
      const { shell } = (window as unknown as Record<string, any>).__test
      shell.setAI({
        settings,
        prompts: { rewrite: '保留专名，将段落缩为两句。' },
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
    }, { text: fullContextText, settings })

    expect(await page.locator('.yy-context-fulltext').textContent()).toBe(fullContextText)
    expect(await page.getByRole('combobox', { name: '切换模型' }).isEnabled()).toBe(false)

    // Cancel while pending
    await page.getByRole('button', { name: '取消生成' }).click()

    // Switch to retryable non-pending state, send a polish intent, and test per-hunk & all diff apply
    await page.evaluate(settings => {
      const { shell } = (window as unknown as Record<string, any>).__test
      shell.setAI({
        settings,
        prompts: { rewrite: '保留专名，将段落缩为两句。' },
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
    }, settings)

    await page.getByRole('button', { name: '默认提示词', exact: true }).click()
    await promptsDialog.getByRole('button', { name: '改写', exact: true }).click()
    expect(await template.inputValue()).toBe('保留专名，将段落缩为两句。')
    await promptsDialog.getByRole('button', { name: '恢复默认' }).click()
    expect(await template.inputValue()).toBe(defaultRewrite)
    await promptsDialog.getByRole('button', { name: '保存提示词' }).click()
    expect(await promptsDialog.count()).toBe(0)

    await page.getByRole('button', { name: '重试上次请求' }).click()
    const modelPicker = page.getByRole('combobox', { name: '切换模型' })
    expect(await modelPicker.textContent()).toBe('云端写作 · qwen-plus')
    await modelPicker.click()
    expect(await page.getByRole('option').count()).toBe(3)
    await page.getByRole('option', { name: /qwen-plus.*本地推理/ }).click()
    await page.getByRole('combobox', { name: '写作操作' }).click()
    expect(await page.getByRole('option').count()).toBe(9)
    await page.getByRole('option', { name: '翻译' }).click()
    await page.fill('.yy-ai-composer textarea', '翻译为英文')
    await page.click('.yy-ai-composer button[type="submit"]')

    // Apply single hunk #1, then apply all, then dismiss
    await page.click('[data-apply-hunk="1"]')
    await page.click('[data-suggestion-action="apply-all"]')
    await page.click('[data-suggestion-action="dismiss"]')

    const actions = await page.evaluate(() => (window as unknown as Record<string, any>).__test.actions)
    expect(actions).toContainEqual({
      type: 'ai-provider-save',
      provider: { id: expect.any(String), name: '云端写作', endpoint: 'https://api.example.com/v1', protocol: 'responses', models: ['qwen-plus', 'qwen-long'] },
      key: 'sk-test-123',
    })
    expect(actions).toContainEqual({ type: 'ai-model-select', selection: { providerId: 'local', model: 'qwen-plus' } })
    expect(actions).toContainEqual({ type: 'ai-prompts', prompts: { rewrite: '保留专名，将段落缩为两句。' } })
    expect(actions).toContainEqual({ type: 'ai-prompts', prompts: {} })
    expect(actions).toContainEqual({ type: 'ai-context', scope: 'document' })
    expect(actions).toContainEqual({ type: 'ai-cancel' })
    expect(actions).toContainEqual({ type: 'ai-retry' })
    expect(actions).toContainEqual({ type: 'ai-send', intent: 'translate', prompt: '翻译为英文' })
    expect(actions).toContainEqual({ type: 'suggestion-apply', id: 'sug-1', hunks: [1] })
    expect(actions).toContainEqual({ type: 'suggestion-apply', id: 'sug-1', hunks: [0, 1] })
    expect(actions).toContainEqual({ type: 'suggestion-dismiss', id: 'sug-1' })
  })

  it('Android 窄屏可打开和保存、切换源码，宽屏菜单留在视口内', async () => {
    await page.setViewportSize({ width: 390, height: 736 })
    try {
      await page.goto(`${baseUrl}/__ui_harness__`)
      await page.evaluate(`(async () => {
        const path = 'content://qa/document/01'
        const document = { uri: path, name: '移动笔记.md', text: '# 标题\\r\\n\\r\\n正文\\n', bom: true, version: '1', writable: true }
        const writes = []
        window.__TAURI_INTERNALS__ = { invoke: async (cmd, payload) => {
          if (cmd === 'android_pick') return path
          if (cmd === 'android_read') return document
          if (cmd === 'android_write') { writes.push(payload); return { ...document, text: payload.text, version: '2' } }
          if (cmd === 'android_load_session') return null
          return null
        } }
        window.__mobileWrites = writes
        await import('/src/mobile.ts')
      })()`)
      const open = page.getByRole('button', { name: '打开文件' })
      expect((await open.boundingBox())!.width).toBeGreaterThanOrEqual(44)
      await open.click()
      await page.getByRole('heading', { name: '移动笔记.md' }).waitFor()
      await page.getByRole('button', { name: '源码', exact: true }).click()
      expect(await page.locator('#write').getAttribute('data-mode')).toBe('source')
      await page.locator('.cm-content .cm-line').last().click()
      await page.keyboard.insertText('Android')
      await page.getByRole('button', { name: '保存文档' }).click()
      await expect.poll(() => page.evaluate(() => ((window as unknown as Record<string, any>).__mobileWrites).length)).toBe(1)
      const [saved] = await page.evaluate(() => (window as unknown as Record<string, any>).__mobileWrites)
      expect(saved).toMatchObject({ uri: 'content://qa/document/01', bom: true, expected: '1' })
      expect(saved.text).toBe('# 标题\r\n\r\n正文\nAndroid')

      await page.setViewportSize({ width: 820, height: 420 })
      await page.getByRole('button', { name: '更多操作' }).click()
      await page.getByRole('button', { name: '文档主题', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '文档主题' })
      const box = (await dialog.boundingBox())!
      expect(box.x).toBeGreaterThan(0)
      expect(box.y + box.height).toBeLessThanOrEqual(420)
      await dialog.getByRole('button', { name: '石墨' }).click()
      expect(await page.locator('html').getAttribute('data-yeyu-appearance')).toBe('dark')
    } finally {
      await page.setViewportSize({ width: 1360, height: 860 })
    }
  })

  it('MCP 侧栏 stdio/HTTP 配置、调用前参数预览与显式许可、授权与待审建议', async () => {
    await mountTestHarness()

    expect(await page.locator('.yy-topbar-right .yy-tool-btn').allTextContents()).toEqual(['AI'])
    const view = page.locator('[data-menu="view"]')
    await view.focus()
    await page.keyboard.press('ArrowDown')
    await page.locator('.yy-menu-popover').getByRole('menuitem', { name: '协作侧栏', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    const mcpTab = page.locator('[data-right-tab="mcp"]')
    expect(await mcpTab.getAttribute('aria-selected')).toBe('true')
    expect(await mcpTab.evaluate(element => element === document.activeElement)).toBe(true)

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

    const collaboration = await openViewSubmenu('协作侧栏')
    const mcp = collaboration.getByRole('menuitemcheckbox', { name: /^MCP 工具与连接/ })
    expect(await mcp.getAttribute('aria-checked')).toBe('true')
    expect(await mcp.locator('.yy-count-badge').textContent()).toBe('2')
    expect(await collaboration.getByRole('menuitemcheckbox', { name: /^AI 写作助手/ }).getAttribute('aria-checked')).toBe('false')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')

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
