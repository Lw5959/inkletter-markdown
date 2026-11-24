import { Compartment, EditorState, Prec, StateEffect, StateField, Transaction } from '@codemirror/state'
import { EditorView, highlightActiveLine, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, invertedEffects, isolateHistory, redo, undo } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { GFM, parser } from '@lezer/markdown'
import type { Editor, EditorMode, EditorOptions, OutlineEntry, Presentation, Selection } from '../contracts'
import { coalesceEndings, encode, encodedOffset, locate, originalOffset, originalSlice, rawBuffer, rawHistory, restoreRaw } from './buffer'
import { applyFormat, blockFormats, lineFormats } from './formats'
import { liveDecoration } from './live'
import { headingId, headingText, safeUrl } from './render'
import './editor.css'

export { renderMarkdown } from './render'

const outlineParser = parser.configure(GFM)
const presentationDefaults = { focus: false, typewriter: false, spellcheck: false }
const selectionEffect = StateEffect.define<Selection | null>()
const originalSelection = StateField.define<Selection | null>({
  create: () => null,
  update(value, tr) {
    let next = tr.selection || tr.docChanged ? null : value
    for (const effect of tr.effects) if (effect.is(selectionEffect)) next = effect.value
    return next
  },
})
const clipboardType = 'application/x-yeyu-markdown'

export function createEditor(host: HTMLElement, options: EditorOptions): Editor {
  host.id = 'write'
  const mode = new Compartment()
  const presentation = new Compartment()
  let currentMode: EditorMode = 'live'
  let display: Presentation = presentationDefaults
  let outlineCache: { doc: EditorState['doc']; raw: EditorState['doc']; entries: OutlineEntry[] } | undefined
  let typewriterFrame = 0
  const window = host.ownerDocument.defaultView!
  const live = liveDecoration(options, getOutline, from => {
    select({ anchor: from, head: from })
    view.focus()
  })
  const displayExtensions = () => [
    EditorState.readOnly.of(!!display.readonly),
    EditorView.editable.of(!display.readonly),
    display.focus ? highlightActiveLine() : [],
    EditorView.contentAttributes.of({
      spellcheck: String(display.spellcheck),
      ...(display.readonly ? { tabindex: '0', 'aria-readonly': 'true' } : {}),
    }),
  ]
  const modeExtensions = () => currentMode === 'live' ? live : []
  const extensions = () => [
    rawBuffer, originalSelection, rawHistory, coalesceEndings, history(),
    invertedEffects.of(tr => tr.docChanged || tr.effects.some(effect => effect.is(restoreRaw))
      ? [selectionEffect.of(tr.startState.field(originalSelection))] : []),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    markdown({ extensions: GFM, codeLanguages: languages }),
    syntaxHighlighting(defaultHighlightStyle),
    EditorView.lineWrapping,
    mode.of(modeExtensions()),
    presentation.of(displayExtensions()),
    EditorView.contentAttributes.of({ 'aria-label': 'Markdown 文档' }),
    EditorView.updateListener.of(update => {
      if (update.docChanged || update.startState.field(rawBuffer) !== update.state.field(rawBuffer)) options.onChange()
      if (update.selectionSet || update.docChanged) {
        updateFocusLine()
        options.onSelectionChange()
        if (display.typewriter && !update.view.composing && update.view.hasFocus) centerCaret()
      }
    }),
    Prec.high(EditorView.domEventHandlers({
      copy: (event, editor) => copy(event, editor, false),
      cut: (event, editor) => copy(event, editor, true),
      paste(event, editor) {
        if (editor.state.readOnly) return true
        const data = event.clipboardData
        if (!data) return false
        const files = Array.from(data.files)
        if (files.length && options.onAssetPaste) {
          event.preventDefault()
          void pasteAssets(files)
          return true
        }
        const value = data.getData(clipboardType) || data.getData('text/plain')
        if (!value) return false
        const { anchor, head } = getSelection()
        const from = Math.min(anchor, head)
        event.preventDefault()
        const cursor = from + value.length
        replace(from, Math.max(anchor, head), value, { anchor: cursor, head: cursor }, 'input.paste')
        return true
      },
      click(event) {
        if (!(event.target instanceof window.Element)) return false
        const anchor = event.target.closest<HTMLAnchorElement>('a[href]')
        const textLink = event.target.closest<HTMLElement>('[data-markdown-url]')
        const url = anchor?.getAttribute('href') ?? textLink?.dataset.markdownUrl
        if (!url || !safeUrl(url) || (!anchor && !display.readonly && !event.metaKey && !event.ctrlKey)) return false
        event.preventDefault()
        if (url.startsWith('#')) {
          // 文档内锚点使用原文偏移跳转，也适用于混合换行的大纲。
          const target = getOutline().find(entry => '#' + entry.id === url || '#' + encodeURIComponent(entry.id ?? '') === url)
          if (target) select({ anchor: target.from, head: target.from })
        } else options.onOpenLink?.(url)
        return true
      },
    })),
  ]
  const view = new EditorView({ parent: host, state: EditorState.create({ extensions: extensions() }) })
  host.dataset.mode = currentMode

  async function pasteAssets(files: File[]) {
    try {
      for (const file of files) await options.onAssetPaste?.(file)
    } catch (error) {
      // 协调层可以在回调中展示具体失败原因。
      console.error('粘贴附件失败', error)
    }
  }

  function copy(event: ClipboardEvent, editor: EditorView, cut: boolean) {
    const { anchor, head } = getSelection()
    if (anchor === head || !event.clipboardData) return false
    event.preventDefault()
    const from = Math.min(anchor, head)
    const to = Math.max(anchor, head)
    const value = rawSlice(from, to)
    event.clipboardData.setData('text/plain', value)
    event.clipboardData.setData(clipboardType, value)
    if (cut && !editor.state.readOnly) replace(from, to, '', { anchor: from, head: from }, 'delete.cut')
    return true
  }

  function rawSlice(from: number, to: number) {
    const { state } = view
    const raw = state.field(rawBuffer)
    const a = locate(state.doc, raw, from)
    const b = locate(state.doc, raw, to)
    return originalSlice(state.doc, raw, a.pos, b.pos + b.inside).slice(a.inside, b.inside ? -1 : undefined)
  }

  function getSelection(): Selection {
    const { state } = view
    const explicit = state.field(originalSelection)
    if (explicit) return explicit
    const raw = state.field(rawBuffer)
    const { anchor, head } = state.selection.main
    return { anchor: originalOffset(state.doc, raw, anchor), head: originalOffset(state.doc, raw, head) }
  }

  function select({ anchor, head }: Selection, scroll = true) {
    const { state } = view
    const raw = state.field(rawBuffer)
    const size = originalOffset(state.doc, raw, state.doc.length)
    anchor = Math.max(0, Math.min(size, anchor))
    head = Math.max(0, Math.min(size, head))
    view.dispatch({
      selection: { anchor: locate(state.doc, raw, anchor).pos, head: locate(state.doc, raw, head).pos },
      effects: selectionEffect.of({ anchor, head }),
      scrollIntoView: scroll,
    })
  }

  function replace(from: number, to: number, value: string, selection?: Selection, userEvent = 'input') {
    const { state } = view
    if (state.readOnly) return
    const raw = state.field(rawBuffer)
    const length = originalOffset(state.doc, raw, state.doc.length)
    if (from < 0 || to < from || to > length) throw new RangeError('替换范围超出 Markdown 文档')
    if (from === to && !value) return
    const a = locate(state.doc, raw, from)
    const b = locate(state.doc, raw, to)
    // 邻接的 CR 和 LF 可合并为一个逻辑换行。只检查替换两侧紧邻的换行。
    const first = state.doc.lineAt(a.pos)
    const last = state.doc.lineAt(b.pos)
    const start = a.pos === first.from && first.number > 1 ? a.pos - 1 : a.pos
    const end = b.pos === last.to && last.number < state.doc.lines ? b.pos + 1 : b.pos
    const rawStart = originalOffset(state.doc, raw, start)
    const rawEnd = originalOffset(state.doc, raw, end)
    const changed = encode(rawSlice(rawStart, from) + value + rawSlice(to, rawEnd))
    const previous = getSelection()
    const map = (position: number) => position <= from ? position : position >= to
      ? position + value.length - (to - from) : from + value.length
    const next = selection ?? { anchor: map(previous.anchor), head: map(previous.head) }
    const changes = state.changes({ from: start, to: end, insert: changed.doc })
    const nextDoc = changes.apply(state.doc)
    const nextRaw = raw.replace(encodedOffset(state.doc, raw, start), encodedOffset(state.doc, raw, end), changed.raw)
    view.dispatch({
      changes,
      selection: { anchor: locate(nextDoc, nextRaw, next.anchor).pos, head: locate(nextDoc, nextRaw, next.head).pos },
      effects: [restoreRaw.of(nextRaw), selectionEffect.of(next)],
      annotations: [Transaction.userEvent.of(userEvent), isolateHistory.of('full')],
      scrollIntoView: !!selection,
    })
  }

  function getOutline() {
    const { doc } = view.state
    const raw = view.state.field(rawBuffer)
    if (outlineCache?.doc === doc && outlineCache.raw === raw) return outlineCache.entries
    const normalized = doc.toString()
    const yaml = /^---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(normalized)
    const entries: OutlineEntry[] = []
    const used = new Set<string>()
    outlineParser.parse(normalized).iterate({
      enter(node) {
        const heading = /^(ATX|Setext)Heading([1-6])$/.exec(node.name)
        if (!heading || node.from < (yaml?.[0].length ?? 0)) return
        const title = headingText(doc.sliceString(node.from, node.to)
          .replace(/^#{1,6}[ \t]*|[ \t]+#+[ \t]*$/g, '')
          .replace(/\n[ \t]*[=-]+[ \t]*$/, '').trim())
        entries.push({ level: Number(heading[2]), title, from: originalOffset(doc, raw, node.from), id: headingId(title, used) })
      },
    })
    outlineCache = { doc, raw, entries }
    return entries
  }

  function updateFocusLine() {
    host.classList.toggle('editor-focus', display.focus)
  }

  function centerCaret() {
    window.cancelAnimationFrame(typewriterFrame)
    typewriterFrame = window.requestAnimationFrame(() => {
      if (host.isConnected && display.typewriter && !view.composing) {
        view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' }) })
      }
    })
  }

  return {
    setMarkdown(value) {
      const { doc, raw } = encode(value)
      view.setState(EditorState.create({ doc, extensions: extensions().concat(rawBuffer.init(() => raw)) }))
    },
    getMarkdown: () => originalSlice(view.state.doc, view.state.field(rawBuffer)),
    getSelection,
    select,
    replace,
    setMode(next) {
      if (currentMode === next) return
      currentMode = next
      host.dataset.mode = next
      view.dispatch({ effects: mode.reconfigure(modeExtensions()) })
    },
    setPresentation(value) {
      display = value
      view.dispatch({ effects: presentation.reconfigure(displayExtensions()) })
      updateFocusLine()
      if (display.typewriter) centerCaret()
    },
    format(kind) {
      if (view.state.readOnly) return
      const { doc } = view.state
      const raw = view.state.field(rawBuffer)
      const { anchor, head } = getSelection()
      let from = Math.min(anchor, head)
      let to = Math.max(anchor, head)
      const first = doc.lineAt(locate(doc, raw, from).pos)
      const last = doc.lineAt(locate(doc, raw, to).pos)
      const eol = first.number < doc.lines ? originalSlice(doc, raw, first.to, first.to + 1)
        : first.number > 1 ? originalSlice(doc, raw, first.from - 1, first.from) : '\n'
      if (lineFormats.has(kind) || (kind === 'clear' && from === to)) {
        const ending = last.number > first.number && to === originalOffset(doc, raw, last.from)
          ? doc.line(last.number - 1) : last
        from = originalOffset(doc, raw, first.from)
        to = originalOffset(doc, raw, ending.to)
      }
      const formatted = applyFormat(kind, rawSlice(from, to), eol)
      const leading = blockFormats.has(kind) && from > 0 ? eol + eol : ''
      const trailing = blockFormats.has(kind) && to < originalOffset(doc, raw, doc.length) ? eol + eol : ''
      const start = from + leading.length + formatted.start
      const end = from + leading.length + formatted.end
      replace(from, to, leading + formatted.text + trailing, anchor <= head ? { anchor: start, head: end } : { anchor: end, head: start })
      view.focus()
    },
    getOutline,
    focus: () => view.focus(),
    undo: () => { if (!view.state.readOnly) undo(view) },
    redo: () => { if (!view.state.readOnly) redo(view) },
    destroy: () => {
      window.cancelAnimationFrame(typewriterFrame)
      view.destroy()
    },
  }
}
