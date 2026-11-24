import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { Range } from '@codemirror/state'
import type { EditorOptions, OutlineEntry } from '../contracts'
import { renderMarkdown, safeUrl } from './render'
import { frontMatter } from './front-matter'

const marks: Record<string, string> = {
  StrongEmphasis: 'strong', Emphasis: 'em', Strikethrough: 'del', InlineCode: 'code',
  Link: 'link', Autolink: 'link', LinkReference: 'reference', TableCell: 'cell',
}
const inlineTags: Record<string, string> = { Highlight: 'mark', Subscript: 'sub', Superscript: 'sup' }
const markers = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'HeaderMark', 'LinkMark', 'HighlightMark', 'SubscriptMark', 'SuperscriptMark'])
const blocks: Record<string, string> = {
  Blockquote: 'quote', Table: 'table', FencedCode: 'fence', CodeBlock: 'fence', HorizontalRule: 'rule',
}

class Preview extends WidgetType {
  constructor(readonly source: string, readonly options: EditorOptions, readonly inline: boolean) { super() }
  eq(other: Preview) { return other.source === this.source && other.inline === this.inline }
  toDOM(view: EditorView) {
    const element = view.dom.ownerDocument.createElement('span')
    element.className = this.inline ? 'live-inline-preview' : 'live-block-preview'
    element.contentEditable = 'false'
    void renderMarkdown(this.source, this.options).then(html => {
      if (!element.isConnected) return
      element.innerHTML = html
      view.requestMeasure()
    }).catch(() => { element.textContent = this.source })
    return element
  }
  ignoreEvent(event: Event) { return event.type !== 'click' }
}

class TaskCheckbox extends WidgetType {
  constructor(readonly position: number, readonly checked: boolean, readonly readonly: boolean) { super() }
  eq(other: TaskCheckbox) {
    return this.position === other.position && this.checked === other.checked && this.readonly === other.readonly
  }
  toDOM(view: EditorView) {
    const input = view.dom.ownerDocument.createElement('input')
    input.type = 'checkbox'
    input.checked = this.checked
    input.disabled = this.readonly
    input.setAttribute('aria-label', '任务完成状态')
    input.addEventListener('change', () => {
      if (!view.state.readOnly) view.dispatch({
        changes: { from: this.position + 1, to: this.position + 2, insert: input.checked ? 'x' : ' ' },
        userEvent: 'input',
      })
    })
    return input
  }
}

class Toc extends WidgetType {
  private timer = 0
  constructor(readonly outline: () => OutlineEntry[], readonly jump: (from: number) => void, readonly version: object) { super() }
  eq(other: Toc) { return other.version === this.version }
  toDOM(view: EditorView) {
    const element = view.dom.ownerDocument.createElement('span')
    element.className = 'live-block-preview live-toc'
    element.contentEditable = 'false'
    // 目录可见时再取全量大纲。编辑和滚动时的装饰计算仍限于视窗。
    const window = view.dom.ownerDocument.defaultView!
    this.timer = window.setTimeout(() => {
      if (!element.isConnected) return
      for (const entry of this.outline()) {
        const item = element.ownerDocument.createElement('a')
        item.href = '#' + (entry.id ?? '')
        item.className = 'toc-h' + entry.level
        item.textContent = entry.title
        item.addEventListener('click', event => {
          event.preventDefault()
          this.jump(entry.from)
        })
        element.append(item)
      }
      view.requestMeasure()
    }, 160)
    return element
  }
  destroy(dom: HTMLElement) { dom.ownerDocument.defaultView?.clearTimeout(this.timer) }
}

export function liveDecoration(options: EditorOptions, outline: () => OutlineEntry[], jump: (from: number) => void) {
  return ViewPlugin.fromClass(class {
    decorations: ReturnType<typeof Decoration.set>

    constructor(view: EditorView) { this.decorations = this.build(view) }

    update(update: ViewUpdate) {
      if (update.view.composing) {
        this.decorations = this.decorations.map(update.changes)
      } else if (update.docChanged || update.viewportChanged || update.selectionSet
        || update.focusChanged || update.startState.readOnly !== update.state.readOnly || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = this.build(update.view)
      }
    }

    build(view: EditorView) {
      const { doc, selection } = view.state
      const ranges: Range<Decoration>[] = []
      const lineClasses = new Map<number, Set<string>>()
      const opaqueLines = new Set<number>()
      const active = (from: number, to: number) => selection.ranges.some(range => range.from <= to && range.to >= from)
      const addLine = (from: number, name: string) => {
        if (!lineClasses.has(from)) lineClasses.set(from, new Set())
        lineClasses.get(from)!.add('live-' + name)
      }
      const mark = (from: number, to: number, name: string) => {
        if (from < to) ranges.push(Decoration.mark({ class: 'live-' + name }).range(from, to))
      }
      const widget = (pos: number, source: string, inline = false) => {
        ranges.push(Decoration.widget({ widget: new Preview(source, options, inline), side: 1 }).range(pos))
      }
      // YAML 中的横线可能被增量语法树识别为标题标记。在装饰阶段先划定它的范围。
      const yamlEnd = doc.line(1).text.trimEnd() === '---' && view.viewport.from < 65_536
        ? frontMatter(doc.sliceString(0, Math.min(doc.length, 65_536)))?.[0].length ?? 0 : 0
      const tree = syntaxTree(view.state)
      const seen = new Set<string>()
      for (const visible of view.visibleRanges) {
        tree.iterate({
          from: visible.from, to: visible.to,
          enter: node => {
            const { from, to, name } = node
            if (name !== "Document" && to <= yamlEnd) return false
            const key = name + ':' + from + ':' + to
            if (seen.has(key)) return
            seen.add(key)
            const first = doc.lineAt(from)
            const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(name)
            if (heading && first.from >= visible.from) {
              addLine(first.from, 'h' + heading[1])
              if (from < first.to) ranges.push(Decoration.mark({ tagName: 'h' + heading[1] }).range(from, first.to))
            }
            if (blocks[name]) {
              for (let n = Math.max(first.number, doc.lineAt(visible.from).number); n <= doc.lineAt(Math.min(visible.to, to)).number; n++) {
                addLine(doc.line(n).from, blocks[name])
                if (name === 'FencedCode' || name === 'CodeBlock') opaqueLines.add(n)
              }
            }
            if (inlineTags[name] && from < to) {
              ranges.push(Decoration.mark({ tagName: inlineTags[name], class: 'live-' + name.toLowerCase() }).range(from, to))
            }
            if (marks[name]) mark(Math.max(from, visible.from), Math.min(to, visible.to), marks[name])
            if (name === 'Link' && doc.sliceString(from, from + 2) === '[^') mark(from, to, 'footnote')
            const reveal = !view.state.readOnly && active(first.from, first.to)
            if (markers.has(name) && !reveal) {
              if (name === 'LinkMark' || (name === 'HeaderMark' && doc.lineAt(to).number !== first.number)) {
                mark(from, to, 'punctuation')
              } else if (to <= first.to) {
                const end = name === 'HeaderMark' && doc.sliceString(to, to + 1) === ' ' ? to + 1 : to
                ranges.push(Decoration.replace({}).range(from, end))
              }
            }
            if (name === 'TaskMarker' && !reveal) {
              ranges.push(Decoration.replace({
                widget: new TaskCheckbox(from, /x/i.test(doc.sliceString(from, to)), view.state.readOnly),
              }).range(from, to))
            }
            if (name === 'URL' && node.node.parent?.name.match(/^(Link|Autolink)$/)) {
              const raw = doc.sliceString(from, to).replace(/^<|>$/g, '')
              const url = node.node.parent.name === 'Autolink' && /^[^:@]+@/.test(raw) ? 'mailto:' + raw : raw
              if (safeUrl(url)) {
                const parent = node.node.parent
                const label = parent.name === 'Autolink' ? node.node : parent.getChildren('LinkMark')[1]
                const start = parent.name === 'Autolink' ? from : parent.from + 1
                const end = parent.name === 'Autolink' ? to : label?.from
                if (end !== undefined && end > start) ranges.push(Decoration.mark({
                  class: 'live-link-label', attributes: { 'data-markdown-url': url },
                }).range(start, end))
              }
            }
            if (name === 'FencedCode' && first.to >= visible.from && !active(from, to) && to - from <= 32_000) {
              const info = node.node.getChild('CodeInfo')
              if (info) widget(first.to, doc.sliceString(from, to))
            }
            if ((name === 'Image' || name === 'Emoji') && to <= first.to && to - from <= 4096 && !reveal) {
              ranges.push(Decoration.replace({ widget: new Preview(doc.sliceString(from, to), options, true) }).range(from, to))
              return false
            }
            if (name === 'Table' && first.to >= visible.from && !active(from, to) && to - from <= 16_000) widget(first.to, doc.sliceString(from, to))
          },
        })
      }

      const scanned = new Set<number>()
      let mathEnd = -1
      for (const visible of view.visibleRanges) {
        for (let n = doc.lineAt(visible.from).number; n <= doc.lineAt(visible.to).number; n++) {
          if (scanned.has(n) || opaqueLines.has(n)) continue
          scanned.add(n)
          const line = doc.line(n)
          if (line.from < yamlEnd) {
            addLine(line.from, 'yaml')
            continue
          }
          if (line.from <= mathEnd || line.length > 8192) continue
          const editing = !view.state.readOnly && active(line.from, line.to)
          if (!editing && /^\s*\[toc\]\s*$/i.test(line.text)) {
            ranges.push(Decoration.replace({ widget: new Toc(outline, jump, doc) }).range(line.from, line.to))
          }
          if (/^\s*\[\^[^\]]+\]:/.test(line.text)) addLine(line.from, 'footnote')
          if (/^\s*\$\$\s*$/.test(line.text)) {
            // 从开头标记检查短公式，匹配后跳过同一显示公式的结束标记。
            const tail = doc.sliceString(line.to, Math.min(line.to + 8192, doc.length))
            const match = /^\n[\s\S]+?^\s*\$\$[ \t]*$/m.exec(tail)
            if (match?.index === 0) {
              mathEnd = line.to + match[0].length
              if (!active(line.from, mathEnd)) widget(line.to, doc.sliceString(line.from, mathEnd))
            }
          } else if (!editing) {
            for (const match of line.text.matchAll(/(?:\$[^$\n]+\$|<u>.*?<\/u>|\\\(.+?\\\))/gi)) {
              let escapes = 0
              while (line.text[match.index - 1 - escapes] === '\\') escapes++
              if (escapes % 2) continue
              const from = line.from + match.index
              const to = from + match[0].length
              let node = tree.resolveInner(from, 1)
              while (node.parent && !/^(?:InlineCode|Image|Link)$/.test(node.name)) node = node.parent
              if (node.parent) continue
              ranges.push(Decoration.replace({ widget: new Preview(match[0], options, true) }).range(from, to))
            }
          }
        }
      }
      for (const [from, classes] of lineClasses) {
        ranges.push(Decoration.line({ class: [...classes].join(' ') }).range(from))
      }
      return Decoration.set(ranges, true)
    }
  }, { decorations: value => value.decorations })
}
