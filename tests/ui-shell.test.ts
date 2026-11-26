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

function importedThemes() {
  const directory = process.env.YEYU_TEST_THEME_SNAPSHOTS
  return directory ? readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .map(entry => JSON.parse(readFileSync(join(directory, entry.name, 'theme.json'), 'utf8')) as Theme) : []
}

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

  async function mountTestHarness(macTitlebar = false, discover = false) {
    await page.goto(`${baseUrl}/__ui_harness__`, { waitUntil: 'domcontentloaded' })
    await page.evaluate(`(async () => {
      localStorage.clear()
      const { mountShell } = await import('/src/ui/index.ts')
      const { createEditor } = await import('/src/editor/index.ts')
      const { builtinThemes } = await import('/src/builtin-themes.ts')
      const root = document.getElementById('app')
      const actions = []
      const modelRequests = []
      const nativeThemes = []
      const shell = mountShell(root, {
        macTitlebar: ${macTitlebar},
        listAiModels: ${discover} ? async request => {
          modelRequests.push(request)
          if (request.endpoint.includes('offline')) throw new Error('无法连接供应商')
          return ['alpha-write', 'beta-code', 'alpha-write']
        } : undefined,
        onWindowAppearance(theme) { nativeThemes.push(theme) },
        dispatch(action) {
          actions.push(action)
          return window.__test?.dispatch?.(action)
        },
      })
      const editor = createEditor(shell.editorHost, {
        onChange() {},
        onSelectionChange() {},
      })
      editor.setMarkdown('# 页屿测试文档\\n\\n第一段正文。\\n\\n## 二级标题\\n\\n第二段正文。\\n')
      window.__test = { shell, editor, actions, nativeThemes, builtinThemes, modelRequests }
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
      // 先应用当前悬停或按下选择器，再读取过渡完成后的颜色。
      void getComputedStyle(element).backgroundColor
      for (const animation of element.getAnimations()) {
        if (animation instanceof CSSTransition) animation.finish()
      }
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
    const imported = importedThemes()
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
    if (imported.length) {
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
    await expect.poll(() => page.locator('.yy-seg-tab.is-active').first().evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(237, 237, 237)')
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
      const plugins = page.getByRole('region', { name: '插件管理' })
      await plugins.getByRole('button', { name: '从文件安装…' }).waitFor()
      expect(await page.getByRole('dialog', { name: '插件管理' }).count()).toBe(0)
      await tint('.yy-plugin-manager')
      await page.keyboard.press('Escape')
      await plugins.waitFor({ state: 'hidden' })
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
    const transition = () => viewMenu.evaluate(control => getComputedStyle(control).transitionProperty)
    expect(await transition()).toContain('background-color')
    await viewMenu.hover()
    await page.mouse.down()
    try {
      await expect.poll(() => viewMenu.evaluate(control => getComputedStyle(control).scale)).toBe('0.97')
    } finally {
      await page.mouse.up()
    }
    await page.keyboard.press('Escape')
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
    expect(await transition()).toBe('none')
    expect(await toggle('left')).toMatchObject({ start: 220, end: 0, animated: false })
    await viewMenu.click()
    expect(await motion.getAttribute('aria-checked')).toBe('false')
    expect(await page.locator('.yy-menu-popover').evaluate(item => getComputedStyle(item).animationDuration)).toBe('0s')
    await page.keyboard.press('Escape')

    await page.emulateMedia({ reducedMotion: 'reduce' })
    await preference(true)
    expect(await transition()).toBe('none')
    expect(await toggle('left')).toMatchObject({ start: 0, end: 220, animated: false })
    await page.locator('.yy-doc-title-btn').click()
    expect(await page.locator('.yy-modal-backdrop').evaluate(item => getComputedStyle(item).animationDuration)).toBe('0s')
    await page.keyboard.press('Escape')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  })

  it('从供应商读取模型，筛选后添加到配置，网络失败时可继续手动填写', async () => {
    await mountTestHarness(false, true)
    await page.locator('[data-toggle="ai"]').click()
    await page.getByRole('button', { name: '模型配置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '模型配置' })
    await settings.getByLabel('供应商名称').fill('测试供应商')
    const endpoint = settings.getByLabel('API 地址')
    await endpoint.fill('http://models.example.test:8080/team/v1')
    await settings.locator('input[type="password"]').fill('fixture-key')
    await settings.getByRole('button', { name: '获取模型' }).click()
    const options = settings.getByRole('group', { name: '可用模型' })
    await options.getByRole('checkbox', { name: 'alpha-write' }).check()
    const filter = settings.getByRole('searchbox', { name: '筛选可用模型' })
    await filter.fill('beta')
    await options.getByRole('checkbox', { name: 'beta-code' }).check()
    await settings.getByRole('button', { name: '添加所选' }).click()
    expect(await settings.getByRole('textbox', { name: /模型 ID/ }).count()).toBe(2)
    expect(await settings.getByLabel('模型 ID 1').inputValue()).toBe('alpha-write')
    expect(await settings.getByLabel('模型 ID 2').inputValue()).toBe('beta-code')

    await endpoint.fill('https://offline.example.test/v1')
    await settings.getByRole('button', { name: '获取模型' }).click()
    await settings.getByText('无法连接供应商').waitFor()
    expect(await settings.getByLabel('模型 ID 2').inputValue()).toBe('beta-code')
    await endpoint.fill('http://models.example.test:8080/team/v1')
    await settings.getByRole('button', { name: '保存配置' }).click()
    expect(await page.evaluate('window.__test.modelRequests[0]')).toMatchObject({
      endpoint: 'http://models.example.test:8080/team/v1', protocol: 'chat', key: 'fixture-key',
    })
    expect(await page.evaluate('window.__test.actions.at(-1).provider.models')).toEqual(['alpha-write', 'beta-code'])
  }, 10000)

  it('在桌面侧栏渲染历史和流式 Markdown，宽表和代码可横向滚动', async () => {
    await mountTestHarness()
    const fence = '\x60'.repeat(3)
    const column = Array.from({ length: 12 }, (_, i) => '第' + (i + 1) + '列')
    const answer = [
      '## 回复排版', '', '- **粗体项目**', '- 第二项', '',
      '| ' + column.join(' | ') + ' |', '| ' + column.map(() => '---:').join(' | ') + ' |',
      '| ' + column.map(() => '详情').join(' | ') + ' |', '', fence + 'js',
      'const code = "' + 'value'.repeat(160) + '"', fence, '',
      '[参考链接](https://example.test/docs)', '', '![图片说明](https://example.test/picture.png)',
    ].join('\n')
    await page.evaluate(answer => {
      const native = window as unknown as Record<string, any>
      native.__TAURI_INTERNALS__ = { invoke: async (command: string, args: unknown) => { native.__clickedLink = { command, args } } }
      native.__test.shell.setAI({
        settings: { providers: [], active: null }, prompts: {}, context: null,
        messages: [{ role: 'user', text: '**让我看原样输入**' }, { role: 'assistant', text: answer }],
        stream: '### 流式标题\n\n- 实时 **加粗**', pending: true, error: '', suggestion: null, canRetry: false,
      })
    }, answer)
    await page.locator('[data-toggle="ai"]').click()
    const assistant = page.locator('.yy-ai-messages .yy-msg-assistant')
    await assistant.getByRole('heading', { name: '回复排版' }).waitFor()
    expect(await assistant.locator('li strong').textContent()).toBe('粗体项目')
    expect(await assistant.locator('th').first().evaluate(node => getComputedStyle(node).textAlign)).toBe('right')
    expect(await assistant.locator('.yy-ai-table-scroll').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true)
    expect(await assistant.locator('pre').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true)
    expect(await assistant.locator('img').count()).toBe(0)
    expect(await page.locator('.yy-msg-user .yy-msg-body').textContent()).toBe('**让我看原样输入**')
    await page.getByRole('heading', { name: '流式标题' }).waitFor()
    expect(await page.locator('.yy-ai-conversation > .yy-msg-assistant li strong').textContent()).toBe('加粗')
    await assistant.getByRole('link', { name: '参考链接' }).click()
    expect(await page.evaluate('window.__clickedLink')).toEqual({ command: 'visit_link', args: { url: 'https://example.test/docs' } })
  }, 10000)

  it('桌面对话可保存和切换，压缩后用摘要续接且重复提交只发送一次', async () => {
    await mountTestHarness()
    await page.evaluate(String.raw`(async () => {
      const { Writing } = await import('/src/ai.ts')
      const { shell, editor } = window.__test
      const scope = 'fixture\nhttps://models.example.test/v1'
      const archive = { conversations: [{ id: 'old', scope, title: '原项目',
        messages: [
          { role: 'user', text: '只保留在原始记录的标记' }, { role: 'assistant', text: '已确认需求' },
          { role: 'user', text: '采购完成了吗' }, { role: 'assistant', text: '尚待复核' },
          { role: 'user', text: '需要复核哪个项目' }, { role: 'assistant', text: '设备清单' }
        ], summary: '', covered: 0, updated: 1
      }], selected: { [scope]: 'old' } }
      const callbacks = new Map()
      let id = 0
      const observed = []
      window.__desktopAi = { observed, archive }
      window.__TAURI_INTERNALS__ = {
        transformCallback(fn) { callbacks.set(++id, fn); return id },
        unregisterCallback(i) { callbacks.delete(i) },
        async invoke(cmd, data) {
          if (cmd === 'ai_settings') return { providers: [{ id: 'fixture', endpoint: 'https://models.example.test/v1',
            protocol: 'chat', name: '测试模型', models: ['writer'], hasKey: false }],
            active: { providerId: 'fixture', model: 'writer' } }
          if (cmd === 'ai_conversations') {
            if (data?.value) Object.assign(archive, structuredClone(data.value))
            return data?.value ? null : structuredClone(archive)
          }
          if (cmd === 'ai_agent_turn') {
            const request = structuredClone(data.request)
            observed.push({ command: cmd, request })
            const send = callbacks.get(data.event.id)
            const plan = { id: 'plan', name: 'update_plan', arguments: JSON.stringify({ plan: [{ step: '整理摘要任务', status: 'completed' }] }) }
            const text = request.history.length ? '## 智能体结论\n\n已复核。' : ''
            if (text) send({ index: 0, message: { kind: 'delta', text } })
            send({ index: text ? 1 : 0, end: true })
            return { text, calls: text ? [] : [plan], output: [{ role: 'assistant', content: text }] }
          }
          if (cmd !== 'ai_stream') return null
          const messages = structuredClone(data.messages)
          observed.push({ command: cmd, messages })
          const send = callbacks.get(data.event.id)
          if (window.__desktopAi.failNext) {
            window.__desktopAi.failNext = false
            send({ index: 0, end: true })
            throw new Error('测试供应商拒绝请求')
          }
          if (messages.at(-1).text.endsWith('检查连续提交')) await new Promise(resolve => { window.__finishOnce = resolve })
          const text = messages[0].text.startsWith('压缩这段') ? '已压缩的历史重点' : window.__desktopAi.reply ?? '收到。'
          send({ index: 0, message: { kind: 'delta', text } })
          send({ index: 1, message: { kind: 'done' } })
          send({ index: 2, end: true })
          return null
        }
      }
      const writing = new Writing(view => shell.setAI(view))
      let revision = 1
      window.__desktopAi.changeDocument = () => { editor.setMarkdown('# 选区已经改动'); revision++ }
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async text => { window.__desktopAi.copied = text },
      } })
      window.__desktopAi.reload = async () => { const reopened = new Writing(view => shell.setAI(view)); await reopened.load(); window.__test.writing = reopened }
      window.__test.writing = writing
      window.__test.dispatch = async (action) => {
        const current = window.__test.writing
        if (action.type === 'ai-send') await current.send(action.intent, action.prompt, editor, 1, revision, { agent: action.agent })
        else if (action.type === 'ai-context') current.preview(action.scope, editor, 1, revision, '测试.md')
        else if (action.type === 'ai-retry') await current.retry()
        else if (action.type === 'ai-compress' || action.type.startsWith('ai-chat-')) await current.manageChat(action)
      }
      await writing.load()
    })()`)
    await page.locator('[data-toggle="ai"]').click()
    const chats = page.getByRole('button', { name: '对话管理' })
    const manage = page.getByRole('dialog', { name: '对话管理' })
    const composer = page.getByLabel('AI 指令输入')
    const send = page.getByRole('button', { name: '发送', exact: true })
    await chats.click()
    await manage.getByRole('button', { name: '重命名 原项目' }).click()
    await manage.getByLabel('对话标题').fill('设备复核')
    await manage.getByRole('button', { name: '保存标题' }).click()
    await manage.getByRole('button', { name: '设备复核', exact: true }).waitFor()
    await manage.getByRole('button', { name: '新建对话' }).click()
    await composer.fill('检查连续提交')
    await composer.evaluate(input => {
      const form = input.closest('form')!
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
    })
    await expect.poll(() => page.evaluate('window.__desktopAi.observed.length')).toBe(1)
    expect(await page.locator('.yy-msg-user').count()).toBe(1)
    await page.evaluate('window.__finishOnce()')
    await page.getByText('收到。', { exact: true }).waitFor()
    await page.evaluate('window.__desktopAi.failNext = true')
    await page.getByRole('button', { name: '重新生成上条回复' }).click()
    await page.getByText('测试供应商拒绝请求', { exact: true }).waitFor()
    expect(await page.locator('.yy-ai-messages .yy-msg-assistant').count()).toBe(1)
    expect(await page.getByText('收到。', { exact: true }).isVisible()).toBe(true)
    await page.evaluate(`window.__desktopAi.reply = '**新的回复**'`)
    await page.getByRole('button', { name: '重试上次请求' }).click()
    await expect.poll(() => page.evaluate('window.__desktopAi.observed.length')).toBe(3)
    await page.evaluate('window.__finishOnce()')
    await page.getByText('新的回复', { exact: true }).waitFor()
    expect(await page.locator('.yy-ai-messages .yy-msg-assistant').count()).toBe(1)
    expect(await page.locator('.yy-msg-user').count()).toBe(1)
    await page.getByRole('button', { name: '复制 Markdown' }).click()
    await expect.poll(() => page.evaluate('window.__desktopAi.copied')).toBe('**新的回复**')

    await page.getByRole('combobox', { name: '添加上下文' }).click()
    await page.getByRole('option', { name: '全文' }).click()
    await page.getByRole('combobox', { name: '写作操作' }).click()
    await page.getByRole('option', { name: '扩写' }).click()
    await page.evaluate('window.__desktopAi.changeDocument()')
    await composer.fill('写作范围已经修改')
    await send.click()
    await page.getByText('已选上下文发生变化，请重新添加后发送').waitFor()
    expect(await composer.inputValue()).toBe('写作范围已经修改')
    expect(await page.evaluate('window.__desktopAi.observed.length')).toBe(3)
    await page.getByRole('combobox', { name: '写作操作' }).click()
    await page.getByRole('option', { name: '对话', exact: true }).click()
    await chats.click()
    await manage.getByRole('button', { name: '设备复核', exact: true }).click()
    await chats.click()
    await manage.getByRole('button', { name: '压缩上下文' }).click()
    await manage.getByText('已压缩 4 条消息').waitFor()
    await manage.getByRole('button', { name: '关闭' }).click()
    expect(await page.getByText('只保留在原始记录的标记', { exact: true }).count()).toBe(1)
    await page.getByRole('button', { name: '智能体', exact: true }).click()
    await composer.fill('继续旧项目')
    await send.click()
    await page.getByRole('heading', { name: '智能体结论' }).waitFor()
    await page.getByRole('list', { name: '执行计划' }).getByText('整理摘要任务').waitFor()
    const request = JSON.stringify(await page.evaluate('window.__desktopAi.observed.at(-1).request'))
    expect(request).toContain('已压缩的历史重点')
    expect(request).not.toContain('只保留在原始记录的标记')
    expect(await page.evaluate('window.__desktopAi.archive.conversations.length')).toBe(2)
    await page.evaluate('window.__desktopAi.reload()')
    await page.getByRole('heading', { name: '智能体结论' }).waitFor()
    await chats.click()
    await manage.getByRole('button', { name: '删除 检查连续提交' }).click()
    await manage.getByRole('button', { name: '确认删除' }).click()
    await expect.poll(() => page.evaluate('window.__desktopAi.archive.conversations.length')).toBe(1)

    await manage.getByRole('button', { name: '关闭' }).click()
    await page.evaluate(() => {
      const fixture = (window as unknown as Record<string, any>).__desktopAi
      const chat = fixture.archive.conversations[0]
      chat.summary = ''
      chat.covered = 0
      chat.messages = [
        { role: 'user', text: '需要自动压缩的旧段'.repeat(3000) }, { role: 'assistant', text: '确认旧段' },
        ...Array.from({ length: 3 }, (_, i) => [{ role: 'user', text: '保留的问题 ' + i }, { role: 'assistant', text: '保留的回答 ' + i }]).flat(),
      ]
    })
    await page.evaluate('window.__desktopAi.reload()')
    await composer.fill('验证自动压缩')
    await send.click()
    await page.getByRole('heading', { name: '智能体结论' }).waitFor()
    expect(await page.evaluate('window.__desktopAi.observed.slice(-3).map(item => item.command)'))
      .toEqual(['ai_stream', 'ai_agent_turn', 'ai_agent_turn'])
    const shortened = JSON.stringify(await page.evaluate('window.__desktopAi.observed.at(-1).request'))
    expect(shortened).toContain('已压缩的历史重点')
    expect(shortened).toContain('保留的问题 2')
    expect(shortened).not.toContain('需要自动压缩的旧段')
  }, 20000)

  it('提取待办只显示本轮核对过的事项，普通和智能体模式共用校验', async () => {
    await mountTestHarness()
    await page.evaluate(String.raw`(async () => {
      const { mockIPC } = await import('/node_modules/@tauri-apps/api/mocks.js')
      const { Writing } = await import('/src/ai.ts')
      const { shell, editor } = window.__test
      const endpoint = 'https://models.example.test/v1'
      const scope = 'fixture\n' + endpoint
      const archive = {
        conversations: [{ id: 'old', scope, title: '旧对话', summary: '', covered: 0, updated: 1,
          messages: [{ role: 'assistant', text: '- [ ] 上次会话的待办' }] }],
        selected: { [scope]: 'old' },
      }
      const requests = window.__actionRequests = []
      mockIPC(async (command, data) => {
        if (command === 'ai_settings') return {
          providers: [{ id: 'fixture', endpoint, protocol: 'chat', name: '测试模型', models: ['writer'], hasKey: false }],
          active: { providerId: 'fixture', model: 'writer' },
        }
        if (command === 'ai_conversations') return data?.value ? null : archive
        if (command !== 'ai_stream' && command !== 'ai_agent_turn') return null
        requests.push({ command, messages: data.messages ?? data.request.messages })
        if (command === 'ai_agent_turn') return { text: '[1]', calls: [], output: [] }
        const send = frame => window.__TAURI_INTERNALS__.runCallback(data.event.id, frame)
        send({ index: 0, message: { kind: 'delta', text: '[99,1' } })
        await new Promise(resolve => { window.__finishActions = resolve })
        send({ index: 1, message: { kind: 'delta', text: ',1]' } })
        send({ index: 2, message: { kind: 'done' } })
        send({ index: 3, end: true })
        return null
      })
      editor.setMarkdown('# 会议记录\n- [ ] 提交新报价\n- [x] 整理安装笔记\n\n## 已归档\n- [ ] 封装旧版海报')
      const writing = new Writing(view => shell.setAI(view))
      window.__test.dispatch = async action => {
        if (action.type === 'ai-send') await writing.send(action.intent, action.prompt, editor, 1, 1, { agent: action.agent })
        if (action.type === 'ai-context') writing.preview(action.scope, editor, 1, 1, '会议记录.md')
      }
      await writing.load()
    })()`)
    await page.locator('[data-toggle="ai"]').click()
    await page.getByRole('combobox', { name: '写作操作' }).click()
    await page.getByRole('option', { name: '提取待办' }).click()
    const attach = async () => {
      await page.getByRole('combobox', { name: '添加上下文' }).click()
      await page.getByRole('option', { name: '全文' }).click()
    }
    const send = page.getByRole('button', { name: '发送', exact: true })
    const composer = page.getByLabel('AI 指令输入')
    const replies = page.locator('.yy-ai-messages .yy-msg-assistant')
    await composer.fill('请根据以下材料提取待办。周五提交报价单。旧版海报已经归档。安装文档已完成。明天还需检查库存。')
    await send.click()
    await replies.last().getByText('明天还需检查库存', { exact: true }).waitFor()
    expect((await replies.last().locator('li').allTextContents()).map(text => text.trim()))
      .toEqual(['周五提交报价单', '明天还需检查库存'])
    expect(await page.evaluate('window.__actionRequests.length')).toBe(0)

    await attach()
    await send.click()
    await replies.last().getByText('提交新报价', { exact: true }).waitFor()
    expect(await page.evaluate('window.__actionRequests.length')).toBe(0)

    await composer.fill('只看报价相关的待办')
    await send.click()
    await expect.poll(() => page.evaluate('typeof window.__finishActions')).toBe('function')
    expect(await page.locator('.yy-ai-conversation').getByText('[99,1').count()).toBe(0)
    await page.evaluate('window.__finishActions()')
    await expect.poll(() => replies.count()).toBe(4)
    await replies.last().getByText('提交新报价', { exact: true }).waitFor()
    expect(await replies.last().locator('li').count()).toBe(1)
    expect(await replies.last().locator('input[type="checkbox"]').count()).toBe(1)
    const requests = () => page.evaluate('window.__actionRequests') as Promise<{ command: string; messages: { text: string }[] }[]>
    const [request] = await requests()
    expect(request.messages).toHaveLength(2)
    expect(request.messages.at(-1)?.text).toContain('1. 提交新报价')
    expect(request.messages.at(-1)?.text).not.toMatch(/安装笔记|旧版海报|上次会话/)

    await page.getByRole('button', { name: '智能体', exact: true }).click()
    await composer.fill('只看报价相关的待办')
    await send.click()
    await expect.poll(() => replies.count()).toBe(5)
    expect((await requests())[1].command).toBe('ai_agent_turn')
    expect(await replies.last().locator('li').count()).toBe(1)

    await page.evaluate("window.__test.editor.setMarkdown('- [x] 提交新报价\\n\\n## 已归档\\n- [ ] 上一期记录')")
    await attach()
    await send.click()
    await replies.last().getByText('没有找到明确的待办事项。', { exact: true }).waitFor()
    expect(await requests()).toHaveLength(2)
  }, 15000)

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
    expect(await promptsDialog.locator('.yy-ai-task-choice').count()).toBe(12)
    await promptsDialog.getByRole('button', { name: '改写', exact: true }).click()
    const defaultRewrite = await template.inputValue()
    expect(defaultRewrite).toContain('保留原有事实')
    await promptsDialog.getByText('预览完整提示词', { exact: true }).click()
    expect(await promptsDialog.getByLabel('完整提示词').textContent()).toContain('链接目标')
    await template.fill('保留专名，将段落缩为两句。')
    expect(await promptsDialog.getByLabel('完整提示词').textContent()).toContain('保留专名，将段落缩为两句。')
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
    expect(await page.getByRole('option').count()).toBe(12)
    expect(await page.getByRole('option', { name: '精简' }).count()).toBe(1)
    expect(await page.getByRole('option', { name: '提取待办' }).count()).toBe(1)
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

  it('软件更新从帮助菜单进入，支持签名更新和 DEB 应用内下载', async () => {
    const api = 'https://api.github.com/repos/Lw5959/yeyu/releases/latest'
    await page.route(api, route => route.abort())
    try {
      await page.goto(baseUrl + '/__ui_harness__')
      await page.evaluate(`(async () => {
        const { mockIPC, mockWindows } = await import('/node_modules/@tauri-apps/api/mocks.js')
        const test = window.__updates = { checks: [], writes: [], operations: [], package: false, ready: false }
        test.release = { version: '9.0.1', notes: '<b>桌面发布说明</b>' }
        mockWindows('main')
        mockIPC((cmd, args) => {
          switch (cmd) {
            case 'plugin:app|version': return '0.2.5'
            case 'plugin:dialog|save': return args.options?.defaultPath?.endsWith('.deb') ? '/tmp/页屿更新.deb' : '/tmp/页屿更新测试.md'
            case 'theme_list': case 'plugin_list': case 'typora_theme_paths': return []
            case 'ai_settings': return { providers: [], active: null }
            case 'launch_paths': test.ready = true; return []
            case 'document_version': return test.writes.length ? '1' : null
            case 'save_document':
              test.operations.push('save')
              test.writes.push(args.text)
              return { ...args, version: '1', name: '页屿更新测试.md' }
            case 'save_recovery': if (!args.recovery) test.operations.push('checkpoint'); return
            case 'update_package': return test.package
            case 'update_check_package': return { version: '9.0.1', notes: 'DEB 发布说明' }
            case 'update_download_package': {
              test.downloadedVersion = args.version
              const send = event => window.__TAURI_INTERNALS__.runCallback(args.progress.id, event)
              send({ index: 0, message: { kind: 'download', downloaded: 524288, total: 1048576 } })
              return new Promise(resolve => {
                test.finishDownload = () => {
                  send({ index: 1, message: { kind: 'verify' } })
                  send({ index: 2, end: true })
                  resolve()
                }
              })
            }
            case 'update_open_package': test.openedVersion = args.version; return 'save'
            case 'update_save_package': test.savedPackage = args; return
            case 'update_check': return new Promise((resolve, reject) => test.checks.push({ resolve, reject }))
            case 'update_install': {
              test.operations.push('install')
              test.installedVersion = args.version
              let index = 0
              const send = data => window.__TAURI_INTERNALS__.runCallback(args.progress.id, { index: index++, ...data })
              test.progress = message => send({ message })
              return new Promise((_, reject) => {
                test.failInstall = () => { send({ end: true }); reject('https://example.invalid/?token=fixture-secret') }
              })
            }
            case 'visit_link': test.visited = args.url; return
            default: return null
          }
        }, { shouldMockEvents: true })
        await import('/src/main.ts')
      })()`)
      await expect.poll(() => page.evaluate('window.__updates.ready')).toBe(true)
      const dialog = page.getByRole('dialog', { name: '软件更新' })
      const openUpdate = async (count: number) => {
        await page.getByRole('menuitem', { name: '帮助', exact: true }).click()
        await page.getByRole('menuitem', { name: '检查更新…', exact: true }).click()
        await expect.poll(() => page.evaluate('window.__updates.checks.length')).toBe(count)
      }
      await openUpdate(1)
      await dialog.getByText('当前版本 0.2.5').waitFor()
      await dialog.getByText('正在检查更新…').waitFor()
      const box = (await dialog.boundingBox())!
      const viewport = page.viewportSize()!
      expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(2)
      expect(Math.abs(box.y + box.height / 2 - viewport.height / 2)).toBeLessThan(5)
      await dialog.getByRole('button', { name: '关闭' }).click()
      expect(await page.getByRole('menuitem', { name: '帮助', exact: true }).evaluate(el => document.activeElement === el)).toBe(true)
      await openUpdate(2)
      await page.evaluate('window.__updates.checks[0].resolve({ version: "8.0.0", notes: "旧结果" })')
      await dialog.getByText('正在检查更新…').waitFor()
      expect(await dialog.getByText('旧结果').count()).toBe(0)
      await page.evaluate('window.__updates.checks[1].resolve(null)')
      await dialog.getByText('已是最新版本').waitFor()
      await dialog.getByRole('button', { name: '关闭' }).click()

      await page.locator('.cm-content').click()
      await page.keyboard.insertText('更新前保存的笔记')
      await openUpdate(3)
      await page.evaluate('window.__updates.checks[2].reject("网络错误")')
      await dialog.getByText('检查更新失败').waitFor()
      await dialog.getByRole('button', { name: '重试' }).click()
      await expect.poll(() => page.evaluate('window.__updates.checks.length')).toBe(4)
      await page.evaluate('window.__updates.checks[3].resolve(window.__updates.release)')
      await dialog.getByText('<b>桌面发布说明</b>', { exact: true }).waitFor()
      const install = dialog.getByRole('button', { name: '安装更新' })
      const guard = page.locator('.app-dialog').filter({ has: page.getByRole('heading', { name: '未保存的编辑' }) })
      await install.click()
      await guard.getByRole('button', { name: '继续编辑' }).click()
      await dialog.waitFor({ state: 'hidden' })
      expect(await page.evaluate('window.__updates.installedVersion')).toBeUndefined()

      await openUpdate(5)
      await page.evaluate('window.__updates.checks[4].resolve(window.__updates.release)')
      await install.click()
      await guard.getByRole('button', { name: '保存', exact: true }).click()
      await expect.poll(() => page.evaluate('window.__updates.installedVersion')).toBe('9.0.1')
      expect(await page.evaluate('window.__updates.writes')).toEqual(['更新前保存的笔记'])
      expect(await page.evaluate('window.__updates.operations.slice(-2)')).toEqual(['checkpoint', 'install'])
      expect(await dialog.getByRole('button', { name: '关闭' }).isEnabled()).toBe(false)

      const progress = dialog.getByRole('progressbar', { name: '下载进度' })
      await page.evaluate('window.__updates.progress({ kind: "download", downloaded: 16, total: null })')
      await dialog.getByText('已下载 16 B').waitFor()
      expect(await progress.getAttribute('value')).toBeNull()
      await page.evaluate('window.__updates.progress({ kind: "download", downloaded: 524288, total: 1048576 })')
      await dialog.getByText('512.0 KiB / 1.0 MiB · 50%').waitFor()
      expect(await progress.getAttribute('value')).toBe('524288')
      await page.evaluate('window.__updates.progress({ kind: "install" })')
      await dialog.getByText('正在校验签名并安装…').waitFor()
      await page.evaluate('window.__updates.failInstall()')
      await dialog.getByText('更新未完成').waitFor()
      expect(await dialog.innerText()).not.toContain('fixture-secret')

      await page.evaluate('window.__updates.package = true')
      await dialog.getByRole('button', { name: '重试' }).click()
      await dialog.getByRole('button', { name: '下载更新' }).click()
      await dialog.getByText('512.0 KiB / 1.0 MiB · 50%').waitFor()
      expect(await page.evaluate('window.__updates.downloadedVersion')).toBe('9.0.1')
      expect(await dialog.getByRole('button', { name: '打开安装包' }).count()).toBe(0)
      await page.evaluate('window.__updates.finishDownload()')
      await dialog.getByText('安装包已校验，可以开始安装。').waitFor()
      await dialog.getByRole('button', { name: '打开安装包' }).click()
      await dialog.getByRole('button', { name: '保存安装包' }).click()
      await dialog.getByText('安装包已保存').waitFor()
      expect(await page.evaluate('window.__updates.openedVersion')).toBe('9.0.1')
      expect(await page.evaluate('window.__updates.savedPackage')).toEqual({ version: '9.0.1', path: '/tmp/页屿更新.deb' })
      expect(await page.evaluate('window.__updates.visited')).toBeUndefined()
      expect(await progress.count()).toBe(0)
      await dialog.getByRole('button', { name: '关闭' }).click()
    } finally {
      await page.unroute(api)
    }
  }, 15000)

  it('Android 从首页手动打开文档，工具使用独立页面并支持系统返回', async () => {
    await page.setViewportSize({ width: 390, height: 736 })
    const updates = 'https://api.github.com/repos/Lw5959/yeyu/releases/latest'
    try {
      await page.route(updates, route => route.abort())
      await page.goto(`${baseUrl}/__ui_harness__`)
      await page.evaluate(`(async () => {
        const { mockIPC } = await import('/node_modules/@tauri-apps/api/mocks.js')
        const path = 'content://qa/document/01'
        const document = { uri: path, name: '移动笔记.md', text: '# 标题\\r\\n\\r\\n正文\\n', bom: true, version: '1', writable: true }
        const writes = []
        const reads = []
        const installed = []
        const modelRequests = []
        const bundled = { id: 'table-format', name: '表格排版', version: '1.0.0', apiVersion: 1, sha256: 'a'.repeat(64),
          description: '整理表格', author: '页屿', license: 'MIT' }
        const builtins = () => ({ name: '内置插件', source: null, plugins: [{ ...bundled,
          availability: installed.length ? 'installed' : 'install', installedVersion: installed[0]?.version ?? null }] })
        let picks = 0
        const updateOps = window.__mobileUpdate = []
        let installerOpens = 0
        mockIPC((cmd, payload) => {
          if (cmd === 'android_pick') { picks++; return path }
          if (cmd === 'android_read') { reads.push(payload.uri); return document }
          if (cmd === 'android_write') { writes.push(payload); return { ...document, text: payload.text, version: '2' } }
          if (cmd === 'android_load_session') return { uri: 'content://qa/last-note', theme: 'default', animations: true, mode: 'live' }
          if (cmd === 'android_insets') return { top: 26, bottom: 10, left: 0, right: 0 }
          if (cmd === 'plugin:app|version') return '0.2.8'
          if (cmd === 'update_check_package') return { version: '0.2.14', notes: '应用内更新' }
          if (cmd === 'update_download_package') {
            updateOps.push('下载 ' + payload.version)
            const send = event => window.__TAURI_INTERNALS__.runCallback(payload.progress.id, event)
            send({ index: 0, message: { kind: 'download', downloaded: 1024, total: 2048 } })
            return new Promise(resolve => { window.__finishMobileDownload = () => {
              send({ index: 1, message: { kind: 'verify' } })
              send({ index: 2, end: true })
              resolve()
            } })
          }
          if (cmd === 'update_open_package') {
            updateOps.push('安装 ' + payload.version)
            return installerOpens++ === 0 ? 'permission' : 'installer'
          }
          if (cmd === 'visit_link' || cmd === 'android_open_update') updateOps.push('打开浏览器')
          if (cmd === 'ai_settings') return { providers: [], active: null }
          if (cmd === 'ai_list_models') { modelRequests.push(payload.request); return ['local-edit'] }
          if (cmd === 'plugin_list') return installed
          if (cmd === 'plugin_market_list') return payload.source ? { name: '页屿插件市场', source: payload.source, plugins: [] } : builtins()
          if (cmd === 'plugin_market_install' && payload.source === null && payload.id === bundled.id && payload.sha256 === bundled.sha256) {
            installed.push({ id: bundled.id, name: bundled.name, version: bundled.version, enabled: false, commands: [] })
            return { installed, catalog: builtins() }
          }
          return null
        })
        window.__mobileWrites = writes
        window.__mobileModelRequests = modelRequests
        window.__mobileStartup = () => ({ picks, reads })
        await import('/src/mobile.ts')
      })()`)
      await expect.poll(() => page.evaluate('window.__mobileStartup()')).toEqual({ picks: 0, reads: [] })
      expect(await page.locator('.yy-paper').isVisible()).toBe(false)
      expect(await page.getByRole('button', { name: '新建 Markdown' }).isVisible()).toBe(true)
      const open = page.getByRole('button', { name: '打开文件' })
      expect((await open.boundingBox())!.width).toBeGreaterThanOrEqual(44)
      await open.click()
      await page.getByRole('heading', { name: '移动笔记.md' }).waitFor()
      await page.getByRole('button', { name: '源码', exact: true }).click()
      expect(await page.locator('#write').getAttribute('data-mode')).toBe('source')
      await page.locator('.cm-content .cm-line').last().click()
      await page.keyboard.insertText('Android')
      await page.setViewportSize({ width: 390, height: 218 })
      await expect.poll(() => page.evaluate(() => {
        const paper = document.querySelector('.yy-paper')!
        const selection = document.getSelection()!
        const range = selection.getRangeAt(0).getBoundingClientRect()
        const focus = selection.focusNode
        const element = focus instanceof Element ? focus : focus?.parentElement
        const caret = range.height ? range : element?.closest('.cm-line')?.getBoundingClientRect()
        const visible = paper.getBoundingClientRect()
        return !!caret && paper.scrollTop > 0 && caret.top >= visible.top - 1 && caret.bottom <= visible.bottom + 1
      })).toBe(true)
      await page.setViewportSize({ width: 390, height: 736 })
      await page.getByRole('button', { name: '保存文档' }).click()
      await expect.poll(() => page.evaluate(() => ((window as unknown as Record<string, any>).__mobileWrites).length)).toBe(1)
      const [saved] = await page.evaluate(() => (window as unknown as Record<string, any>).__mobileWrites)
      expect(saved).toMatchObject({ uri: 'content://qa/document/01', bom: true, expected: '1' })
      expect(saved.text).toBe('# 标题\r\n\r\n正文\nAndroid')

      await page.getByRole('button', { name: '文档主题', exact: true }).click()
      const themePage = page.getByRole('region', { name: '文档主题' })
      const themeTitle = themePage.getByRole('heading', { name: '文档主题' })
      expect((await themeTitle.boundingBox())!.y).toBeGreaterThanOrEqual(26)
      await themePage.getByRole('button', { name: '返回', exact: true }).click()

      await page.setViewportSize({ width: 820, height: 420 })
      await page.getByRole('button', { name: '文档主题', exact: true }).click()
      const box = (await themePage.boundingBox())!
      expect(box.y + box.height).toBeLessThanOrEqual(420)
      await themePage.getByRole('button', { name: '石墨' }).click()
      expect(await page.locator('html').getAttribute('data-yeyu-appearance')).toBe('dark')

      await page.getByRole('button', { name: '文档主题', exact: true }).click()
      const more = page.getByRole('button', { name: '更多操作' })
      const menu = page.getByRole('region', { name: '文档操作' })
      const back = () => page.evaluate(() => window.dispatchEvent(new Event('yeyu:android-back', { cancelable: true })))
      expect(await themePage.getByRole('button', { name: '石墨' }).getAttribute('aria-pressed')).toBe('true')
      expect(await back()).toBe(false)
      await themePage.waitFor({ state: 'hidden' })
      await more.click()
      await menu.getByRole('button', { name: 'AI 写作', exact: true }).click()
      const writing = page.getByRole('region', { name: 'AI 写作助手' })
      await writing.getByRole('button', { name: '模型配置', exact: true }).click()
      const models = page.getByRole('region', { name: '模型配置', exact: true })
      await models.waitFor()
      await models.getByLabel('API 地址').fill('http://192.0.2.10:8080/v1')
      await models.getByRole('button', { name: '获取模型' }).click()
      await models.getByRole('checkbox', { name: 'local-edit' }).check()
      await models.getByRole('button', { name: '添加所选' }).click()
      expect(await models.getByLabel('模型 ID 1').inputValue()).toBe('local-edit')
      expect(await page.evaluate('window.__mobileModelRequests[0]')).toMatchObject({
        endpoint: 'http://192.0.2.10:8080/v1', protocol: 'chat',
      })
      await back()
      await models.waitFor({ state: 'hidden' })
      expect(await writing.isVisible()).toBe(true)
      await writing.getByRole('button', { name: '默认提示词', exact: true }).click()
      const prompts = page.getByRole('region', { name: '默认提示词', exact: true })
      await prompts.getByRole('button', { name: '返回' }).click()
      await back()
      await writing.waitFor({ state: 'hidden' })

      await menu.getByRole('button', { name: 'MCP 工具', exact: true }).click()
      const protocol = page.getByRole('region', { name: 'MCP 连接与工具' })
      await protocol.getByRole('button', { name: '添加服务' }).click()
      expect(await protocol.getByRole('textbox', { name: '远端 HTTP 地址 (URL)' }).isVisible()).toBe(true)
      expect(await protocol.getByRole('button', { name: '授权工作区' }).count()).toBe(0)
      await protocol.getByRole('button', { name: '返回' }).click()

      await menu.getByRole('button', { name: '插件市场', exact: true }).click()
      const plugins = page.getByRole('region', { name: '插件管理', exact: true })
      const market = plugins.getByRole('button', { name: '内置插件', exact: true })
      await market.click()
      expect(await market.getAttribute('aria-pressed')).toBe('true')
      expect(await plugins.getByRole('group', { name: '插件页面' }).getByRole('button').allTextContents()).toEqual(['在线市场', '内置插件', '已安装'])
      expect(await page.locator('dialog[open], .yy-modal-backdrop').count()).toBe(0)
      expect(await plugins.getByRole('heading', { name: '插件管理', exact: true }).count()).toBe(1)
      expect(await plugins.getByRole('searchbox', { name: '搜索插件' }).evaluate(input => input === document.activeElement)).toBe(false)
      const tablePlugin = plugins.getByRole('article', { name: '表格排版' })
      await tablePlugin.getByRole('button', { name: '安装', exact: true }).click()
      await tablePlugin.getByRole('button', { name: '已安装', exact: true }).click()
      await tablePlugin.getByRole('button', { name: '启用', exact: true }).waitFor()
      expect(await back()).toBe(false)
      await plugins.waitFor({ state: 'hidden' })
      await menu.getByRole('button', { name: '检查更新', exact: true }).click()
      const update = page.getByRole('region', { name: '软件更新' })
      await update.getByRole('button', { name: '下载更新' }).click()
      await update.getByText('1.0 KiB / 2.0 KiB · 50%').waitFor()
      await page.evaluate('window.__finishMobileDownload()')
      const install = update.getByRole('button', { name: '安装更新' })
      await install.click()
      await update.getByText('需要安装授权').waitFor()
      await install.click()
      await update.getByText('已打开安装包').waitFor()
      expect(await page.evaluate('window.__mobileUpdate')).toEqual(['下载 0.2.14', '安装 0.2.14', '安装 0.2.14'])
      expect(await page.locator('dialog[open], .yy-modal-backdrop').count()).toBe(0)
      await back()
      await update.waitFor({ state: 'hidden' })
      await menu.getByRole('button', { name: '返回' }).click()
      expect(await page.getByRole('heading', { name: '移动笔记.md' }).isVisible()).toBe(true)
      expect(await page.locator('.cm-content').innerText()).toContain('Android')
    } finally {
      await page.unroute(updates)
      await page.setViewportSize({ width: 1360, height: 860 })
    }
  }, 15000)

  it('Android 智能体多轮读取授权文档，审阅后才写入，可取消和重试', async () => {
    const phone = await browser.newPage({ viewport: { width: 390, height: 760 }, isMobile: true, hasTouch: true })
    phone.setDefaultTimeout(5000)
    const source = '# 项目说明\r\n\r\n旧述第一段。\r\n\r\n待保留的内部文字。\r\n\r\n旧述第二段。\r\n'
    try {
      await phone.addInitScript(text => {
        const uri = 'content://qa/document/agent'
        const document = { uri, name: '智能体试稿.md', text, version: '1', bom: true, writable: true }
        const native = window as unknown as Record<string, any>
        const requests: any[] = []
        const writes: any[] = []
        const channels = new Map<number, (event: unknown) => void>()
        let callback = 0
        let stop: (() => void) | undefined
        let cancellations = 0
        native.__agentFixture = { requests, writes }
        const call = (id: string, name: string, args: object) => ({ id, name, arguments: JSON.stringify(args) })
        native.__TAURI_INTERNALS__ = {
          transformCallback(fn: (event: unknown) => void) { channels.set(++callback, fn); return callback },
          unregisterCallback(id: number) { channels.delete(id) },
          async invoke(cmd: string, payload: any) {
            if (cmd === 'android_pick') return uri
            if (cmd === 'android_read') return document
            if (cmd === 'android_write') { writes.push(payload); return { ...document, text: payload.text, version: '2' } }
            if (cmd === 'ai_settings') return {
              providers: [{ id: 'fixture', name: '测试服务', endpoint: 'https://agent.example.test/v1', protocol: 'chat', models: ['write'], hasKey: false }],
              active: { providerId: 'fixture', model: 'write' },
            }
            if (cmd === 'ai_cancel') { cancellations++; stop?.(); return null }
            if (cmd !== 'ai_agent_turn') return null
            const { request, event } = payload
            requests.push(structuredClone(request))
            const respond = (text: string, calls: ReturnType<typeof call>[] = []) => {
              const send = channels.get(event.id)
              if (text) send?.({ index: 0, message: { kind: 'delta', text } })
              send?.({ index: text ? 1 : 0, end: true })
              return { text, calls, output: [{ role: 'assistant', content: text, tool_calls: calls }] }
            }
            if (request.messages.at(-1).text.endsWith('测试取消')) {
              if (cancellations) return respond('重试完成')
              return new Promise(resolve => { stop = () => { channels.delete(event.id); resolve(null) } })
            }
            if (!request.history.length) return respond('', [
              call('find', 'search_documents', { query: '旧述' }),
              call('outline', 'document_outline', { document: 1 }),
              call('unavailable', 'read_document', { document: 99, start_line: 1, end_line: 1 }),
            ])
            if (request.history.length === 1) return respond('', [
              call('read1', 'read_document', { document: 1, start_line: 3, end_line: 3 }),
              call('read2', 'read_document', { document: 1, start_line: 7, end_line: 7 }),
            ])
            if (request.history.length === 2) return respond('', [
              call('edit1', 'propose_edit', { start_line: 3, end_line: 3, markdown: '第一处建议。' }),
              call('edit2', 'propose_edit', { start_line: 7, end_line: 7, markdown: '第二处建议。' }),
            ])
            return respond('已提出**两处修改**')
          },
        }
      }, source)
      await phone.goto(baseUrl + '/mobile.html')
      await phone.getByRole('button', { name: '打开文件', exact: true }).tap()
      await phone.getByRole('heading', { name: '智能体试稿.md' }).waitFor()
      const openAi = async () => {
        await phone.getByRole('button', { name: '更多操作' }).tap()
        await phone.getByRole('button', { name: 'AI 写作', exact: true }).tap()
      }
      await openAi()
      const writing = phone.getByRole('region', { name: 'AI 写作助手' })
      const agent = writing.getByRole('button', { name: '智能体', exact: true })
      const composer = writing.getByLabel('AI 指令输入')
      await agent.tap()
      await writing.getByRole('combobox', { name: '添加上下文' }).tap()
      await phone.getByRole('option', { name: '全文' }).tap()
      expect(await writing.getByLabel('上下文全文预览').textContent()).toBe(source)
      await composer.fill('整理两处项目描述')
      const send = writing.getByRole('button', { name: '发送', exact: true })
      const dimensions = (button: typeof send) => button.evaluate(element => {
        const control = element as HTMLButtonElement
        return [control.offsetWidth, control.offsetHeight]
      })
      expect(await dimensions(send)).toEqual([44, 44])
      await send.tap()
      await writing.getByText('智能体已完成', { exact: true }).waitFor()
      expect(await writing.locator('.yy-ai-messages .yy-ai-markdown strong').textContent()).toBe('两处修改')
      expect(await writing.getByRole('list', { name: '智能体步骤' }).getByRole('listitem').count()).toBe(7)
      const diff = writing.getByRole('region', { name: '差异审阅建议' })
      expect(await diff.locator('[data-hunk]').count()).toBe(2)
      const requests = await phone.evaluate('window.__agentFixture.requests') as {
        id: string
        messages: { text: string }[]
        history: { results: { id: string; error: boolean; content: string }[] }[]
      }[]
      expect(requests).toHaveLength(4)
      expect(JSON.stringify(requests)).not.toContain('待保留的内部文字')
      expect(requests[0].messages.at(-1)!.text).not.toContain('旧述第一段')
      expect(JSON.parse(requests[1].history[0].results[0].content).matches.map((item: { line: number }) => item.line)).toEqual([3, 7])
      expect(requests[1].history[0].results[2]).toMatchObject({ id: 'unavailable', error: true })
      expect(JSON.parse(requests[2].history[1].results[0].content).markdown).toBe('旧述第一段。')
      expect(await phone.evaluate('window.__agentFixture.writes.length')).toBe(0)
      await diff.getByRole('button', { name: '全部应用' }).tap()
      await phone.getByRole('button', { name: '保存文档' }).tap()
      const after = source.replace('旧述第一段。', '第一处建议。').replace('旧述第二段。', '第二处建议。')
      await expect.poll(() => phone.evaluate('window.__agentFixture.writes[0]')).toMatchObject({ text: after, bom: true })

      await openAi()
      await phone.setViewportSize({ width: 280, height: 760 })
      await phone.addStyleTag({ content: '.yy-ai-composer-tools button { font-size: 18px !important }' })
      await composer.fill('测试取消')
      expect(await dimensions(send)).toEqual([44, 44])
      await send.tap()
      const stop = writing.getByRole('button', { name: '取消生成' })
      await stop.waitFor()
      expect(await dimensions(stop)).toEqual([44, 44])
      await stop.tap()
      await writing.getByText('智能体已取消', { exact: true }).waitFor()
      await writing.getByRole('button', { name: '重试上次请求' }).tap()
      await writing.getByText('重试完成', { exact: true }).waitFor()
      const last = await phone.evaluate('window.__agentFixture.requests.slice(-2)') as typeof requests
      expect(last[0].id).not.toBe(last[1].id)
      expect(last[0].messages).toEqual(last[1].messages)
      await writing.locator('.yy-ai-messages .yy-msg-assistant').last().getByRole('button', { name: '插入文档' }).tap()
      const insertReview = writing.getByRole('region', { name: '差异审阅建议' })
      await insertReview.getByText('插入 AI 回复', { exact: true }).waitFor()
      expect(await phone.evaluate('window.__agentFixture.writes.length')).toBe(1)
      await insertReview.getByRole('button', { name: '全部应用' }).tap()
      await phone.getByRole('button', { name: '保存文档' }).tap()
      await expect.poll(() => phone.evaluate('window.__agentFixture.writes[1]?.text')).toMatch(/(?:\r\n重试完成|重试完成\r\n)/)
      await openAi()
      await writing.getByRole('button', { name: '对话管理' }).tap()
      const conversations = phone.getByRole('region', { name: '对话管理' })
      await conversations.getByRole('button', { name: '新建对话' }).tap()
      await writing.waitFor()
      expect(await writing.locator('.yy-msg-user').count()).toBe(0)
    } finally {
      await phone.close()
    }
  }, 15000)

  it('Android 页面有进出动效，预测返回可跟手、取消与提交', async () => {
    const phone = await browser.newPage({ viewport: { width: 390, height: 736 }, isMobile: true, hasTouch: true })
    phone.setDefaultTimeout(5000)
    try {
      await phone.addInitScript(() => {
        const uri = 'content://qa/document/predictive-back'
        const native = window as unknown as Record<string, unknown>
        const backStates: { enabled: boolean; animated: boolean }[] = []
        native.__backStates = backStates
        native.__TAURI_INTERNALS__ = { invoke: async (cmd: string, args: { enabled: boolean; animated: boolean }) => {
          if (cmd === 'android_pick') return uri
          if (cmd === 'android_read') return { uri, name: '返回测试.md', text: '# 原始正文\n', bom: false, version: '1', writable: true }
          if (cmd === 'android_load_session') return { theme: 'default', animations: true, mode: 'source' }
          if (cmd === 'android_back_navigation') backStates.push({ enabled: args.enabled, animated: args.animated })
          if (cmd === 'ai_settings') return { providers: [], active: null }
          return null
        } }
      })
      await phone.goto(`${baseUrl}/mobile.html`)
      const nativeBack = () => phone.evaluate('window.__backStates.at(-1)')
      const gesture = (phase: 'start' | 'progress' | 'cancel', progress = 0, edge = 'left') => phone.evaluate(detail => {
        window.dispatchEvent(new CustomEvent('yeyu:android-back-gesture', { detail }))
      }, { phase, progress, edge })
      const back = () => phone.evaluate(() => window.dispatchEvent(new Event('yeyu:android-back', { cancelable: true })))
      const preview = phone.locator('[data-yeyu-back-preview]')
      const transform = () => preview.evaluate(element => {
        const matrix = new DOMMatrix(getComputedStyle(element).transform)
        return { x: matrix.m41, scale: matrix.m11 }
      })
      const more = phone.getByRole('button', { name: '更多操作' })
      const actions = phone.getByRole('region', { name: '文档操作' })
      const doc = phone.getByRole('heading', { name: '返回测试.md' })

      await expect.poll(nativeBack).toEqual({ enabled: false, animated: true })
      expect(await back()).toBe(true)
      await phone.getByRole('button', { name: '打开文件', exact: true }).click()
      await doc.waitFor()
      await expect.poll(nativeBack).toEqual({ enabled: true, animated: true })
      expect(await phone.evaluate(() => {
        document.querySelector<HTMLButtonElement>('.yy-mobile-editor [aria-label="更多操作"]')!.click()
        return document.querySelector('.yy-tool-page')!.getAnimations().length > 0
      })).toBe(true)
      await gesture('start')
      await gesture('progress', .25)
      const early = await transform()
      await gesture('progress', .75)
      const later = await transform()
      expect(early.x).toBeGreaterThan(0)
      expect(later.x).toBeGreaterThan(early.x)
      expect(later.scale).toBeLessThan(early.scale)
      expect(await phone.locator('.yy-mobile-document-area').evaluate(layer => layer.hasAttribute('inert') && !layer.classList.contains('yy-editor-covered'))).toBe(true)
      await gesture('cancel')
      await preview.waitFor({ state: 'detached' })
      await actions.waitFor()
      expect(await phone.locator('.yy-mobile-document-area').evaluate(layer => layer.classList.contains('yy-editor-covered'))).toBe(true)

      await actions.getByRole('button', { name: 'AI 写作' }).click()
      const writing = phone.getByRole('region', { name: 'AI 写作助手' })
      await writing.getByRole('button', { name: '模型配置' }).click()
      const models = phone.getByRole('region', { name: '模型配置' })
      await models.waitFor()
      await gesture('start', 0, 'right')
      await gesture('progress', .6, 'right')
      expect((await transform()).x).toBeLessThan(0)
      expect(await phone.locator('section[aria-label="AI 写作助手"]').evaluate(layer => layer.hasAttribute('inert'))).toBe(true)
      expect(await phone.evaluate(() => [0, 1].map(() => window.dispatchEvent(new Event('yeyu:android-back', { cancelable: true })))))
        .toEqual([false, false])
      await models.waitFor({ state: 'detached' })
      await writing.waitFor()
      await gesture('start', 0, 'right')
      await gesture('progress', .6, 'right')
      expect(await phone.locator('section[aria-label="文档操作"]').evaluate(layer => layer.hasAttribute('inert'))).toBe(true)
      expect(await back()).toBe(false)
      await actions.waitFor()
      await actions.getByRole('button', { name: '返回' }).click()
      await doc.waitFor()

      await gesture('start')
      await gesture('progress', .65)
      expect(await phone.locator('.yy-mobile-home').evaluate(layer => !layer.hasAttribute('hidden') && layer.hasAttribute('inert'))).toBe(true)
      expect(await back()).toBe(false)
      await phone.getByRole('main', { name: '文件入口' }).waitFor()
      await expect.poll(nativeBack).toEqual({ enabled: false, animated: true })

      await phone.getByRole('button', { name: '打开文件', exact: true }).click()
      await phone.locator('.cm-content .cm-line').first().click()
      await phone.keyboard.insertText('本地草稿')
      await gesture('start')
      expect(await preview.count()).toBe(0)
      expect(await back()).toBe(false)
      await phone.getByRole('region', { name: '未保存的编辑' }).waitFor()
      expect(await back()).toBe(false)
      expect(await phone.locator('.cm-content').innerText()).toContain('本地草稿')

      await more.click()
      const animationSetting = actions.getByRole('button', { name: '界面动画' })
      await animationSetting.click()
      await expect.poll(nativeBack).toEqual({ enabled: true, animated: false })
      await gesture('start')
      expect(await preview.count()).toBe(0)
      await back()
      await doc.waitFor()
      await more.click()
      await animationSetting.click()
      await expect.poll(nativeBack).toEqual({ enabled: true, animated: true })
      await gesture('start')
      await gesture('progress', .4)
      expect(await preview.count()).toBe(1)
      await phone.emulateMedia({ reducedMotion: 'reduce' })
      await expect.poll(nativeBack).toEqual({ enabled: true, animated: false })
      expect(await preview.count()).toBe(0)
      await gesture('start')
      expect(await preview.count()).toBe(0)
      await back()
      await doc.waitFor()
    } finally {
      await phone.close()
    }
  }, 15000)

  it('Android 从大纲返回及触屏编辑表格时持续渲染，保存与源码切换保留原文', async () => {
    const phone = await browser.newPage({ viewport: { width: 390, height: 736 }, isMobile: true, hasTouch: true })
    phone.setDefaultTimeout(5000)
    const markdown = '# 手机写作\r\n\r\n## 表格示例\n\n| 项目 | 状态 |\r| :--- | ---: |\r\n| **原值** | 就绪 |\n'
    try {
      await phone.addInitScript(text => {
        const uri = 'content://qa/document/table-edit'
        const document = { uri, name: '单元格.md', text, version: '1', bom: true, writable: true }
        const native = window as unknown as Record<string, unknown>
        native.__tableWrites = []
        native.__TAURI_INTERNALS__ = { invoke: async (cmd: string, args: { text: string }) => {
          if (cmd === 'android_pick') return uri
          if (cmd === 'android_read') return document
          if (cmd === 'android_write') { native.__tableWrites = [args]; return { ...document, text: args.text, version: '2' } }
          return null
        } }
      }, markdown)
      await phone.goto(`${baseUrl}/mobile.html`)
      await phone.getByRole('button', { name: '打开文件', exact: true }).tap()
      await phone.getByRole('button', { name: '大纲', exact: true }).tap()
      await phone.getByRole('region', { name: '文档大纲' }).getByRole('button', { name: '表格示例' }).tap()
      const table = phone.getByRole('table')
      await table.getByRole('cell', { name: '就绪' }).tap()
      const cellEditor = table.locator('.live-cell-editor .cm-content')
      await cellEditor.waitFor()
      await cellEditor.press('End')
      await phone.keyboard.insertText('｜已核对|下一项')
      await cellEditor.waitFor()
      expect(await table.locator('strong').innerText()).toBe('原值')
      expect(await table.innerText()).toContain('已核对')
      const expected = markdown.replace('就绪', '就绪｜已核对\\|下一项')
      await phone.getByRole('button', { name: '保存文档' }).tap()
      await expect.poll(() => phone.evaluate('window.__tableWrites[0]')).toMatchObject({ text: expected, bom: true })
      await phone.getByRole('button', { name: '源码', exact: true }).tap()
      expect(await phone.locator('#write').innerText()).toContain('| **原值** | 就绪｜已核对\\|下一项 |')
      await phone.getByRole('button', { name: '实时', exact: true }).tap()
      await table.waitFor()
      await phone.getByRole('button', { name: '撤销', exact: true }).tap()
      await table.getByRole('cell', { name: '就绪', exact: true }).waitFor()
    } finally {
      await phone.close()
    }
  }, 15000)

  it('Android 实时编辑滚离长表格再返回时保留区块高度', async () => {
    const phone = await browser.newPage({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true })
    const rows = Array.from({ length: 30 }, (_, index) => `| 项目 ${index + 1} | ${'这是可以换行的单元格说明。'.repeat(4)} |`)
    const tail = Array.from({ length: 120 }, (_, index) => `后续正文 ${index + 1}`).join('\n\n')
    const markdown = ['# 长表格笔记', '', '| 项目 | 说明 |', '| --- | --- |', ...rows, '', tail].join('\n')
    try {
      await phone.addInitScript(text => {
        const uri = 'content://qa/document/table-scroll'
        const native = window as unknown as Record<string, unknown>
        native.__TAURI_INTERNALS__ = { invoke: async (command: string) => {
          if (command === 'android_pick') return uri
          if (command === 'android_read') return { uri, text, name: '长表格.md', version: '1', bom: false, writable: true }
          return null
        } }
      }, markdown)
      await phone.goto(`${baseUrl}/mobile.html`)
      await phone.getByRole('button', { name: '打开文件', exact: true }).tap()
      const table = phone.getByRole('table')
      await table.waitFor()
      const height = await phone.evaluate(`(async () => {
        const { EditorView } = await import('/node_modules/@codemirror/view/dist/index.js')
        const view = EditorView.findFromDOM(document.querySelector('#write > .cm-editor'))
        const paper = document.querySelector('.yy-paper')
        const pos = view.posAtDOM(paper.querySelector('.live-table-preview'))
        window.__tableScroll = { view, paper, pos }
        await new Promise(requestAnimationFrame)
        return view.lineBlockAt(pos).height
      })()`) as number
      expect(height).toBeGreaterThan(1000)

      await phone.locator('.yy-paper').evaluate(paper => { paper.scrollTop = paper.scrollHeight })
      await table.waitFor({ state: 'detached' })
      const away = await phone.evaluate('window.__tableScroll.view.lineBlockAt(window.__tableScroll.pos).height') as number
      expect(Math.abs(away - height)).toBeLessThan(2)

      const heights = await phone.evaluate(`(async () => {
        const { view, paper, pos } = window.__tableScroll
        const block = view.lineBlockAt(pos)
        paper.scrollTop = block.bottom - paper.clientHeight / 2
        const heights = []
        for (let frame = 0; frame < 10; frame++) {
          await new Promise(requestAnimationFrame)
          heights.push(view.lineBlockAt(pos).height)
        }
        return heights
      })()`) as number[]
      await table.waitFor()
      expect(Math.max(...heights.map(value => Math.abs(value - height)))).toBeLessThan(2)
    } finally {
      await phone.close()
    }
  }, 15000)

  it('Android 在窄屏、横屏和大字号下保持工具可点，宽表格只在块内横向滚动', async () => {
    const title = '记录与分析_' + 'LONG_DOCUMENT_FILENAME_'.repeat(9) + '.md'
    const columns = Array.from({ length: 24 }, (_, i) => '独立配置说明第' + (i + 1) + '列')
    const text = '# ' + 'LONG_SECTION_HEADING_'.repeat(5) + '\n\n短正文可以自然换行。\n\n| ' + columns.join(' | ') +
      ' |\n| ' + columns.map(() => '---').join(' | ') + ' |\n| ' + columns.map(() => '宽表格内容').join(' | ') + ' |\n'
    const cases = [
      { width: 280, height: 740, density: 2, left: 0, right: 0, enlarged: false },
      { width: 320, height: 740, density: 3, left: 12, right: 14, enlarged: true },
      { width: 393, height: 820, density: 2.75, left: 0, right: 0, enlarged: false },
      { width: 820, height: 385, density: 3.5, left: 32, right: 25, enlarged: true },
    ]
    for (const { width, height, density, left, right, enlarged } of cases) {
      const phone = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: density, isMobile: true, hasTouch: true })
      phone.setDefaultTimeout(5000)
      try {
        await phone.emulateMedia({ reducedMotion: 'reduce' })
        await phone.addInitScript(({ title, text, left, right }) => {
          const uri = 'content://qa/long-document'
          const native = window as unknown as Record<string, unknown>
          native.__TAURI_INTERNALS__ = { invoke: async (cmd: string) => {
            if (cmd === 'android_pick') return uri
            if (cmd === 'android_read') return { uri, name: title, text, bom: false, version: '1', writable: true }
            if (cmd === 'android_insets') return { top: 24, bottom: 10, left, right }
          if (cmd === 'plugin_list') return []
          if (cmd === 'plugin_market_list') return { name: '内置插件', source: null, plugins: [] }
            return null
          } }
        }, { title, text, left, right })
        await phone.goto(`${baseUrl}/mobile.html`)
        const home = phone.getByRole('main', { name: '文件入口' })
        await home.getByRole('region', { name: '最近打开' }).getByText('暂无最近打开的文档').waitFor()
        const launch = await home.locator('.yy-mobile-launch-actions > button:not([hidden])').evaluateAll(buttons =>
          buttons.map(button => {
            const { left, width, top, bottom } = button.getBoundingClientRect()
            return { left, width, top, bottom }
          }))
        expect(launch).toHaveLength(3)
        for (const [index, button] of launch.entries()) {
          expect(button.left).toBe(launch[0].left)
          expect(button.width).toBe(launch[0].width)
          if (index > 0) expect(button.top).toBeGreaterThanOrEqual(launch[index - 1].bottom)
        }
        await phone.getByRole('button', { name: '打开文件', exact: true }).click()
        await phone.getByRole('heading', { name: title, exact: true }).waitFor()
        if (enlarged) await phone.addStyleTag({ content: 'html { -webkit-text-size-adjust: 150%; } .yy-mobile-mode { font-size: 21px; } .document-theme { font-size: 24px; }' })
        const geometry = await phone.evaluate(() => {
          const bounds = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().toJSON()
          const title = document.querySelector<HTMLElement>('.yy-mobile-editor .yy-mobile-title')!
          return { viewport: document.documentElement.clientWidth, header: bounds('.yy-mobile-editor .yy-mobile-header'),
            footer: bounds('.yy-mobile-footer'), ellipsis: title.clientWidth < title.scrollWidth && getComputedStyle(title).textOverflow === 'ellipsis' }
        })
        expect(geometry.viewport).toBe(width)
        expect(geometry.header.right, JSON.stringify(geometry)).toBeLessThanOrEqual(width)
        expect(geometry.footer.right, JSON.stringify(geometry)).toBeLessThanOrEqual(width)
        expect(geometry.ellipsis).toBe(true)
        for (const label of ['打开文件', '保存文档', '文档主题', '更多操作', '实时', '源码', '大纲', '查找替换', '撤销', '重做']) {
          const button = (await phone.getByRole('button', { name: label, exact: true }).boundingBox())!
          expect(button.x, label).toBeGreaterThanOrEqual(left)
          expect(button.x + button.width, label).toBeLessThanOrEqual(width - right)
          expect(button.width, label).toBeGreaterThanOrEqual(44)
          expect(button.height, label).toBeGreaterThanOrEqual(44)
        }
        // 大字号的长标题可能把表格推出视窗，先像用户一样滚到表格所在的文末。
        await phone.locator('.yy-paper').evaluate(paper => { paper.scrollTop = paper.scrollHeight })
        const table = phone.locator('.live-block-preview').filter({ has: phone.locator('table') })
        await table.waitFor()
        expect(await table.evaluate(element => {
          element.scrollLeft = 100
          const paper = element.closest('.yy-paper')!
          return element.scrollLeft > 0 && paper.scrollWidth <= paper.clientWidth + 1
        })).toBe(true)
        await phone.getByRole('button', { name: '查找替换', exact: true }).click()
        const close = phone.getByRole('button', { name: '关闭查找替换', exact: true })
        const box = (await close.boundingBox())!
        expect(box.x + box.width).toBeLessThanOrEqual(width - right)
        await close.click()

        await phone.getByRole('button', { name: '更多操作' }).click()
        const menu = phone.getByRole('region', { name: '文档操作' })
        const baseline = await menu.evaluate(page => {
          const title = page.querySelector('header')!.getBoundingClientRect()
          const list = page.querySelector<HTMLElement>('.yy-mobile-file-list')!
          const body = list.getBoundingClientRect()
          list.scrollTop = list.scrollHeight
          return { title: title.toJSON(), body: body.toJSON(), scroll: list.scrollTop, outerScroll: page.scrollTop,
            stable: title.top === page.querySelector('header')!.getBoundingClientRect().top }
        })
        expect(baseline.title.top).toBeGreaterThanOrEqual(24)
        expect(baseline.title.left).toBeGreaterThanOrEqual(left)
        expect(baseline.body.top).toBeGreaterThanOrEqual(baseline.title.bottom)
        expect(baseline.body.bottom).toBeLessThanOrEqual(height - 10)
        expect(baseline.body.right).toBeLessThanOrEqual(width - right)
        expect(baseline.outerScroll).toBe(0)
        expect(baseline.stable).toBe(true)
        if (width > height) expect(baseline.scroll).toBeGreaterThan(0)

        await menu.getByRole('button', { name: '插件市场', exact: true }).click()
        const plugins = phone.getByRole('region', { name: '插件管理' })
        await plugins.getByRole('button', { name: '内置插件', exact: true }).click()
        expect(await phone.locator('dialog[open]').count()).toBe(0)
        const pageTitle = (await plugins.getByRole('heading', { name: '插件管理' }).boundingBox())!
        expect(pageTitle.y).toBeGreaterThanOrEqual(24)
        const search = (await plugins.getByRole('searchbox', { name: '搜索插件' }).boundingBox())!
        expect(search.x).toBeGreaterThanOrEqual(left)
        expect(search.x + search.width).toBeLessThanOrEqual(width - right)
        await plugins.getByRole('button', { name: '返回' }).click()
        await menu.waitFor()
        expect(await menu.locator('.yy-mobile-file-list').evaluate(list => list.scrollTop)).toBe(baseline.scroll)
        await menu.getByRole('button', { name: '返回' }).click()
        expect(await phone.getByRole('heading', { name: title, exact: true }).isVisible()).toBe(true)
      } finally {
        await phone.close()
      }
    }
  }, 30000)

  it('Android 在首页恢复最近记录，可重新打开或移出失效项，保留未保存的编辑', async () => {
    const phone = await browser.newPage({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true })
    phone.setDefaultTimeout(5000)
    try {
      await phone.addInitScript(() => {
        const first = 'content://qa/document/first'
        const second = 'content://qa/document/second'
        const workspace = 'content://qa/tree/notes'
        const choices = [first, second]
        const native = window as unknown as Record<string, unknown>
        native.__TAURI_INTERNALS__ = { invoke: async (cmd: string, args: { uri?: string; session?: unknown }) => {
          if (cmd === 'android_pick') {
            localStorage.setItem('picks', String(Number(localStorage.getItem('picks')) + 1))
            return choices.shift() ?? null
          }
          if (cmd === 'android_read') {
            if (args.uri === localStorage.getItem('revoked')) throw new Error('已撤销文件访问权限')
            const name = args.uri === first ? '第一份.md' : '第二份.md'
            return { uri: args.uri, name, text: `${name} 的正文\n`, version: '1', writable: true, bom: false }
          }
          if (cmd === 'android_load_session') return JSON.parse(localStorage.getItem('session') ?? 'null')
          if (cmd === 'android_save_session') localStorage.setItem('session', JSON.stringify(args.session))
          if (cmd === 'android_pick_workspace') return workspace
          if (cmd === 'android_workspace') return { entries: [{ uri: first, name: '第一份.md', path: '笔记/第一份.md' }] }
          return null
        } }
      })
      await phone.goto(`${baseUrl}/mobile.html`)
      expect(await phone.evaluate(() => localStorage.getItem('picks'))).toBeNull()
      await phone.getByRole('button', { name: '打开文件', exact: true }).click()
      await phone.getByRole('heading', { name: '第一份.md' }).waitFor()
      await phone.getByRole('button', { name: '打开文件', exact: true }).click()
      await phone.getByRole('heading', { name: '第二份.md' }).waitFor()
      expect(await phone.getByRole('main', { name: '文件入口' }).isVisible()).toBe(false)
      await expect.poll(() => phone.evaluate(() => JSON.parse(localStorage.getItem('session') ?? '{}').recent?.length)).toBe(2)

      await phone.reload()
      const landing = phone.getByRole('main', { name: '文件入口' })
      const latest = landing.getByRole('region', { name: '最近打开' })
      await latest.waitFor()
      expect(await latest.getByRole('button').allTextContents()).toEqual(['第二份.md', '第一份.md'])
      expect(await phone.evaluate(() => localStorage.getItem('picks'))).toBe('2')
      const menu = phone.getByRole('region', { name: '文档操作' })
      const recent = phone.locator('.yy-tool-page[aria-label="最近打开"]')
      await phone.getByRole('button', { name: '更多操作' }).click()
      await menu.getByRole('button', { name: '最近打开' }).click()
      await recent.getByRole('button', { name: '返回' }).click()
      await menu.getByRole('button', { name: '返回' }).click()
      await latest.getByRole('button', { name: '第二份.md' }).click()
      await phone.getByRole('heading', { name: '第二份.md' }).waitFor()
      await phone.getByRole('button', { name: '更多操作' }).click()
      await menu.getByRole('button', { name: '工作区', exact: true }).click()
      const workspace = phone.getByRole('region', { name: '工作区', exact: true })
      await workspace.getByRole('searchbox', { name: '筛选或检索工作区' }).fill('第一份')
      await workspace.getByRole('button', { name: '笔记/第一份.md' }).click()
      await phone.getByRole('heading', { name: '第一份.md' }).waitFor()
      await phone.locator('.cm-content .cm-line').first().click()
      await phone.keyboard.insertText('本地草稿')

      await phone.getByRole('button', { name: '更多操作' }).click()
      await menu.getByRole('button', { name: '最近打开' }).click()
      expect(await recent.locator('.yy-mobile-recent-list button').allTextContents()).toEqual(['第一份.md', '第二份.md'])
      await recent.getByRole('button', { name: '第二份.md' }).click()
      await phone.getByRole('region', { name: '未保存的编辑' }).getByRole('button', { name: '继续编辑' }).click()
      await phone.evaluate(() => localStorage.setItem('revoked', 'content://qa/document/second'))
      await recent.getByRole('button', { name: '第二份.md' }).click()
      await phone.getByRole('region', { name: '无法打开最近文件' }).getByRole('button', { name: '移出记录' }).click()
      await recent.getByRole('button', { name: '第二份.md' }).waitFor({ state: 'detached' })
      await recent.getByRole('button', { name: '返回' }).click()
      await menu.getByRole('button', { name: '返回' }).click()
      await phone.getByRole('heading', { name: '第一份.md' }).waitFor()
      expect(await phone.locator('.cm-content').innerText()).toContain('本地草稿')
      await expect.poll(() => phone.evaluate(() => JSON.parse(localStorage.getItem('session') ?? '{}').recent?.map((item: { name: string }) => item.name)))
        .toEqual(['第一份.md'])
    } finally {
      await phone.close()
    }
  }, 15000)

  it('导入主题的标题底线占满实时编辑行，内边距不会盖住随后正文', async () => {
    await mountTestHarness()
    const markdown = '## 使用\r\n\r\n1. 在文件菜单打开文档。\r\n\r\n## Android\n\n预览版提供 APK。\n'
    const boxes = await page.evaluate(async markdown => {
      const { editor, shell } = (window as unknown as Record<string, any>).__test
      shell.setThemes([{ id: 'vue-like', name: '标题边框样本', styles: [`
        .document-theme h2 { font-size: 1.75rem; margin: 35px 0 15px; line-height: 1.225;
          padding-bottom: .5em; border-bottom: 1px solid #ddd; }
      `] }], 'vue-like')
      editor.setMarkdown(markdown)
      editor.select({ anchor: markdown.indexOf('预览版'), head: markdown.indexOf('预览版') })
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      return [...document.querySelectorAll('.live-h2 > h2')].map(heading => {
        const bounds = heading.getBoundingClientRect()
        const row = heading.parentElement!
        const line = row.getBoundingClientRect()
        return { width: bounds.width, lineWidth: line.width, border: getComputedStyle(heading).borderBottomWidth,
          rowBottom: line.bottom, headingBottom: bounds.bottom, nextTop: row.nextElementSibling!.getBoundingClientRect().top }
      })
    }, markdown)
    expect(boxes).toHaveLength(2)
    for (const box of boxes) {
      expect(box.border).toBe('1px')
      expect(box.width).toBeCloseTo(box.lineWidth)
      expect(box.headingBottom).toBeLessThan(box.rowBottom)
      expect(box.nextTop).toBeGreaterThanOrEqual(box.rowBottom)
    }
    expect(await page.evaluate(() => {
      const { editor } = (window as unknown as Record<string, any>).__test
      editor.setMode('source')
      return editor.getMarkdown()
    })).toBe(markdown)
  })

  it('主题区块在实时编辑与导出中使用相同的标签和留白，点击区块可修改原文', async () => {
    await page.setViewportSize({ width: 1360, height: 1800 })
    const output = await browser.newPage({ viewport: page.viewportSize()! })
    try {
      await mountTestHarness()
      await page.evaluate(`(async () => {
        const { exportHtml } = await import('/src/export.ts')
        window.__test.exportHtml = exportHtml
      })()`)
      const markdown = [
        '---', 'title: 区块样本', '---', '', '## **行内样式**', '',
        '[TOC]', '', '> 第一行引用', '> 第二行引用', '', '  ***  ', '',
        '| 字段 | 内容 |', '| --- | --- |', '| 时长 | 一天 |', '',
        '```js', 'const ready = true', '```', '', '最后一行。',
      ].join('\r\n')
      const sample: Theme = { id: 'block-layout', name: '区块布局样本', styles: [`
        .document-theme hr { height: 3px; margin: 12px 0 16px; background: #ddd; border: 0; }
        .document-theme blockquote { margin: 9px 0 14px; border-left: 4px solid #999; padding: 9px 18px; }
        .document-theme pre.md-meta-block { padding-top: 17px; }
        .document-theme .md-toc-content { padding-bottom: 21px; }
        .document-theme table { margin-bottom: 23px; }
        .document-theme pre.md-fences { margin-bottom: 25px; }
      `] }
      const extract = (platform: Page) => platform.evaluate(() => {
        const element = (selector: string) => document.querySelector<HTMLElement>('#write ' + selector)!
        const style = (selector: string) => getComputedStyle(element(selector))
        return {
          rule: [style('hr').height, style('hr').marginTop, style('hr').marginBottom],
          quote: [style('blockquote').borderLeftWidth, style('blockquote').paddingTop, style('blockquote').paddingLeft],
          metadata: style('pre.md-meta-block').paddingTop,
          toc: [style('nav .md-toc-content').display, style('nav .md-toc-content').paddingBottom],
          table: style('table').marginBottom,
          fence: style('pre.md-fences').marginBottom,
        }
      })
      const builtins = await page.evaluate(() => (window as unknown as Record<string, any>).__test.builtinThemes as Theme[])
      const imported = importedThemes()
      for (const theme of [sample, ...builtins, ...imported]) {
        const html = await page.evaluate(async ({ markdown, theme }) => {
          const { editor, shell, exportHtml } = (window as unknown as Record<string, any>).__test
          shell.setThemes([theme], theme.id)
          editor.setMarkdown(markdown)
          editor.select({ anchor: markdown.length, head: markdown.length })
          return await exportHtml(markdown, '区块样本', {}, theme, false, shell.getAppearance())
        }, { markdown, theme })
        await output.setContent(html)
        await page.locator('#write .live-toc .md-toc-inner').first().waitFor()
        await page.locator('#write .live-block-preview pre.md-fences').waitFor()
        expect(await page.locator('#write hr').count(), theme.name).toBe(1)
        expect(await page.locator('#write blockquote').textContent(), theme.name).toContain('第二行引用')
        const live = await extract(page)
        const exported = await extract(output)
        expect(live.rule[0], theme.name).toBe(exported.rule[0])
        expect(live.quote[0], theme.name).toBe(exported.quote[0])
        expect(live.toc[0], theme.name).toBe('block')
        if (theme === sample) {
          expect(live).toEqual({ rule: ['3px', '12px', '16px'], quote: ['4px', '9px', '18px'],
            metadata: '17px', toc: ['block', '21px'], table: '23px', fence: '25px' })
          expect(live).toEqual(exported)
        }
        if (theme.name === 'whitey') {
          expect(await page.locator('#write h2').evaluate(heading => getComputedStyle(heading, '::after').width)).toBe('100px')
        }
      }
      await page.locator('#write .live-block-preview blockquote').click()
      await page.locator('#write .cm-line.live-quote').first().waitFor()
      await page.keyboard.press('End')
      await page.keyboard.insertText('（已修改）')
      const roundTrip = await page.evaluate(() => {
        const { editor } = (window as unknown as Record<string, any>).__test
        editor.setMode('source')
        return editor.getMarkdown()
      })
      expect(roundTrip).toBe(markdown.replace('第一行引用', '第一行引用（已修改）'))
      if (imported.length) console.log(`文档区块已检查 ${builtins.length} 套内置与 ${imported.length} 套本机 Typora 主题`)
    } finally {
      await output.close()
      await page.setViewportSize({ width: 1360, height: 860 })
    }
  }, 60_000)

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
