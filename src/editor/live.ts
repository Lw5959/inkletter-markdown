import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { RangeSet, StateEffect, StateField, Transaction } from '@codemirror/state'
import type { EditorState, Range } from '@codemirror/state'
import type { EditorOptions, OutlineEntry } from '../contracts'
import { renderMarkdown, safeUrl } from './render'
import { frontMatter } from './front-matter'

const marks: Record<string, string> = {
  StrongEmphasis: 'strong', Emphasis: 'em', Strikethrough: 'del', InlineCode: 'code',
  Link: 'link', Autolink: 'link', LinkReference: 'reference', TableCell: 'cell',
}
const inlineTags: Record<string, string> = { Highlight: 'mark', Subscript: 'sub', Superscript: 'sup' }
const markTags: Record<string, string> = { StrongEmphasis: 'strong', Emphasis: 'em', Strikethrough: 'del', InlineCode: 'code' }
const markers = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'HeaderMark', 'LinkMark', 'HighlightMark', 'SubscriptMark', 'SuperscriptMark', 'QuoteMark'])
const blocks: Record<string, string> = {
  Blockquote: 'quote', Table: 'table', FencedCode: 'fence', CodeBlock: 'fence',
}
const previewLimits: Record<string, number> = {
  Table: 16_000, FencedCode: 32_000, CodeBlock: 32_000, Blockquote: 32_000, HorizontalRule: 8192,
}
type PreviewKind = 'inline' | 'block' | 'metadata'

class Preview extends WidgetType {
  constructor(readonly source: string, readonly options: EditorOptions, readonly kind: PreviewKind, readonly readOnly = false) { super() }
  eq(other: Preview) { return other.source === this.source && other.kind === this.kind && other.readOnly === this.readOnly }
  toDOM(view: EditorView) {
    const inline = this.kind === 'inline'
    const element = view.dom.ownerDocument.createElement(inline ? 'span' : 'div')
    element.className = inline ? 'live-inline-preview' : 'live-block-preview'
    if (this.kind === 'metadata') element.classList.add('live-metadata-preview')
    element.contentEditable = 'false'
    if (!inline && !this.readOnly) {
      element.tabIndex = 0
      element.setAttribute('aria-label', '编辑此 Markdown 块')
      const edit = (event: Event) => {
        if ((event.target as HTMLElement)?.closest?.('a[href]')) return
        event.preventDefault()
        event.stopPropagation()
        const anchor = view.posAtDOM(element)
        view.dispatch({ selection: { anchor } })
        view.focus()
      }
      element.addEventListener('click', edit)
      element.addEventListener('keydown', event => { if ((event as KeyboardEvent).key === 'Enter') edit(event) })
    }
    void renderMarkdown(this.source, this.options).then(html => {
      if (!element.isConnected) return
      element.innerHTML = html
      view.requestMeasure()
    }).catch(() => { element.textContent = this.source })
    return element
  }
  ignoreEvent(event: Event) { return event.type !== 'click' }
}

class Bullet extends WidgetType {
  eq() { return true }
  toDOM(view: EditorView) {
    const bullet = view.dom.ownerDocument.createElement('span')
    bullet.className = 'live-bullet'
    bullet.setAttribute('aria-hidden', 'true')
    bullet.innerHTML = '<svg viewBox="0 0 10 12" width=".65em" height=".8em"><circle cx="5" cy="6" r="2.3" fill="currentColor"/></svg>'
    return bullet
  }
}

class TaskCheckbox extends WidgetType {
  constructor(readonly position: number, readonly checked: boolean, readonly readonly: boolean) { super() }
  eq(other: TaskCheckbox) {
    return this.position === other.position && this.checked === other.checked && this.readonly === other.readonly
  }
  toDOM(view: EditorView) {
    const input = view.dom.ownerDocument.createElement('input')
    input.type = 'checkbox'
    input.className = 'task-list-item-checkbox'
    // Typora 主题会用 [checked] 选择器绘制勾号，DOM 属性和状态需要同步。
    input.toggleAttribute('checked', this.checked)
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
    const element = view.dom.ownerDocument.createElement('nav')
    element.className = 'live-block-preview live-toc md-toc'
    element.contentEditable = 'false'
    const content = element.appendChild(element.ownerDocument.createElement('ul'))
    content.className = 'md-toc-content'
    // 目录可见时再取全量大纲。编辑和滚动时的装饰计算仍限于视窗。
    const window = view.dom.ownerDocument.defaultView!
    this.timer = window.setTimeout(() => {
      if (!element.isConnected) return
      for (const entry of this.outline()) {
        const item = content.appendChild(element.ownerDocument.createElement('li'))
        item.className = `toc-h${entry.level} md-toc-item md-toc-h${entry.level}`
        const link = item.appendChild(element.ownerDocument.createElement('a'))
        link.href = '#' + (entry.id ?? '')
        link.className = 'md-toc-inner'
        link.textContent = entry.title
        link.addEventListener('click', event => {
          event.preventDefault()
          this.jump(entry.from)
        })
      }
      view.requestMeasure()
    }, 160)
    return element
  }
  destroy(dom: HTMLElement) { dom.ownerDocument.defaultView?.clearTimeout(this.timer) }
}

function overlapsSelection(state: EditorState, from: number, to: number) {
  return !state.readOnly && state.selection.ranges.some(range => range.from <= to && range.to >= from)
}

function frontMatterEnd(doc: EditorState['doc'], viewportFrom: number) {
  if (viewportFrom >= 65_536 || doc.line(1).text.trimEnd() !== '---') return 0
  return frontMatter(doc.sliceString(0, Math.min(doc.length, 65_536)))?.[0].length ?? 0
}

const replaceBlocks = StateEffect.define<ReturnType<typeof Decoration.set>>()
const blockPreviews = StateField.define<ReturnType<typeof Decoration.set>>({
  create: () => Decoration.none,
  update(previous, transaction) {
    for (const effect of transaction.effects) if (effect.is(replaceBlocks)) return effect.value
    // 光标移入时立即展开，正在输入的范围不交给延迟渲染处理。
    const mapped = transaction.docChanged
      ? previous.update({ filter: (from, to) => !transaction.changes.touchesRange(from, to) }).map(transaction.changes)
      : previous
    return transaction.selection && !transaction.startState.readOnly ? mapped.update({
      filter: (from, to) => !transaction.newSelection.ranges.some(range => range.from <= to && range.to >= from),
    }) : mapped
  },
  provide: field => EditorView.decorations.from(field),
})

function visibleBlocks(view: EditorView, options: EditorOptions) {
  const state = view.state
  const { doc } = state
  const ranges: Range<Decoration>[] = []
  const tree = syntaxTree(state)
  const start = doc.lineAt(view.viewport.from)
  const end = doc.lineAt(view.viewport.to)
  const yamlEnd = frontMatterEnd(doc, start.from)
  function insert(from: number, to: number, kind: 'block' | 'metadata' = 'block') {
    if (from >= to || overlapsSelection(state, from, to)) return
    const widget = new Preview(doc.sliceString(from, to), options, kind, state.readOnly)
    ranges.push(Decoration.replace({ block: true, widget }).range(from, to))
  }
  // 区块复用导出的语义标签，让主题的边框和留白按整个区块排版。
  if (yamlEnd > start.from) insert(0, doc.lineAt(yamlEnd - 1).to, 'metadata')
  tree.iterate({
    from: start.from, to: end.to,
    enter(node) {
      const limit = previewLimits[node.name]
      if (!limit || node.from < yamlEnd) return
      // 只替换完整块。缩进列表里的局部语法继续保留原本的行结构。
      const first = doc.lineAt(node.from)
      const last = doc.lineAt(node.to)
      const complete = node.from === first.from || node.node.parent?.name === 'Document'
      if (complete && node.to === last.to && last.to - first.from <= limit) insert(first.from, last.to)
      return false
    },
  })
  for (let line = start.number; line <= end.number; line++) {
    const first = doc.line(line)
    if (first.from < yamlEnd || !/^\s*\$\$\s*$/.test(first.text)) continue
    let inside = tree.resolveInner(first.from, 1)
    let nested = false
    while (inside.parent) {
      if (/^(?:FencedCode|CodeBlock|Blockquote)$/.test(inside.name)) { nested = true; break }
      inside = inside.parent
    }
    if (nested) continue
    const tail = doc.sliceString(first.to, Math.min(first.to + 8192, doc.length))
    const match = /^\n[\s\S]+?^[ \t]*\$\$[ \t]*$/m.exec(tail)
    if (match?.index !== 0) continue
    const last = doc.lineAt(first.to + match[0].length)
    if (ranges.some(range => range.from < last.to && range.to > first.from)) continue
    insert(first.from, last.to)
    line = last.number
  }
  return Decoration.set(ranges, true)
}

function blockProjection(options: EditorOptions) {
  return ViewPlugin.fromClass(class {
    private frame = 0
    constructor(private view: EditorView) { this.schedule() }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged ||
          update.startState.readOnly !== update.state.readOnly ||
          syntaxTree(update.startState) !== syntaxTree(update.state)) this.schedule()
    }

    private schedule() {
      if (this.frame) return
      const view = this.view
      this.frame = view.dom.ownerDocument.defaultView!.requestAnimationFrame(() => {
        this.frame = 0
        if (view.composing) return
        const before = view.state.field(blockPreviews)
        const next = visibleBlocks(view, options)
        if (!RangeSet.eq([before], [next])) {
          view.dispatch({ effects: replaceBlocks.of(next), annotations: Transaction.addToHistory.of(false) })
        }
      })
    }

    destroy() { this.view.dom.ownerDocument.defaultView?.cancelAnimationFrame(this.frame) }
  })
}

export function liveDecoration(options: EditorOptions, outline: () => OutlineEntry[], jump: (from: number) => void) {
  const inline = ViewPlugin.fromClass(class {
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
      const mark = (from: number, to: number, name: string, tagName?: string) => {
        if (from < to) ranges.push(Decoration.mark({ class: 'live-' + name, tagName }).range(from, to))
      }
      // YAML 中的横线可能被增量语法树识别为标题标记。在装饰阶段先划定它的范围。
      const yamlEnd = frontMatterEnd(doc, view.viewport.from)
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
            // 与 HTML 导出共享行内标签，使同一套主题选择器命中实时文本。
            if (marks[name]) mark(Math.max(from, visible.from), Math.min(to, visible.to), marks[name], markTags[name])
            if (name === 'Link' && doc.sliceString(from, from + 2) === '[^') mark(from, to, 'footnote')
            const reveal = !view.state.readOnly && active(first.from, first.to)
            // 目录插件用保留的引用定义定位旧目录。移入光标后仍可编辑原始标记。
            if (name === 'LinkReference' && !reveal && /^\[yeyu-toc-(begin|end)\]: #yeyu-toc-\1$/.test(first.text)) {
              ranges.push(Decoration.replace({}).range(from, to))
              return false
            }
            if (markers.has(name) && !reveal) {
              if (name === 'LinkMark' || (name === 'HeaderMark' && doc.lineAt(to).number !== first.number)) {
                mark(from, to, 'punctuation')
              } else if (to <= first.to) {
                const end = (name === 'HeaderMark' || name === 'QuoteMark') && doc.sliceString(to, to + 1) === ' ' ? to + 1 : to
                ranges.push(Decoration.replace({}).range(from, end))
              }
            }
            if (name === 'ListMark' && !reveal && /^[-+*]$/.test(doc.sliceString(from, to))) {
              const rest = doc.sliceString(to, first.to)
              const task = /^([ \t]+)\[[ xX]\]/.exec(rest)
              if (task) ranges.push(Decoration.replace({}).range(from, to + task[1].length))
              else ranges.push(Decoration.replace({ widget: new Bullet() }).range(from, to))
            }
            if (name === 'TaskMarker' && !reveal) {
              addLine(first.from, 'task')
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
                if (end !== undefined && end > start) {
                  ranges.push(Decoration.mark({
                    tagName: 'a', class: 'live-link-label', attributes: { 'data-markdown-url': url },
                  }).range(start, end))
                  if (!reveal && parent.name === 'Link' && parent.to <= first.to) {
                    ranges.push(Decoration.replace({}).range(parent.from, start))
                    ranges.push(Decoration.replace({}).range(end, parent.to))
                  }
                }
              }
            }
            if ((name === 'Image' || name === 'Emoji') && to <= first.to && to - from <= 4096 && !reveal) {
              ranges.push(Decoration.replace({ widget: new Preview(doc.sliceString(from, to), options, 'inline') }).range(from, to))
              return false
            }
          },
        })
      }

      const scanned = new Set<number>()
      for (const visible of view.visibleRanges) {
        for (let n = doc.lineAt(visible.from).number; n <= doc.lineAt(visible.to).number; n++) {
          if (scanned.has(n) || opaqueLines.has(n)) continue
          scanned.add(n)
          const line = doc.line(n)
          if (line.from < yamlEnd) {
            addLine(line.from, 'yaml')
            continue
          }
          if (line.length > 8192) continue
          const editing = !view.state.readOnly && active(line.from, line.to)
          if (!editing && /^\s*\[toc\]\s*$/i.test(line.text)) {
            addLine(line.from, 'toc-line')
            ranges.push(Decoration.replace({ widget: new Toc(outline, jump, doc) }).range(line.from, line.to))
          }
          if (/^\s*\[\^[^\]]+\]:/.test(line.text)) addLine(line.from, 'footnote')
          if (!editing && !line.text.trim()) addLine(line.from, 'empty')
          if (!editing && !/^\s*\$\$\s*$/.test(line.text)) {
            for (const match of line.text.matchAll(/(?:\$[^$\n]+\$|<u>.*?<\/u>|\\\(.+?\\\))/gi)) {
              let escapes = 0
              while (line.text[match.index - 1 - escapes] === '\\') escapes++
              if (escapes % 2) continue
              const from = line.from + match.index
              const to = from + match[0].length
              let node = tree.resolveInner(from, 1)
              while (node.parent && !/^(?:InlineCode|Image|Link)$/.test(node.name)) node = node.parent
              if (node.parent) continue
              ranges.push(Decoration.replace({ widget: new Preview(match[0], options, 'inline') }).range(from, to))
            }
          }
        }
      }
      for (const [from, classes] of lineClasses) {
        if (classes.has('live-task')) classes.add('md-task-list-item')
        ranges.push(Decoration.line({ class: [...classes].join(' ') }).range(from))
      }
      return Decoration.set(ranges, true)
    }
  }, { decorations: value => value.decorations })
  return [blockPreviews, blockProjection(options), inline]
}
