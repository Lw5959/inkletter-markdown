import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chromium, webkit } from 'playwright-core'
import { createServer } from 'vite'

const isWebKit = process.argv.includes('--webkit')
const chrome = process.env.YEYU_CHROME || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium')
if (!isWebKit && !existsSync(chrome)) throw new Error('请用 YEYU_CHROME 指定 Chrome 可执行文件')
const server = await createServer({ server: { port: 0, strictPort: false } })
let browser
try {
  await server.listen()
  browser = isWebKit ? await webkit.launch() : await chromium.launch({ executablePath: chrome })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(server.resolvedUrls.local[0] + 'src/editor/editor.css')
  await page.evaluate(async () => {
    const { createEditor, renderMarkdown } = await import('/src/editor/index.ts')
    const paper = document.createElement('main')
    paper.className = 'document-theme'
    paper.style.cssText = 'max-height: 450px; overflow:auto'
    const host = paper.appendChild(document.createElement('div'))
    document.body.replaceChildren(paper)
    window.assets = []
    window.links = []
    window.editor = createEditor(host, {
      onChange() {}, onSelectionChange() {},
      async onAssetPaste(file) { window.assets.push(file.name) },
      onOpenLink(url) { window.links.push(url) },
    })
    window.renderMarkdown = renderMarkdown
  })
  const outcome = await page.evaluate(() => {
    const editor = window.editor
    const original = '# 😀中文\r\n\r第二行\n末尾\r\n'
    // 穷举端点覆盖 CRLF 内部、空行和代理对，验证原文语义与历史。
    for (let from = 0; from <= original.length; from++) {
      for (let to = from; to <= original.length; to++) {
        for (const insertion of ['', '新\r\n段\r\n', '\n', '\r']) {
          editor.setMarkdown(original)
          editor.replace(from, to, insertion)
          const expected = original.slice(0, from) + insertion + original.slice(to)
          if (editor.getMarkdown() !== expected) throw Error(JSON.stringify({ from, to, insertion, expected, got: editor.getMarkdown() }))
          editor.undo()
          if (editor.getMarkdown() !== original) throw Error('撤销有损')
          editor.redo()
          if (editor.getMarkdown() !== expected) throw Error('重做有损')
        }
      }
    }

    editor.setMarkdown(original)
    editor.select({ anchor: original.length, head: 8 })
    editor.setMode('source')
    editor.setMode('live')
    const selected = editor.getSelection()
    const field = document.querySelector('.cm-content')
    const transfer = new DataTransfer()
    field.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: transfer }))
    const copied = transfer.getData('text/plain')
    editor.select({ anchor: 0, head: original.length })
    field.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
    const pasted = editor.getMarkdown()
    editor.undo()
    const afterUndo = editor.getMarkdown()
    const files = new DataTransfer()
    files.items.add(new File(['图'], 'sample.png', { type: 'image/png' }))
    field.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: files }))
    editor.setPresentation({ focus: true, typewriter: true, spellcheck: true, readonly: true })
    editor.replace(0, 1, '锁定')
    const locked = editor.getMarkdown()
    const presentation = [field.spellcheck, field.isContentEditable, document.querySelector('#write').classList.contains('editor-focus')]
    editor.setPresentation({ focus: false, typewriter: false, spellcheck: false })
    editor.setMarkdown('**旧**\r\n## [链接](https://example.org/)\r尾')
    const outline = editor.getOutline()
    editor.select({ anchor: 5, head: 0 })
    editor.format('bold')
    const formatted = editor.getMarkdown()
    const formattedSelection = editor.getSelection()
    editor.setMode('source')
    editor.undo()
    const formattedUndo = editor.getMarkdown()
    return { original, selected, copied, pasted, afterUndo, locked, presentation, outline, formatted, formattedSelection, formattedUndo }
  })
  assert.deepEqual(outcome.selected, { anchor: outcome.original.length, head: 8 })
  assert.equal(outcome.copied, outcome.original.slice(8))
  assert.equal(outcome.pasted, outcome.copied)
  assert.equal(outcome.afterUndo, outcome.original)
  assert.equal(outcome.locked, outcome.original)
  assert.deepEqual(outcome.presentation, [true, false, true])
  assert.equal(outcome.outline[0].from, 7)
  assert.equal(outcome.formatted, '旧\r\n## [链接](https://example.org/)\r尾')
  assert.deepEqual(outcome.formattedSelection, { anchor: 1, head: 0 })
  assert.match(outcome.formattedUndo, /^\*\*旧\*\*/)
  assert.deepEqual(await page.evaluate(() => window.assets), ['sample.png'])

  await page.evaluate(() => {
    const theme = document.createElement('style')
    theme.textContent = '.document-theme #write h1 { color: rgb(32, 82, 72); }'
    document.head.append(theme)
    window.editor.setMarkdown('# 标题\r\n\n- [ ] 任务\r\n\n[链接](https://example.org)\n\n[TOC]\n')
    window.editor.setMode('live')
    const end = window.editor.getMarkdown().length
    window.editor.select({ anchor: end, head: end })
  })
  assert.equal(await page.locator('#write h1').evaluate(heading => getComputedStyle(heading).color), 'rgb(32, 82, 72)')
  await page.locator('#write input[type=checkbox]').click()
  assert.match(await page.evaluate(() => window.editor.getMarkdown()), /- \[x\] 任务/)
  assert.equal(await page.locator('#write input[checked]').count(), 1)
  await page.locator('[data-markdown-url]').dispatchEvent('click', { ctrlKey: true })
  assert.deepEqual(await page.evaluate(() => window.links), ['https://example.org'])
  await page.locator('.live-toc a').click()
  assert.deepEqual(await page.evaluate(() => window.editor.getSelection()), { anchor: 0, head: 0 })

  await page.evaluate(() => {
    window.editor.setMarkdown('甲\r\n乙')
    window.editor.select({ anchor: 2, head: 2 })
    window.editor.replace(0, 1, '新文')
    window.editor.setMode('source')
    window.editor.undo()
  })
  assert.deepEqual(await page.evaluate(() => window.editor.getSelection()), { anchor: 2, head: 2 })

  const blocks = '# 块级编辑\n\n| 任务 | 状态 |\n| ---- | ---- |\n| 主题接口 | 就绪 |\n\n' +
    '```js\nconst value = 42\n```\n\n末尾'
  await page.evaluate(source => {
    window.editor.setMode('live')
    window.editor.setMarkdown(source)
  }, blocks)
  await page.locator('#write table').waitFor()
  await page.locator('#write pre code').waitFor()
  assert.doesNotMatch(await page.locator('#write .cm-content').innerText(), /\| 任务|[`]{3}js/)
  await page.locator('#write table td').first().click()
  await page.locator('#write .cm-line').filter({ hasText: '| 任务 | 状态 |' }).waitFor()
  assert.equal(await page.evaluate(() => window.editor.getMarkdown()), blocks)
  await page.evaluate(() => window.editor.select({ anchor: 0, head: 0 }))
  await page.locator('#write table').waitFor()

  const html = await page.evaluate(() => window.renderMarkdown([
    '```mermaid\nflowchart TD\n  A --> B\n```',
    '```sequence\nAlice->Bob: 你好\n```',
    '```flowchart\na=>start: 开始\nb=>end: 结束\na->b\n```',
    '```mermaid\n%%{init: {\\"securityLevel\\": \\"loose\\"}}%%\nflowchart TD\n  A --> B\n```',
  ].join('\n\n')))
  assert.equal((html.match(/<svg /g) ?? []).length, 3)
  assert.match(html, /language-mermaid/)
  assert.doesNotMatch(html, /foreignObject|<script/)

  if (!isWebKit) {
    await page.evaluate(() => {
      window.editor.setMarkdown('# 标题\r\n\n')
      window.editor.setMode('live')
      window.editor.select({ anchor: 7, head: 7 })
      window.editor.focus()
    })
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
    await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 })
    await cdp.send('Input.insertText', { text: '中文' })
    assert.equal(await page.evaluate(() => window.editor.getMarkdown()), '# 标题\r\n\n中文')
    await page.evaluate(() => { window.editor.setMode('source'); window.editor.undo() })
    assert.equal(await page.evaluate(() => window.editor.getMarkdown()), '# 标题\r\n\n')
  }

  const long = await page.evaluate(() => {
    const sample = '# 长文档\r\n\n' + '用于检查长文档的 Markdown 行。\r\n\n'.repeat(170_000)
    const start = performance.now()
    const editor = window.editor
    editor.setMarkdown(sample)
    const openMs = Math.round(performance.now() - start)
    editor.setMode('live')
    const lines = document.querySelectorAll('.cm-line').length
    editor.select({ anchor: sample.length, head: sample.length })
    editor.replace(sample.length, sample.length, '尾')
    return { openMs, lines, size: new Blob([sample]).size, exact: editor.getMarkdown() === sample + '尾' }
  })
  assert.ok(long.lines < 200)
  assert.ok(long.exact)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ engine: isWebKit ? 'WebKit' : 'Chrome', ...long }))
} finally {
  await browser?.close()
  await server.close()
}
