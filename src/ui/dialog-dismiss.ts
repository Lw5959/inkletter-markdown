export function cancelDialog(dialog: HTMLDialogElement) {
  // 同一套取消行为用于 Esc、遮罩和系统返回，并允许安装等进行中的流程拦截。
  if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close('cancel')
}

export function dismissOnBackdrop(dialog: HTMLDialogElement) {
  const outside = (event: MouseEvent) => {
    if (event.target !== dialog) return false
    const box = dialog.getBoundingClientRect()
    return event.clientX < box.left || event.clientX >= box.right || event.clientY < box.top || event.clientY >= box.bottom
  }
  let pressedOutside = false
  dialog.addEventListener('pointerdown', event => { pressedOutside = outside(event) })
  dialog.addEventListener('click', event => {
    if (pressedOutside && outside(event)) cancelDialog(dialog)
    pressedOutside = false
  })
}
