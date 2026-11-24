import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/editor/render'
import { diagramSource } from '../src/editor/diagrams'

describe('Markdown HTML 导出', () => {
  it('渲染混合换行、YAML、标题目录、表格、任务、脚注、高亮和 LaTeX', async () => {
    const source = [
      '---\rtitle: 测试\r---', '[TOC]', '# 同名', '# 同名',
      '| 甲 | 乙 |\n| -- | -- |\n| 1 | 2 |', '- [x] 完成',
      '文字[^note]', '[^note]: 说明', '```js\nconst n = 42;\n```',
      '$x^2$', '$$\n\\frac{a}{b}\n$$', '<u>下划线</u>',
    ].join('\r\n\n')
    const html = await renderMarkdown(source)
    for (const expected of [
      'class="yaml-frontmatter"', 'href="#同名-2"', '<h1 id="同名">同名</h1>', '<table>',
      'type="checkbox"', 'checked', 'class="footnotes"', 'hljs-keyword', '<msup>', '<mfrac>', '<u>下划线</u>',
    ]) expect(html).toContain(expected)
  })

  it('保留可用链接与解析后的图片，阻断脚本、事件属性和危险 URL', async () => {
    const html = await renderMarkdown([
      '[安全](https://example.org)', '[危险](javascript:alert(1))',
      '<script>alert(1)</script>', '<img src="bad" onerror="alert(1)">',
      '![本机](foo.png) ![拒绝](bar.png)',
    ].join('\n\n'), {
      resolveImage: url => url === 'foo.png' ? 'asset://localhost/foo.png' : 'java\tscript:alert(1)',
    })
    expect(html).toContain('href="https://example.org"')
    expect(html).toContain('src="asset://localhost/foo.png"')
    expect(html).toContain('src="bar.png"')
    expect(html).not.toMatch(/<script|<img[^>]*onerror|(?:href|src)="javascript:/)
  })

  it('转换旧式流程图和时序图，并保留无法转换的流程图源码', async () => {
    expect(diagramSource('flowchart', 'a=>start: 开始\nb=>condition: 好吗\na->b\nb(yes)->a'))
      .toContain('b --> |yes| a')
    expect(diagramSource('sequence', 'Title: 测试\nAlice->Bob: 你好')).toContain('Alice->>Bob: 你好')
    const unknown = 'unknown=>unsupported: 保留'
    expect(await renderMarkdown('```flowchart\n' + unknown + '\n```')).toContain('unknown=&gt;unsupported: 保留')
  })
})
