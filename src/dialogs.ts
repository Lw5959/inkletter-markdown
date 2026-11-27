import './dialogs.css'
import { markdownDiff } from './suggestions'
import { el } from './ui/helpers'
import { dismissOnBackdrop } from './ui/dialog-dismiss'
import type { createPages } from './ui/pages'
import { openDesktopWindow } from './ui/desktop-window'

type Choice = { label: string; value: string; primary?: boolean; autofocus?: boolean }

function dialog(title: string, detail: string) {
  const element = document.createElement('dialog')
  element.className = 'app-dialog'
  element.setAttribute('aria-label', title)
  const heading = document.createElement('h2')
  heading.textContent = title
  const description = document.createElement('p')
  description.textContent = detail
  const form = document.createElement('form')
  form.method = 'dialog'
  const controls = document.createElement('div')
  controls.className = 'app-dialog-actions'
  form.append(heading, description)
  element.append(form)
  return { element, form, controls }
}

function addButton(controls: HTMLElement, label: string, value: string, primary = false) {
  const button = document.createElement('button')
  button.value = value
  button.textContent = label
  if (primary) button.classList.add('app-dialog-primary')
  controls.append(button)
  return button
}

function present(element: HTMLDialogElement) {
  const previous = document.activeElement
  return new Promise<string>(resolve => {
    const review = element.classList.contains('app-review-dialog')
    const done = () => {
      element.removeEventListener('close', done)
      popup?.close()
      if (!popup) element.remove()
      resolve(element.returnValue)
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
    }
    const popup = openDesktopWindow(element, {
      title: element.getAttribute('aria-label') ?? '墨笺', width: review ? 820 : 440,
      height: review ? 560 : element.querySelector('input') ? 200 : 152, modal: true, onClose: done,
    })
    if (!popup) {
      dismissOnBackdrop(element)
      document.body.append(element)
    }
    element.addEventListener('close', done, { once: true })
    element.showModal()
  })
}

export function choose(title: string, detail: string, choices: Choice[]) {
  const { element, form, controls } = dialog(title, detail)
  for (const option of choices) {
    addButton(controls, option.label, option.value, option.primary).autofocus = option.autofocus ?? false
  }
  form.append(controls)
  return present(element)
}

export async function readSetting(title: string, detail: string, current: string, type: 'url' | 'text' = 'url') {
  const { element, form, controls } = dialog(title, detail)
  const input = document.createElement('input')
  input.type = type
  input.value = current
  input.required = type === 'url'
  input.setAttribute('aria-label', title)
  input.autofocus = true
  addButton(controls, '取消', 'cancel')
  const cancel = controls.firstElementChild as HTMLButtonElement
  cancel.formNoValidate = true
  addButton(controls, '确认', 'ok', true)
  form.append(input, controls)
  return await present(element) === 'ok' ? input.value.trim() : null
}

type ReviewDocument = { path: string; name: string; text: string; replacement: string }

export async function reviewChanges(
  title: string, description: string, entries: ReviewDocument[],
  apply: string, selectFiles: boolean, issues: string[] = [],
  pages?: Pick<ReturnType<typeof createPages>, 'open' | 'back'>,
): Promise<Set<string>> {
  const { element, form, controls } = dialog(title, description)
  element.classList.add('app-review-dialog')
  const selected = new Set(entries.map(entry => entry.path))
  const list = el('div', { className: 'app-review-files', attrs: { 'aria-label': '待修改文件' } })
  const preview = el('div', { className: 'app-review-preview', attrs: { 'aria-label': '修改预览', tabindex: '0' } })
  const cancel = addButton(controls, '取消', 'cancel')
  cancel.autofocus = !pages
  const confirm = addButton(controls, apply, 'apply', true)
  let active: HTMLButtonElement | undefined
  function show(entry: ReviewDocument, button?: HTMLButtonElement) {
    active?.setAttribute('aria-pressed', 'false')
    active = button
    active?.setAttribute('aria-pressed', 'true')
    preview.replaceChildren(...markdownDiff(entry.text, entry.replacement).map(part => {
      const kind = part.added ? 'add' : part.removed ? 'remove' : 'context'
      const prefix = part.added ? '+ ' : part.removed ? '− ' : '  '
      return el('pre', {
        className: 'app-review-' + kind,
        text: part.value.replace(/\r\n?/g, '\n').replace(/^(?=[\s\S])/gm, prefix),
      })
    }))
    preview.scrollTop = 0
    preview.querySelector<HTMLElement>('.app-review-add, .app-review-remove')?.scrollIntoView({ block: 'nearest' })
  }
  const content = el('div', { className: selectFiles ? 'app-review-grid' : 'app-review-single' })
  if (selectFiles) {
    for (const entry of entries) {
      const check = el('input', { type: 'checkbox', attrs: { 'aria-label': '写回 ' + entry.path } })
      check.checked = true
      check.addEventListener('change', () => {
        if (check.checked) selected.add(entry.path)
        else selected.delete(entry.path)
        confirm.disabled = selected.size === 0
      })
      const button = el('button', { type: 'button', text: entry.name, attrs: { title: entry.path, 'aria-pressed': 'false' } })
      button.addEventListener('click', () => show(entry, button))
      list.append(el('div', { className: 'app-review-file' }, check, button))
      if (!active) show(entry, button)
    }
    content.append(list)
  } else {
    show(entries[0])
  }
  content.append(preview)
  form.append(content)
  if (issues.length) {
    const details = el('details', { className: 'app-review-issues' })
    details.append(el('summary', { text: `${issues.length} 项跳过` }), el('p', { text: issues.join('\n') }))
    form.append(details)
  }
  form.append(controls)
  if (!pages) return await present(element) === 'apply' ? selected : new Set()

  form.querySelector('h2')?.remove()
  form.removeAttribute('method')
  form.classList.add('yy-mobile-brief-page', 'yy-mobile-review-page')
  return new Promise<Set<string>>(resolve => {
    let confirmed = false
    form.addEventListener('submit', event => {
      event.preventDefault()
      confirmed = event.submitter === confirm && !confirm.disabled
      pages.back()
    })
    pages.open(title, form, () => resolve(confirmed ? selected : new Set()))
  })
}
