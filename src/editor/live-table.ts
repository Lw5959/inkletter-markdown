import { defaultKeymap, redo, undo } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { Annotation, EditorState, StateEffect, type Extension } from '@codemirror/state'
import { EditorView, WidgetType, keymap } from '@codemirror/view'
import type { EditorOptions } from '../contracts'
import { renderMarkdown } from './render'
import { markdownSyntax } from './syntax'

export const cellEdit = Annotation.define<boolean>()
export const refreshTable = StateEffect.define<null>()

type MountedTable = { length: number; generation: number; close?: (refresh?: boolean) => void }
const mounts = new WeakMap<HTMLElement, MountedTable>()
const editing = new WeakMap<EditorView, HTMLElement>()

export function editingTable(view: EditorView) {
  const element = editing.get(view)
  if (!element?.isConnected) return null
  const from = view.posAtDOM(element)
  return { from, to: from + mounts.get(element)!.length }
}

function cellRange(line: string, column: number) {
  // 和表格渲染器按未转义竖线分列。单元格范围跳过周围排版空格。
  const pipes: number[] = []
  for (let i = 0; i < line.length; i++) if (line[i] === '|' && line[i - 1] !== '\\') pipes.push(i)
  const leading = pipes.length > 0 && !line.slice(0, pipes[0]).trim()
  const trailing = pipes.length > 0 && !line.slice(pipes[pipes.length - 1] + 1).trim()
  const boundaries = [...(leading ? [] : [-1]), ...pipes, ...(trailing ? [] : [line.length])]
  if (column + 1 >= boundaries.length) {
    const at = line.trimEnd().length
    return { from: at, to: at, prefix: (trailing ? ' ' : ' | ') + ' | '.repeat(column + 1 - boundaries.length), suffix: ' |' }
  }
  const start = boundaries[column] + 1
  const end = boundaries[column + 1]
  const source = line.slice(start, end)
  const from = start + source.length - source.trimStart().length
  return { from, to: Math.max(from, start + source.trimEnd().length), prefix: '', suffix: '' }
}

function cellText(text: string) {
  return text.replace(/\r\n|[\r\n]/g, ' ').replace(/(?<!\\)\|/g, '\\|')
}

export class LiveTable extends WidgetType {
  constructor(readonly source: string, readonly options: EditorOptions, readonly readOnly: boolean, readonly inline: Extension) { super() }
  eq(other: LiveTable) { return other.source === this.source && other.readOnly === this.readOnly }

  toDOM(view: EditorView) {
    const element = view.dom.ownerDocument.createElement('div')
    element.className = 'live-block-preview live-table-preview'
    element.contentEditable = 'false'
    mounts.set(element, { generation: 0, length: this.source.length })
    const start = (event: MouseEvent | KeyboardEvent) => {
      const cell = (event.target as HTMLElement | null)?.closest?.<HTMLTableCellElement>('td, th')
      if (!cell || !element.contains(cell) || view.state.readOnly || cell.querySelector('.live-cell-editor')) return
      if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Enter') return
      if (event.target instanceof Element && event.target.closest('a[href]') && (event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      event.stopPropagation()
      const previous = editing.get(view)
      if (previous) mounts.get(previous)?.close?.()
      this.openCell(view, element, cell, event.type === 'click' ? event as MouseEvent : undefined)
    }
    element.addEventListener('click', start)
    element.addEventListener('keydown', start)
    this.render(element, view)
    return element
  }

  updateDOM(dom: HTMLElement, view: EditorView, previous: LiveTable) {
    // 数据刚写回时保留正在编辑的单元格，避免输入法失焦。
    const mount = mounts.get(dom)
    if (!mount || previous.readOnly !== this.readOnly) return false
    if (!mount.close) this.render(dom, view)
    return true
  }

  private render(element: HTMLElement, view: EditorView) {
    const mount = mounts.get(element)!
    const generation = ++mount.generation
    mount.length = this.source.length
    renderMarkdown(this.source, this.options).then(html => {
      if (!element.isConnected || mount.generation !== generation || mount.close) return
      element.innerHTML = html
      if (!view.state.readOnly) {
        for (const cell of element.querySelectorAll<HTMLTableCellElement>('td, th')) cell.tabIndex = 0
      }
      view.requestMeasure()
    }).catch(() => {
      if (element.isConnected && mount.generation === generation && !mount.close && !element.firstChild) element.textContent = '表格暂时无法渲染'
    })
  }

  private openCell(view: EditorView, element: HTMLElement, cell: HTMLTableCellElement, click?: MouseEvent) {
    const tableFrom = view.posAtDOM(element)
    const { doc } = view.state
    const row = (cell.parentElement as HTMLTableRowElement).rowIndex
    const number = doc.lineAt(tableFrom).number + (row ? row + 1 : 0)
    if (number > doc.lines) return
    const line = doc.line(number)
    const range = cellRange(line.text, cell.cellIndex)
    let from = line.from - tableFrom + range.from
    let to = line.from - tableFrom + range.to
    const mount = mounts.get(element)!
    if (from < 0 || to > mount.length) return
    let prefix = range.prefix
    let suffix = range.suffix
    let current = line.text.slice(range.from, range.to)
    const preview = Array.from(cell.childNodes)
    const host = cell.ownerDocument.createElement('div')
    host.className = 'live-cell-editor'
    cell.replaceChildren(host)
    editing.set(view, element)

    const close = (refresh = true) => {
      if (!mount.close) return
      mount.close = undefined
      editing.delete(view)
      editor.destroy()
      cell.replaceChildren(...preview)
      if (refresh && element.isConnected) view.dispatch({ effects: refreshTable.of(null) })
    }
    mount.close = close
    const finish = () => { close(); view.focus(); return true }
    const editor = new EditorView({ parent: host, state: EditorState.create({ doc: current, selection: { anchor: current.length }, extensions: [
      markdown({ extensions: markdownSyntax }),
      this.inline,
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': '编辑单元格' }),
      keymap.of([
        { key: 'Enter', run: finish },
        { key: 'Escape', run: finish },
        { key: 'Mod-z', run: () => { finish(); return undo(view) } },
        { key: 'Mod-Shift-z', run: () => { finish(); return redo(view) } },
        ...defaultKeymap,
      ]),
      EditorView.updateListener.of(update => {
        if (!mount.close || !element.isConnected || (!update.docChanged && !update.selectionSet)) return
        const start = view.posAtDOM(element)
        const before = start + from
        const after = start + to
        if (view.state.readOnly || view.state.doc.sliceString(before, after) !== current) return
        const raw = update.state.doc.toString()
        const next = cellText(raw)
        const { anchor, head } = update.state.selection.main
        if (next === current) {
          view.dispatch({ selection: { anchor: before + cellText(raw.slice(0, anchor)).length, head: before + cellText(raw.slice(0, head)).length } })
          return
        }
        const at = before + prefix.length
        const insert = prefix + next + suffix
        from += prefix.length
        to = from + next.length
        mount.length += insert.length - (after - before)
        current = next
        prefix = suffix = ''
        view.dispatch({
          changes: { from: before, to: after, insert },
          selection: { anchor: at + cellText(raw.slice(0, anchor)).length, head: at + cellText(raw.slice(0, head)).length },
          userEvent: 'input.type', annotations: cellEdit.of(true),
        })
      }),
    ] }) })
    host.addEventListener('focusout', () => {
      // 切换单元格时保留其余表格 DOM，等点击落到目标格再重算预览。
      queueMicrotask(() => { if (mount.close && !host.contains(cell.ownerDocument.activeElement)) close() })
    })
    if (click) {
      const position = editor.posAtCoords({ x: click.clientX, y: click.clientY }, false)
      if (position != null) editor.dispatch({ selection: { anchor: position } })
    } else editor.dispatch({ selection: { anchor: current.length } })
    editor.focus()
  }

  destroy(element: HTMLElement) {
    // 销毁前先让关闭例程跳过刷新，避免在父视图更新中再次 dispatch。
    mounts.get(element)?.close?.(false)
    mounts.delete(element)
  }

  ignoreEvent(event: Event) {
    const target = event.target as HTMLElement | null
    const link = event as MouseEvent
    return event.type !== 'click' || !target?.closest?.('a[href]') || !(this.readOnly || link.ctrlKey || link.metaKey)
  }
}
