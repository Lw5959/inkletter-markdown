import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { build, preview } from 'vite'

// 在待测版本的根目录运行。--measure-only 可用于测量优化前的版本。
const measureOnly = process.argv.includes('--measure-only')
const chrome = process.env.YEYU_CHROME || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium')
const outDir = await mkdtemp(join(tmpdir(), 'yeyu-export-browser-'))
let server
let browser
try {
  // 使用与应用一致的生产设置构建导出入口，测量时不走 Vite 开发服务器的模块转换。
  const config = { logLevel: 'error', build: { outDir, emptyOutDir: true } }
  await build({
    ...config,
    build: {
      ...config.build,
      rolldownOptions: {
        input: [resolve('src/export.ts')],
        preserveEntrySignatures: 'strict', output: { entryFileNames: '[name].js' },
      },
    },
  })
  await mkdir(join(outDir, 'fixture', 'assets'), { recursive: true })
  await copyFile('assets/app-icon.png', join(outDir, 'fixture', 'assets', 'icon.png'))
  await writeFile(join(outDir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>页屿导出验收</title>')
  server = await preview({ ...config, preview: { port: 0 } })
  browser = await chromium.launch({ executablePath: chrome })
  const page = await browser.newPage()
  await page.goto(server.resolvedUrls.local[0])
  const source = []
  let size = 0
  for (let index = 1; ; index++) {
    const section = [
      '## 第 ' + index + ' 节', '[保留链接](https://example.test/) 与行内公式 $x^2$。',
      '| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |', '- [x] 已完成', '```js\nconst done = true;\n```',
      '同一份文档包含**格式**和普通文字。\n'.repeat(8), '',
    ].join('\r\n\r\n')
    const bytes = Buffer.byteLength(section)
    if (size + bytes >= 2 ** 20) break
    size += bytes
    source.push(section)
  }
  const markdown = source.join('') + ' '.repeat(2 ** 20 - size - 1) + '\n'
  assert.equal(Buffer.byteLength(markdown), 2 ** 20)

  const metrics = await page.evaluate(async markdown => {
    const { exportHtml } = await import('/export.js')
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
    const measure = async (source, resolveImage) => {
      const tasks = []
      const observer = new PerformanceObserver(list => tasks.push(...list.getEntries()))
      observer.observe({ entryTypes: ['longtask'] })
      const start = performance.now()
      const html = await exportHtml(source, '导出测量', { resolveImage }, undefined, false, 'light')
      const end = performance.now()
      await delay(60)
      observer.disconnect()
      const durations = tasks.filter(task => task.startTime < end && task.startTime + task.duration > start)
        .map(task => task.duration)
      // 单列 HTML 参数的 JSON 序列化开销，避免混入渲染长任务。
      const serialize = performance.now()
      const json = JSON.stringify({ path: '导出.html', html, format: 'html' }, (_key, value) => value)
      const ipcJsonMs = Math.round((performance.now() - serialize) * 100) / 100
      const encoder = new TextEncoder()
      const bytes = encoder.encode(html)
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      return {
        wallMs: Math.round(end - start), longestTaskMs: Math.max(0, ...durations), longTasks: durations.length,
        htmlBytes: bytes.length, sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
        ipcJsonBytes: encoder.encode(json).length, ipcJsonMs,
      }
    }
    // 首次运行加载依赖，另统计五次重复导出。
    const cold = await measure(markdown)
    const warm = []
    for (let index = 0; index < 5; index++) warm.push(await measure(markdown))

    const repeated = '![重复](assets/icon.png)\n\n'.repeat(8)
    let imageReads = 0
    const images = await measure(repeated, async () => {
      imageReads++
      const blob = await (await fetch('/fixture/assets/icon.png', { cache: 'no-store' })).blob()
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(blob)
      })
    })
    return { cold, warm, images: { ...images, imageReads } }
  }, markdown)
  console.log(JSON.stringify({ chrome: browser.version(), markdownBytes: Buffer.byteLength(markdown), ...metrics }, null, 2))

  if (!measureOnly) {
    assert.equal(metrics.images.imageReads, 1)
    const fixture = await readFile('tests/fixtures/acceptance.md', 'utf8')
    const result = await page.evaluate(async fixture => {
      const { exportHtml } = await import('/export.js')
      const source = fixture + '\n![读取失败](missing.png) ![拒绝](unsafe.png)\n\n```mermaid\n格式错误\n```\n'
      const theme = { id: 'test', name: '主题', styles: ['#write { color: rgb(27, 61, 53); }'] }
      // 用不同的 data URI 同时导出同一相对路径，验证每次导出的资源请求独立。
      const render = (plain, image) => exportHtml(source, '公式 < 图表', {
        resolveImage(url) {
          if (url === 'assets/icon.png') return image
          if (url === 'unsafe.png') return 'javascript:alert(1)'
          throw new Error('读取失败')
        },
      }, theme, plain, 'dark')
      const outputs = await Promise.all([render(false, 'data:image/png;base64,YQ=='), render(true, 'data:image/png;base64,Yg==')])
      return outputs.map(html => {
        const dom = new DOMParser().parseFromString(html, 'text/html')
        const paper = dom.querySelector('main.typora-export[data-appearance="dark"] #write')
        return {
          title: dom.title,
          style: dom.querySelector('style')?.textContent.includes(theme.styles[0]) ?? false,
          missing: ['.yaml-frontmatter', '.md-toc a', 'table', 'input[checked][disabled]', '.footnotes',
            'math msup', 'math mfrac', '.hljs-keyword', 'figure.markdown-diagram svg']
            .filter(selector => !paper?.querySelector(selector)),
          original: paper?.textContent.includes('未知块的原文应该保留。'),
          invalidDiagram: paper?.querySelector('pre code.language-mermaid')?.textContent.trim(),
          imageUrls: [...paper?.querySelectorAll('img') ?? []].map(img => img.getAttribute('src')),
        }
      })
    }, fixture)
    const expected = {
      title: '公式 < 图表', missing: [], original: true, invalidDiagram: '格式错误',
    }
    assert.deepEqual(result, [
      { ...expected, style: true, imageUrls: ['data:image/png;base64,YQ==', 'missing.png', 'unsafe.png'] },
      { ...expected, style: false, imageUrls: ['data:image/png;base64,Yg==', 'missing.png', 'unsafe.png'] },
    ])

    const imagePage = await page.evaluate(async () => {
      const { exportHtml } = await import('/export.js')
      const sizes = [[1024, 1024], [1500, 300], [96, 48]]
      const images = new Map(sizes.map(([width, height], index) => {
        const canvas = Object.assign(document.createElement('canvas'), { width, height })
        return [`image-${index}.png`, canvas.toDataURL()]
      }))
      const markdown = [
        '```mermaid\nflowchart LR\n  A[开始] --> B[完成]\n```',
        '```mermaid\nflowchart TD\n  A[检查] --> B{同意发布？}\n  B -->|通过| C[发布]\n  B -. 重试 .-> A\n  A ==> D[审计]\n```',
        ...[...images.keys()].map(name => `![图片](${name})`),
      ].join('\n\n')
      return exportHtml(markdown, '图片尺寸', { resolveImage: async name => images.get(name) ?? name }, undefined, false, 'light')
    })
    await page.setContent(imagePage)
    const imageSizes = () => page.locator('#write img').evaluateAll(async elements => {
      await Promise.all(elements.map(element => element.decode()))
      return elements.map(element => {
        const { width, height } = element.getBoundingClientRect()
        return [width, height]
      })
    })
    // PNG 与 PDF 使用相同的导出页，分别检查屏幕和打印媒体的图片布局。
    for (const media of ['screen', 'print']) {
      await page.emulateMedia({ media })
      const [square, wide, small] = await imageSizes()
      assert.deepEqual(square, [320, 320])
      assert.ok(wide[0] > 320 && Math.abs(wide[0] / wide[1] - 5) < 0.01)
      assert.deepEqual(small, [96, 48])
      const [flowchart, branches] = await page.locator('#write svg.flowchart').evaluateAll(graphs => graphs.map(svg => {
        const arrow = svg.querySelector('marker[id$="-pointEnd-margin"]')
        return {
          width: svg.getBoundingClientRect().width,
          arrow: [arrow.getAttribute('markerWidth'), arrow.getAttribute('markerHeight')],
          radius: svg.querySelector('.node rect.label-container').getAttribute('rx'),
          alignment: svg.querySelector('.node text').getAttribute('text-anchor'),
          dashed: svg.querySelector('.edge-pattern-dotted')?.getAttribute('stroke-dasharray'),
          thick: svg.querySelector('.edge-thickness-thick')?.getAttribute('stroke-width'),
          label: svg.querySelector('.edgeLabel text')?.textContent.trim(),
        }
      }))
      assert.ok(flowchart.width >= 180 && flowchart.width < 300, JSON.stringify(flowchart))
      assert.deepEqual(flowchart.arrow, ['7', '8'])
      assert.equal(flowchart.radius, '6')
      assert.equal(flowchart.alignment, 'middle')
      assert.equal(branches.dashed, '2 3')
      assert.equal(branches.thick, '2.5')
      assert.equal(branches.label, '通过')
    }
    await page.emulateMedia({ media: 'screen' })
    await page.setViewportSize({ width: 360, height: 700 })
    const [narrowSquare] = await imageSizes()
    assert.ok(narrowSquare[0] < 320 && narrowSquare[0] === narrowSquare[1])
    const fitsPage = await page.locator('#write svg.flowchart').evaluateAll(graphs => graphs.every(svg =>
      svg.getBoundingClientRect().width <= svg.parentElement.getBoundingClientRect().width))
    assert.ok(fitsPage)
    const darkLabel = await page.locator('#write svg.flowchart .node text').first().evaluate(label => {
      label.closest('.document-theme').dataset.appearance = 'dark'
      return getComputedStyle(label).fill
    })
    assert.equal(darkLabel, 'rgb(230, 230, 230)')
  }
} finally {
  await browser?.close()
  await server?.close()
  await rm(outDir, { recursive: true, force: true })
}
