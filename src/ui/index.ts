import type { Shell, ShellAction, ShellActions } from '../contracts'
import './shell.css'

export function mountShell(root: HTMLElement, actions: ShellActions): Shell {
  root.innerHTML = `
    <header class="bar"><strong>页屿</strong><span class="file-title"></span><nav></nav></header>
    <main class="paper document-theme"><div class="editor-host"></div></main>
    <footer class="status" aria-live="polite"></footer>
  `
  const get = (selector: string) => root.querySelector<HTMLElement>(selector)!
  let source = false
  const add = (label: string, action: () => ShellAction) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.addEventListener('click', () => void actions.dispatch(action()))
    get('nav').append(button)
    return button
  }
  add('打开', () => ({ type: 'open' }))
  add('保存', () => ({ type: 'save' }))
  const toggle = add('源码', () => ({ type: 'mode', mode: source ? 'live' : 'source' }))
  add('导入主题', () => ({ type: 'theme-import' }))
  add('导出 HTML', () => ({ type: 'export', format: 'html' }))
  const style = document.createElement('style')
  document.head.append(style)
  return {
    editorHost: get('.editor-host'),
    setState(state) {
      source = state.mode === 'source'
      get('.file-title').textContent = state.title + (state.dirty ? ' •' : '')
      get('.status').textContent = state.detail || (source ? '源码' : '实时编辑')
      toggle.textContent = source ? '实时编辑' : '源码'
    },
    setOutline() {},
    setWorkspace() {},
    setSearchResults() {},
    setThemes(themes, active) { style.textContent = themes.find(theme => theme.id === active)?.styles.join('\n') ?? '' },
    setAI() {},
    setMcp() {},
    destroy() {
      style.remove()
      root.replaceChildren()
    },
  }
}
