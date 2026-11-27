import type { AiSkill, ShellAction, ShellActions } from '../contracts'
import type { DialogPresenter } from './dialogs'
import { el } from './helpers'
import { icons } from './icons'

export function openSkills(modals: DialogPresenter, skills: () => AiSkill[], dispatch: ShellActions['dispatch'], select: (name: string) => void) {
  const dialog = el('div', { className: 'yy-modal yy-ai-settings', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '写作技能' } })
  const close = el('button', { className: 'yy-icon-btn', type: 'button', html: icons.close, attrs: { 'aria-label': '关闭' } })
  const load = el('button', { className: 'yy-btn yy-btn-sm', type: 'button', text: '导入 SKILL.md' })
  const list = el('div', { className: 'yy-ai-skill-list' })
  const error = el('p', { className: 'yy-ai-setting-error', attrs: { role: 'alert', hidden: '' } })
  let busy = false

  async function update(action: ShellAction) {
    if (busy) return
    busy = true
    load.disabled = true
    list.inert = true
    error.hidden = true
    try {
      const failure = await dispatch(action)
      if (failure) throw new Error(failure)
      render()
    } catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : String(failure)
      error.hidden = false
    } finally {
      busy = load.disabled = list.inert = false
      if (dialog.isConnected && !dialog.contains(document.activeElement)) load.focus({ preventScroll: true })
    }
  }

  function render() {
    list.replaceChildren(...skills().map(skill => {
      const label = skill.label ?? skill.name
      const use = el('button', { className: 'yy-btn yy-btn-sm yy-btn-primary', type: 'button', text: '本轮使用', attrs: { 'aria-label': '使用 ' + label } })
      use.onclick = () => { modals.close(); select(skill.name) }
      const actions = el('div', { className: 'yy-ai-chat-controls' }, use)
      if (!skill.builtIn) {
        const remove = el('button', { className: 'yy-btn yy-btn-sm yy-btn-ghost', type: 'button', text: '移除', attrs: { 'aria-label': '移除 ' + label } })
        remove.onclick = () => { void update({ type: 'ai-skill-remove', name: skill.name }) }
        actions.append(remove)
      }
      const preview = el('details', {}, el('summary', { text: '查看技能内容' }),
        el('pre', { className: 'yy-context-fulltext', text: skill.instructions, attrs: { tabindex: '0' } }))
      return el('article', { className: 'yy-ai-skill-row', attrs: { 'aria-label': label } }, el('strong', { text: label }),
        el('p', { className: 'yy-ai-setting-help', text: skill.description }), preview, actions)
    }))
  }
  close.onclick = () => modals.close()
  load.onclick = () => { void update({ type: 'ai-skill-import' }) }
  dialog.append(el('header', { className: 'yy-ai-settings-head' }, el('h2', { text: '写作技能' }), close),
    el('div', { className: 'yy-ai-settings-fields yy-ai-skill-fields' }, load, list, error))
  render()
  modals.open(dialog, { initialFocus: load })
}
