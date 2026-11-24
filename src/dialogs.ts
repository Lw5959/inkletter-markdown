import './dialogs.css'

type Choice = { label: string; value: string; primary?: boolean }

function dialog(title: string, detail: string) {
  const element = document.createElement('dialog')
  element.className = 'app-dialog'
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
}

function present(element: HTMLDialogElement) {
  document.body.append(element)
  element.showModal()
  return new Promise<string>(resolve => element.addEventListener('close', () => {
    resolve(element.returnValue)
    element.remove()
  }, { once: true }))
}

export function choose(title: string, detail: string, choices: Choice[]) {
  const { element, form, controls } = dialog(title, detail)
  for (const option of choices) addButton(controls, option.label, option.value, option.primary)
  form.append(controls)
  return present(element)
}

export async function readSetting(title: string, detail: string, current: string) {
  const { element, form, controls } = dialog(title, detail)
  const input = document.createElement('input')
  input.type = 'url'
  input.value = current
  input.required = true
  input.setAttribute('aria-label', title)
  input.autofocus = true
  addButton(controls, '取消', 'cancel')
  const cancel = controls.firstElementChild as HTMLButtonElement
  cancel.formNoValidate = true
  addButton(controls, '确认', 'ok', true)
  form.append(input, controls)
  return await present(element) === 'ok' ? input.value.trim() : null
}
