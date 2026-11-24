import { chromium } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'

const browserPath = process.env.YEYU_CHROME || (platform() === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : '/usr/bin/chromium')
if (!existsSync(browserPath)) throw new Error('请把 YEYU_CHROME 设为 Chromium 可执行文件路径')

const browser = await chromium.launch({ executablePath: browserPath, headless: true })
try {
  const page = await browser.newPage()
  await page.goto(process.env.YEYU_PROBE_URL || 'http://127.0.0.1:1420')
  const summary = await page.evaluate(async () => {
    const { createEditor } = await import('/src/editor/index.ts')
    const shell = document.createElement('div')
    shell.style.cssText = 'height:420px;overflow:auto'
    document.body.replaceChildren(shell)
    const host = document.createElement('div')
    shell.append(host)
    const theme = document.createElement('style')
    theme.textContent = '#write .live-h1 { color: rgb(32, 82, 72) }'
    document.head.append(theme)
    const editor = createEditor(host, { onChange() {}, onSelectionChange() {} })
    editor.setMarkdown('# 标题\n\n正文\n')
    editor.replace(2, 4, '示例')
    editor.select({ anchor: 2, head: 4 })
    editor.setMode('source')
    const selected = editor.getSelection()
    editor.setMode('live')
    editor.select({ anchor: 8, head: 8 })
    const heading = host.querySelector('.live-h1')
    const color = heading && getComputedStyle(heading).color
    editor.undo()
    const didUndo = editor.getMarkdown() === '# 标题\n\n正文\n'
    const sample = '# 长文档\n\n' + '用于检查长文档的 Markdown 行。\n\n'.repeat(170000)
    const start = performance.now()
    editor.setMarkdown(sample)
    const openMs = Math.round(performance.now() - start)
    const size = new Blob([sample]).size
    const domLines = host.querySelectorAll('.cm-line').length
    editor.setMarkdown('# 中文\n\n')
    editor.select({ anchor: 6, head: 6 })
    editor.focus()
    window.probeEditor = editor
    return { selected: { anchor: selected.anchor, head: selected.head }, color, didUndo, size, openMs, domLines }
  })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
  await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 })
  await cdp.send('Input.insertText', { text: '中文' })
  const composition = await page.evaluate(() => window.probeEditor.getMarkdown())
  console.log(JSON.stringify({ ...summary, composition, chrome: execFileSync(browserPath, ['--version'], { encoding: 'utf8' }).trim() }))
  if (!summary.didUndo || summary.selected.head !== 4 || summary.color !== 'rgb(32, 82, 72)' || !composition.endsWith('中文')) {
    throw new Error('编辑器基线验证失败')
  }
} finally {
  await browser.close()
}
