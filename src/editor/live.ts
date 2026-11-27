import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { RangeSet, StateEffect, StateField, Transaction } from '@codemirror/state'
import type { EditorState, Extension, Range } from '@codemirror/state'
import type { EditorOptions, OutlineEntry } from '../contracts'
import { renderMarkdown, safeUrl } from './render'
import { frontMatter } from './front-matter'
import { LiveBlock } from './live-block'
import { cellEdit, editingTable, LiveTable, refreshTable } from './live-table'

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
  Table: 128_000, FencedCode: 32_000, CodeBlock: 32_000, Blockquote: 32_000, HorizontalRule: 8192,
}
type PreviewKind = 'inline' | 'block' | 'metadata'

class Preview extends LiveBlock {
  constructor(readonly source: string, readonly options: EditorOptions, readonly kind: PreviewKind, readonly editOffset?: number) { super() }
  eq(other: Preview) { return other.source === this.source && other.kind === this.kind && other.editOffset === this.editOffset }
  toDOM(view: EditorView) {
    const inline = this.kind === 'inline'
    const element = view.dom.ownerDocument.createElement(inline ? 'span' : 'div')
    element.className = inline ? 'live-inline-preview' : 'live-block-preview'
    if (this.kind === 'metadata') element.classList.add('live-metadata-preview')
    element.contentEditable = 'false'
    if (!inline) this.reserveHeight(element)
    const offset = this.editOffset
    if (!inline && offset !== undefined) {
      element.tabIndex = 0
      element.setAttribute('aria-label', '编辑此 Markdown 块')
      const edit = (event: Event) => {
        if ((event.target as HTMLElement)?.closest?.('a[href]')) return
        event.preventDefault()
        event.stopPropagation()
        const anchor = view.posAtDOM(element) + offset
        view.dispatch({ selection: { anchor } })
        view.focus()
      }
      element.addEventListener('click', edit)
      element.addEventListener('keydown', event => { if ((event as KeyboardEvent).key === 'Enter') edit(event) })
    }
    void renderMarkdown(this.source, this.options).then(html => {
      if (!element.isConnected) return
      element.innerHTML = html
      if (inline) view.requestMeasure()
      else this.measureHeight(view, element)
    }).catch(() => {
      if (!element.isConnected) return
      element.textContent = '暂时无法渲染此内容'
      if (!inline) this.measureHeight(view, element)
    })
    return element
  }
  ignoreEvent(event: Event) { return event.type !== 'click' }
}

class LargePreview extends WidgetType {
  eq() { return true }

  toDOM(view: EditorView) {
    const element = view.dom.ownerDocument.createElement('div')
    element.className = 'live-block-preview live-large-preview'
    element.textContent = '此区块超过实时预览大小，可切换源码查看并编辑'
    return element
  }
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
    const mapped = transaction.docChanged
      ? (transaction.annotation(cellEdit) ? previous : previous.update({
          filter: (from, to) => !transaction.changes.touchesRange(from, to),
        })).map(transaction.changes)
      : previous
    return transaction.selection && !transaction.startState.readOnly ? mapped.update({
      filter: (from, to, decoration) => !decoration.spec.editAsLines ||
        !transaction.newSelection.ranges.some(range => range.from <= to && range.to >= from),
    }) : mapped
  },
  provide: field => [EditorView.decorations.from(field), EditorView.atomicRanges.of(view => view.state.field(field))],
})

function visibleBlocks(view: EditorView, options: EditorOptions, cellInline: Extension) {
  const state = view.state
  const { doc } = state
  const ranges: Range<Decoration>[] = []
  const tree = syntaxTree(state)
  const start = doc.lineAt(view.viewport.from)
  const end = doc.lineAt(view.viewport.to)
  const yamlEnd = frontMatterEnd(doc, start.from)
  const previous = state.field(blockPreviews)
  const pinned = state.readOnly ? null : editingTable(view)
  let projectedFrom = start.from
  let projectedTo = end.to
  function insert(from: number, to: number, widget: WidgetType, editAsLines = false) {
    if (from >= to || (editAsLines && overlapsSelection(state, from, to))) return
    let existing: Decoration | undefined
    previous.between(from, to, (start, end, decoration) => {
      const old = decoration.spec.widget
      if (start === from && end === to && decoration.spec.editAsLines === editAsLines
        && old?.constructor === widget.constructor && old.eq(widget)) existing = decoration
    })
    if (!existing && widget instanceof LiveBlock) {
      widget.height = Math.ceil(view.lineBlockAt(to).bottom - view.lineBlockAt(from).top)
    }
    projectedFrom = Math.min(projectedFrom, from)
    projectedTo = Math.max(projectedTo, to)
    ranges.push((existing ?? Decoration.replace({ block: true, widget, editAsLines })).range(from, to))
  }
  // 区块复用导出的语义标签，让主题的边框和留白按整个区块排版。
  if (yamlEnd > start.from) {
    const to = doc.lineAt(yamlEnd - 1).to
    insert(0, to, new Preview(doc.sliceString(0, to), options, 'metadata'))
  }
  tree.iterate({
    from: start.from, to: end.to,
    enter(node) {
      const limit = previewLimits[node.name]
      if (!limit || node.from < yamlEnd) return
      // 只替换完整块。缩进列表里的局部语法继续保留原本的行结构。
      const first = doc.lineAt(node.from)
      const last = doc.lineAt(node.to)
      const complete = node.from === first.from || node.node.parent?.name === 'Document'
      if (!complete || node.to !== last.to || (pinned && first.from < pinned.to && last.to > pinned.from)) return false
      if (last.to - first.from > limit) {
        insert(first.from, last.to, new LargePreview())
        return false
      }
      const source = doc.sliceString(first.from, last.to)
      if (node.name === 'Table') insert(first.from, last.to, new LiveTable(source, options, state.readOnly, cellInline))
      else {
        let editOffset: number | undefined
        if (!state.readOnly && node.name === 'Blockquote') editOffset = /^[ \t]*>[ \t]?/.exec(first.text)?.[0].length
        if (!state.readOnly && (node.name === 'FencedCode' || node.name === 'CodeBlock')) {
          const info = node.node.getChild('CodeInfo')
          const text = node.node.getChild('CodeText')
          const language = info ? doc.sliceString(info.from, info.to).trim().split(/\s+/)[0].toLowerCase() : ''
          if (text && !['mermaid', 'flowchart', 'sequence', 'latex', 'math'].includes(language)) editOffset = text.from - first.from
        }
        insert(first.from, last.to, new Preview(source, options, 'block', editOffset), editOffset !== undefined)
      }
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
    insert(first.from, last.to, new Preview(doc.sliceString(first.from, last.to), options, 'block'))
    line = last.number
  }
  // 视窗移动时保留已投影的区块。CodeMirror 会回收离屏 DOM，同时保留量过的高度，
  // 避免表格离屏后变回多行源码，导致后续正文的位置反复变化。
  return previous.update({
    filterFrom: projectedFrom,
    filterTo: projectedTo,
    // 正在输入的表格保持原来的 DOM，避免卸载系统输入法。
    filter: (from, to, decoration) => from === pinned?.from && to === pinned?.to && decoration.spec.widget instanceof LiveTable,
    add: ranges,
    sort: true,
  })
}

function blockProjection(options: EditorOptions, cellInline: Extension) {
  return ViewPlugin.fromClass(class {
    private frame = 0
    constructor(private view: EditorView) { this.schedule() }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged ||
          update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refreshTable))) ||
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
        const next = visibleBlocks(view, options, cellInline)
        if (!RangeSet.eq([before], [next])) {
          view.dispatch({ effects: replaceBlocks.of(next), annotations: Transaction.addToHistory.of(false) })
        }
      })
    }

    destroy() { this.view.dom.ownerDocument.defaultView?.cancelAnimationFrame(this.frame) }
  })
}

export function liveInsertionPoint(view: EditorView, position: number) {
  // 大纲和 Home 定位到原文行首。编辑时把写入落点移到隐藏的标题、引用前缀之后。
  let cursor = position
  for (const ranges of view.state.facet(EditorView.atomicRanges)) {
    ranges(view).between(position, position, (from, to, decoration) => {
      if (from <= position && to > position && decoration.spec.leadingSyntax) cursor = Math.max(cursor, to)
    })
  }
  return cursor
}

function inlineDecoration(options: EditorOptions, outline?: () => OutlineEntry[], jump?: (from: number) => void) {
  return ViewPlugin.fromClass(class {
    decorations: ReturnType<typeof Decoration.set>
    atomic = Decoration.none

    constructor(view: EditorView) { this.decorations = this.build(view) }

    update(update: ViewUpdate) {
      if (update.view.composing) {
        this.decorations = this.decorations.map(update.changes)
        this.atomic = this.atomic.map(update.changes)
      } else if (update.docChanged || update.viewportChanged || update.selectionSet
        || update.focusChanged || update.startState.readOnly !== update.state.readOnly || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = this.build(update.view)
      }
    }

    build(view: EditorView) {
      const { doc, selection } = view.state
      const ranges: Range<Decoration>[] = []
      const atomic: Range<Decoration>[] = []
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
      const replace = (from: number, to: number, widget?: WidgetType, leadingSyntax = false) => {
        if (from >= to) return
        const range = Decoration.replace({ widget, leadingSyntax }).range(from, to)
        ranges.push(range)
        atomic.push(range)
      }
      // YAML 中的横线可能被增量语法树识别为标题标记。在装饰阶段先划定它的范围。
      const yamlEnd = outline ? frontMatterEnd(doc, view.viewport.from) : 0
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
            const parent = node.node.parent?.name
            const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(name)
            if (outline && heading && first.from >= visible.from) {
              addLine(first.from, 'h' + heading[1])
              if (from < first.to) ranges.push(Decoration.mark({ tagName: 'h' + heading[1] }).range(from, first.to))
            }
            if (outline && blocks[name]) {
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
            // 目录插件使用引用定义标注旧目录的边界，标记只在源码中显示。
            if (name === 'LinkReference' && /^\[yeyu-toc-(begin|end)\]: #yeyu-toc-\1$/.test(first.text)) {
              replace(from, to)
              addLine(first.from, 'markup-only')
              return false
            }
            const setextMarker = outline && name === 'HeaderMark' && /^SetextHeading[12]$/.test(parent ?? '')
            const fenceMarker = outline && parent === 'FencedCode' && (name === 'CodeMark' || name === 'CodeInfo')
            if (setextMarker || fenceMarker) {
              if (setextMarker || /^\s*(?:```|~~~)/.test(first.text)) {
                // 单独一行的标记在实时视图中收起。光标移到该行时显示语法，方便编辑分隔符。
                if (view.state.readOnly || !active(first.from, first.to)) addLine(first.from, 'markup-only')
              } else replace(from, to)
              return false
            }
            if (markers.has(name) && (outline || !/^(?:HeaderMark|QuoteMark)$/.test(name))) {
              if (name === 'LinkMark') {
                mark(from, to, 'punctuation')
              } else if (to <= first.to) {
                const start = name === 'HeaderMark' && from > first.from && doc.sliceString(from - 1, from) === ' ' ? from - 1 : from
                const end = (name === 'HeaderMark' || name === 'QuoteMark') && doc.sliceString(to, to + 1) === ' ' ? to + 1 : to
                replace(start, end, undefined, start === first.from && (name === 'HeaderMark' || name === 'QuoteMark'))
              }
            }
            if (name === 'Escape') replace(from, from + 1)
            if (outline && name === 'ListMark' && /^[-+*]$/.test(doc.sliceString(from, to))) {
              const rest = doc.sliceString(to, first.to)
              const task = /^([ \t]+)\[[ xX]\]/.exec(rest)
              if (task) replace(from, to + task[1].length)
              else replace(from, to, new Bullet())
            }
            if (outline && name === 'TaskMarker') {
              addLine(first.from, 'task')
              replace(from, to, new TaskCheckbox(from, /x/i.test(doc.sliceString(from, to)), view.state.readOnly))
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
                  if (parent.to <= first.to) {
                    replace(parent.from, start)
                    replace(end, parent.to)
                  }
                }
              }
            }
            if (name === 'Link' && node.node.getChild('LinkLabel') && to <= first.to) {
              const [opening, closing] = node.node.getChildren('LinkMark')
              if (opening && closing) {
                replace(from, opening.to)
                replace(closing.from, to)
              }
            }
            if ((name === 'Image' || name === 'Emoji') && to <= first.to && to - from <= 4096) {
              replace(from, to, new Preview(doc.sliceString(from, to), options, 'inline'))
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
          if (outline && jump && /^\s*\[toc\]\s*$/i.test(line.text)) {
            addLine(line.from, 'toc-line')
            replace(line.from, line.to, new Toc(outline, jump, doc))
          }
          if (/^\s*\[\^[^\]]+\]:/.test(line.text)) addLine(line.from, 'footnote')
          if (!editing && !line.text.trim()) addLine(line.from, 'empty')
          if (!/^\s*\$\$\s*$/.test(line.text)) {
            for (const match of line.text.matchAll(/(?:\$[^$\n]+\$|<u>.*?<\/u>|\\\(.+?\\\))/gi)) {
              let escapes = 0
              while (line.text[match.index - 1 - escapes] === '\\') escapes++
              if (escapes % 2) continue
              const from = line.from + match.index
              const to = from + match[0].length
              let node = tree.resolveInner(from, 1)
              while (node.parent && !/^(?:InlineCode|Image|Link)$/.test(node.name)) node = node.parent
              if (node.parent) continue
              replace(from, to, new Preview(match[0], options, 'inline'))
            }
          }
        }
      }
      for (const [from, classes] of lineClasses) {
        if (classes.has('live-task')) classes.add('md-task-list-item')
        ranges.push(Decoration.line({ class: [...classes].join(' ') }).range(from))
      }
      this.atomic = Decoration.set(atomic, true)
      return Decoration.set(ranges, true)
    }
  }, {
    decorations: value => value.decorations,
    provide: plugin => EditorView.atomicRanges.of(view => view.plugin(plugin)?.atomic ?? Decoration.none),
  })
}

export function liveDecoration(options: EditorOptions, outline: () => OutlineEntry[], jump: (from: number) => void) {
  return [
    blockPreviews, blockProjection(options, inlineDecoration(options)), inlineDecoration(options, outline, jump),
    EditorView.inputHandler.of((view, from, to, text, insert) => {
      if (from !== to || !text || !view.state.selection.main.empty) return false
      const point = liveInsertionPoint(view, from)
      if (point === from) return false
      const content = view.state.toText(text)
      view.dispatch({
        changes: { from: point, insert: content },
        selection: { anchor: point + content.length },
        userEvent: insert().annotation(Transaction.userEvent),
        scrollIntoView: true,
      })
      return true
    }),
  ]
}
