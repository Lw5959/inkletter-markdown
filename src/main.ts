import type { ShellAction, ShellState, Theme } from './contracts'
import { createEditor, renderMarkdown } from './editor'
import { mountShell } from './ui'
import { ask, invoke, native, open, save } from './native'
import type { FileSnapshot } from './native'

let documentFile: FileSnapshot | null = null
const state: ShellState = {
  title: '未命名.md', path: null, dirty: false, mode: 'live', detail: '',
  words: 0, characters: 0, line: 1, column: 1, workspace: null, autosave: false,
  presentation: { focus: false, typewriter: false, spellcheck: false },
}
let activeTheme: Theme | null = null
const shell = mountShell(document.querySelector<HTMLElement>('#app')!, {
  dispatch: action => dispatch(action).catch(error => {
    state.detail = String(error)
    shell.setState(state)
  }),
})
const editor = createEditor(shell.editorHost, {
  onChange: () => { state.dirty = true; shell.setState(state) },
  onSelectionChange() {},
})
shell.setState(state)

async function dispatch(action: ShellAction) {
  switch (action.type) {
    case 'open': {
      const path = await open({ filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }] })
      if (!path || (state.dirty && !await ask('确定放弃未保存的编辑？'))) return
      documentFile = await native.read(path)
      state.title = documentFile.name
      state.path = documentFile.path
      state.dirty = false
      state.detail = '已打开'
      editor.setMarkdown(documentFile.text)
      editor.focus()
      break
    }
    case 'save': {
      const path = documentFile?.path ?? await save({ defaultPath: state.title, filters: [{ name: 'Markdown', extensions: ['md'] }] })
      if (!path) return
      const text = editor.getMarkdown()
      documentFile = await native.write(path, text, documentFile?.bom ?? false, documentFile?.version ?? null)
      state.path = documentFile.path
      state.title = documentFile.name
      state.dirty = editor.getMarkdown() !== text
      state.detail = '已保存'
      break
    }
    case 'mode':
      state.mode = action.mode
      editor.setMode(action.mode)
      editor.focus()
      break
    case 'theme-import': {
      const path = await open({ filters: [{ name: '主题 CSS', extensions: ['css'] }] })
      if (!path) return
      activeTheme = await invoke<Theme>('import_theme', { path })
      shell.setThemes([activeTheme], activeTheme.id)
      state.detail = '已载入主题 ' + activeTheme.name
      break
    }
    case 'export': {
      if (action.format !== 'html') return
      const path = await save({ defaultPath: state.title.replace(/\.[^.]+$/, '') + '.html', filters: [{ name: 'HTML', extensions: ['html'] }] })
      if (!path) return
      const rendered = await renderMarkdown(editor.getMarkdown())
      const css = activeTheme?.styles.join('\n').replace(/<\/style/gi, '<\\/style') ?? ''
      await invoke('write_export', { path, html: '<!doctype html><meta charset="utf-8"><style>' + css + '</style><main id="write">' + rendered + '</main>' })
      state.detail = '已导出 HTML'
      break
    }
    default: return
  }
  shell.setState(state)
}

window.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey) || event.isComposing) return
  const type = { o: 'open', s: 'save' }[event.key.toLowerCase()] as 'open' | 'save' | undefined
  if (type) {
    event.preventDefault()
    void dispatch({ type }).catch(error => { state.detail = String(error); shell.setState(state) })
  } else if (event.key === '/') {
    event.preventDefault()
    void dispatch({ type: 'mode', mode: state.mode === 'source' ? 'live' : 'source' })
  }
})
