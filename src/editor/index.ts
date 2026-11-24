import { EditorSelection, EditorState, Compartment } from '@codemirror/state'
import { Decoration, EditorView, keymap, ViewPlugin } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, redo, undo } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import type { Editor, EditorMode, EditorOptions } from '../contracts'
import './editor.css'

const liveDecoration = ViewPlugin.fromClass(class {
  decorations: ReturnType<typeof Decoration.set>

  constructor(view: EditorView) {
    this.decorations = this.build(view)
  }

  update(update: import('@codemirror/view').ViewUpdate) {
    if (update.docChanged || update.viewportChanged || update.selectionSet) this.decorations = this.build(update.view)
  }

  build(view: EditorView) {
    const lines: ReturnType<ReturnType<typeof Decoration.line>['range']>[] = []
    const caretLine = view.state.doc.lineAt(view.state.selection.main.head).number
    for (const visible of view.visibleRanges) {
      syntaxTree(view.state).iterate({
        from: visible.from, to: visible.to,
        enter: node => {
          const heading = /^ATXHeading([1-6])$/.exec(node.name)
          if (heading) {
            const line = view.state.doc.lineAt(node.from)
            lines.push(Decoration.line({ class: 'live-h' + heading[1] }).range(line.from))
            if (line.number !== caretLine) {
              const marker = node.node.firstChild
              if (marker?.name === 'HeaderMark') {
                lines.push(Decoration.replace({}).range(marker.from, Math.min(marker.to + 1, line.to)))
              }
            }
          }
        },
      })
    }
    return Decoration.set(lines, true)
  }
}, { decorations: value => value.decorations })

export function createEditor(host: HTMLElement, options: EditorOptions): Editor {
  host.id = 'write'
  const mode = new Compartment()
  const extensions = [
    history(), keymap.of([...defaultKeymap, ...historyKeymap]), markdown(),
    EditorView.lineWrapping, mode.of(liveDecoration),
    EditorView.contentAttributes.of({ 'aria-label': 'Markdown 文档', spellcheck: 'false' }),
    EditorView.updateListener.of(update => {
      if (update.docChanged) options.onChange()
      if (update.selectionSet) options.onSelectionChange()
    }),
  ]
  let eol = '\n'
  const view = new EditorView({ parent: host, state: EditorState.create({ extensions }) })
  function setMode(next: EditorMode) {
    view.dispatch({ effects: mode.reconfigure(next === 'live' ? liveDecoration : []) })
    host.dataset.mode = next
  }
  setMode('live')
  return {
    setMarkdown(value) {
      eol = value.match(/\r\n|\r|\n/)?.[0] ?? '\n'
      view.setState(EditorState.create({ doc: value, extensions, selection: EditorSelection.cursor(0) }))
      setMode(host.dataset.mode === 'source' ? 'source' : 'live')
    },
    getMarkdown: () => view.state.doc.sliceString(0, undefined, eol),
    getSelection: () => view.state.selection.main,
    select: (selection, scroll = true) => view.dispatch({ selection, scrollIntoView: scroll }),
    replace: (from, to, insert) => view.dispatch({ changes: { from, to, insert } }),
    setMode,
    setPresentation: value => view.contentDOM.setAttribute('spellcheck', String(value.spellcheck)),
    format() {},
    getOutline: () => [],
    focus: () => view.focus(),
    undo: () => { undo(view) },
    redo: () => { redo(view) },
    destroy: () => view.destroy(),
  }
}

export async function renderMarkdown(markdown: string): Promise<string> {
  const escaped = markdown.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char] ?? char)
  return escaped.split(/\r?\n/).map(line => {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (!heading) return line.trim() ? '<p>' + line + '</p>' : ''
    return '<h' + heading[1].length + '>' + heading[2] + '</h' + heading[1].length + '>'
  }).join('\n')
}
