import type { Editor, ShellAction } from '../contracts'
import { bindContextMenu, copyCommand, type ContextItem } from './context-menu'
import { icons } from './icons'

export function bindEditorMenu(paper: HTMLElement, options: {
  editor: () => Editor | undefined
  dispatch: (action: ShellAction) => void
  formatting: () => ContextItem[]
  find: (replace: boolean) => void
  preview: (name: string, src: string) => void
  addToAi: () => void
  notify: (message: string) => void
}) {
  bindContextMenu(paper, '文档编辑操作', (target, point) => {
    const editor = options.editor()
    const context = editor?.contextAt(target, point)
    if (!editor || !context) return []
    const { media, link, image, readonly, selected } = context
    const run = (action: ShellAction) => () => { editor.focus(); options.dispatch(action) }
    const items: ContextItem[] = []
    if (context.editDiagram) items.push({ label: '编辑图表', icon: icons.edit, run: context.editDiagram })
    const cell = target.closest<HTMLElement>('.live-table-preview :is(td, th)')
    if (cell && !readonly) items.push({ label: '编辑单元格', icon: icons.edit, run: () => cell.click() })
    if (image) items.push({ label: '预览图片', icon: icons.image, run: () => options.preview(image.name, image.src) })
    if (link) items.push({ label: '打开链接', run: link.open }, copyCommand('复制链接地址', link.url, paper, options.notify))
    if (media) items.push({ label: media.image ? '选中图片原文' : '选中链接原文', icon: icons.edit, run: media.select })
    if (items.length) items.push(null)
    if (!readonly) {
      items.push(
        { label: '撤销', icon: icons.undo, disabled: !context.canUndo, run: run({ type: 'undo' }) },
        { label: '重做', icon: icons.redo, disabled: !context.canRedo, run: run({ type: 'redo' }) }, null,
        { label: '剪切', disabled: !selected, run: run({ type: 'cut' }) },
      )
    }
    items.push(
      { label: '复制', icon: icons.copy, disabled: !selected, run: run({ type: 'copy-markdown' }) },
      { label: '复制为 HTML', disabled: !selected, run: run({ type: 'copy-html' }) },
    )
    if (!readonly) items.push(
      { label: '粘贴', run: run({ type: 'paste' }) },
      { label: '粘贴为纯文本', run: run({ type: 'paste-plain' }) },
    )
    items.push({ label: '全选', run: context.selectAll }, null, { label: '查找…', icon: icons.search, run: () => options.find(false) })
    if (!readonly) items.push(
      { label: '查找与替换…', run: () => options.find(true) }, null,
      ...options.formatting(),
    )
    if (selected) items.push(null, { label: '添加选区到 AI', icon: icons.sparkles, run: options.addToAi })
    return items
  })
}
