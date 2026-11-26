import type { WorkspaceEntry } from '../contracts'
import { el, filterWorkspaceFiles, flattenWorkspaceFiles, type FlatFileEntry } from './helpers'
import { icons } from './icons'
import { openDesktopWindow } from './desktop-window'
import {
  SHORTCUT_DEFINITIONS,
  detectMac,
  eventToCombo,
  formatComboLabel,
  type ShortcutCategory,
  type ShortcutCommandId,
  type ShortcutRegistry,
} from './shortcuts'

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'textarea:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',')
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    item => item.offsetParent !== null || item === container.ownerDocument.activeElement,
  )
}

export class ModalManager {
  private backdrop: HTMLElement
  private activeDialog: HTMLElement | null = null
  private returnFocusTo: HTMLElement | null = null
  private onCloseCallback: (() => void) | null = null
  private popup: ReturnType<typeof openDesktopWindow> = null
  private keydownHandler: (event: KeyboardEvent) => void

  constructor(private host: HTMLElement, private fallbackFocus: () => void) {
    this.backdrop = el('div', {
      className: 'yy-modal-backdrop yy-chrome',
      attrs: { hidden: '' },
    })
    this.backdrop.addEventListener('mousedown', event => {
      if (event.target === this.backdrop) this.close()
    })
    this.host.append(this.backdrop)

    this.keydownHandler = event => {
      if (!this.activeDialog) return
      if (event.key === 'Escape') {
        // 先关闭展开的选项列表，快捷键录制也有自己的取消处理。
        if (this.activeDialog.dataset.recording === 'true') return
        if (event.target instanceof Element && event.target.closest('[role="combobox"][aria-expanded="true"]')) return
        event.preventDefault()
        event.stopPropagation()
        this.close()
        return
      }
      if (event.key === 'Tab') {
        const focusables = getFocusableElements(this.activeDialog)
        if (focusables.length === 0) {
          event.preventDefault()
          return
        }
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = this.activeDialog.ownerDocument.activeElement
        if (event.shiftKey) {
          if (!active || active === first || !this.activeDialog.contains(active)) {
            event.preventDefault()
            last.focus()
          }
        } else if (!active || active === last || !this.activeDialog.contains(active)) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', this.keydownHandler, true)
  }

  get isOpen(): boolean {
    return this.activeDialog !== null
  }

  open(dialog: HTMLElement, options?: { initialFocus?: HTMLElement | null; onClose?: () => void; size?: [number, number] }) {
    if (this.activeDialog) this.close(false)
    const active = document.activeElement
    this.returnFocusTo = active instanceof HTMLElement ? active : null
    this.activeDialog = dialog
    this.onCloseCallback = options?.onClose ?? null
    const [width, height] = options?.size ?? [720, 580]
    this.popup = openDesktopWindow(dialog, {
      title: dialog.getAttribute('aria-label') ?? '页屿', width, height, modal: true, onClose: () => this.close(),
    })
    if (this.popup) this.popup.child.addEventListener('keydown', this.keydownHandler, true)
    else {
      this.backdrop.replaceChildren(dialog)
      this.backdrop.removeAttribute('hidden')
    }
    const target = options?.initialFocus ?? getFocusableElements(dialog)[0] ?? dialog
    if (!target.hasAttribute('tabindex') && target === dialog) {
      dialog.tabIndex = -1
    }
    queueMicrotask(() => target.focus())
  }

  close(restoreFocus = true) {
    if (!this.activeDialog) return
    const cb = this.onCloseCallback
    this.activeDialog = null
    this.onCloseCallback = null
    this.popup?.child.removeEventListener('keydown', this.keydownHandler, true)
    this.popup?.close()
    this.popup = null
    this.backdrop.replaceChildren()
    this.backdrop.setAttribute('hidden', '')
    cb?.()
    if (restoreFocus) {
      const target = this.returnFocusTo
      this.returnFocusTo = null
      if (target && target.isConnected && !target.hasAttribute('disabled')) {
        target.focus()
      } else {
        this.fallbackFocus()
      }
    }
  }

  openQuickOpen(params: {
    entries: WorkspaceEntry[]
    workspaceRoot: string | null
    activePath: string | null
    onSelect: (path: string) => void
    onOpenFolder: () => void
  }) {
    const allFiles = flattenWorkspaceFiles(params.entries, params.workspaceRoot)
    let filtered: FlatFileEntry[] = allFiles
    let activeIndex = 0

    const dialog = el('div', {
      className: 'yy-modal yy-modal-quickopen',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '快速打开文件' },
    })

    const searchWrap = el('div', { className: 'yy-quickopen-head' })
    const iconSpan = el('span', { className: 'yy-icon', html: icons.search })
    const input = el('input', {
      className: 'yy-quickopen-input',
      type: 'text',
      attrs: {
        placeholder: allFiles.length > 0 ? '输入文件名或路径关键字，回车打开…' : '当前未打开文件夹，可先打开工作区',
        'aria-label': '筛选工作区文件',
        autocomplete: 'off',
      },
    })
    const closeBtn = el('button', {
      className: 'yy-icon-btn',
      type: 'button',
      html: icons.close,
      title: '关闭 (Esc)',
      attrs: { 'aria-label': '关闭快速打开' },
    })
    closeBtn.addEventListener('click', () => this.close())
    searchWrap.append(iconSpan, input, closeBtn)

    const list = el('div', {
      className: 'yy-quickopen-list',
      attrs: { role: 'listbox', 'aria-label': '匹配文件列表' },
    })

    const renderList = () => {
      list.replaceChildren()
      if (allFiles.length === 0) {
        const empty = el('div', { className: 'yy-empty-box' })
        empty.append(el('p', { text: '工作区暂无可检索文件' }))
        const openBtn = el('button', { className: 'yy-btn yy-btn-primary', type: 'button', text: '打开文件夹…' })
        openBtn.addEventListener('click', () => {
          this.close(false)
          params.onOpenFolder()
        })
        empty.append(openBtn)
        list.append(empty)
        return
      }
      if (filtered.length === 0) {
        list.append(el('div', { className: 'yy-empty-box', text: '没有匹配的文件' }))
        return
      }
      if (activeIndex >= filtered.length) activeIndex = filtered.length - 1
      if (activeIndex < 0) activeIndex = 0
      filtered.forEach((file, index) => {
        const item = el('button', {
          className: `yy-quickopen-item${index === activeIndex ? ' is-active' : ''}${file.path === params.activePath ? ' is-current' : ''}`,
          type: 'button',
          attrs: {
            role: 'option',
            'aria-selected': String(index === activeIndex),
            'data-path': file.path,
          },
        })
        const main = el('span', { className: 'yy-quickopen-name', text: file.name })
        const sub = el('span', { className: 'yy-quickopen-rel', text: file.relative })
        item.append(el('span', { className: 'yy-icon', html: icons.file }), main, sub)
        item.addEventListener('mouseenter', () => {
          activeIndex = index
          updateSelection()
        })
        item.addEventListener('click', () => {
          this.close(false)
          params.onSelect(file.path)
          this.fallbackFocus()
        })
        list.append(item)
      })
    }

    const updateSelection = () => {
      const items = list.querySelectorAll<HTMLElement>('.yy-quickopen-item')
      items.forEach((node, idx) => {
        const selected = idx === activeIndex
        node.classList.toggle('is-active', selected)
        node.setAttribute('aria-selected', String(selected))
        if (selected) node.scrollIntoView({ block: 'nearest' })
      })
    }

    input.addEventListener('input', () => {
      filtered = filterWorkspaceFiles(allFiles, input.value)
      activeIndex = 0
      renderList()
    })

    input.addEventListener('keydown', event => {
      if (event.isComposing) return
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (filtered.length > 0) {
          activeIndex = (activeIndex + 1) % filtered.length
          updateSelection()
        }
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (filtered.length > 0) {
          activeIndex = (activeIndex - 1 + filtered.length) % filtered.length
          updateSelection()
        }
      } else if (event.key === 'Enter') {
        event.preventDefault()
        const picked = filtered[activeIndex]
        if (picked) {
          this.close(false)
          params.onSelect(picked.path)
          this.fallbackFocus()
        }
      }
    })

    const foot = el('div', { className: 'yy-quickopen-foot' })
    const arrows = el('span', {
      className: 'yy-icon', html: icons.arrowUp + icons.arrowDown,
      attrs: { role: 'img', 'aria-label': '方向键' },
    })
    foot.append(arrows, document.createTextNode('选择 · Enter 打开 · Esc 返回文档'))

    dialog.append(searchWrap, list, foot)
    renderList()
    this.open(dialog, { initialFocus: input, size: [580, 450] })
  }

  openTextPrompt(params: {
    title: string
    label: string
    initialValue?: string
    placeholder?: string
    confirmText: string
    onConfirm: (value: string) => void
  }) {
    const dialog = el('div', {
      className: 'yy-modal yy-modal-prompt',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': params.title },
    })

    const header = el('div', { className: 'yy-modal-header' })
    header.append(el('h2', { text: params.title }))
    const closeBtn = el('button', {
      className: 'yy-icon-btn',
      type: 'button',
      html: icons.close,
      attrs: { 'aria-label': '关闭' },
    })
    closeBtn.addEventListener('click', () => this.close())
    header.append(closeBtn)

    const form = el('form', { className: 'yy-modal-body' })
    const fieldLabel = el('label', { className: 'yy-field' })
    fieldLabel.append(el('span', { className: 'yy-field-label', text: params.label }))
    const input = el('input', {
      className: 'yy-input',
      type: 'text',
      attrs: {
        placeholder: params.placeholder ?? '',
        autocomplete: 'off',
      },
    })
    input.value = params.initialValue ?? ''
    fieldLabel.append(input)

    const errorEl = el('div', { className: 'yy-form-error', attrs: { role: 'alert' } })

    const actions = el('div', { className: 'yy-modal-actions' })
    const cancelBtn = el('button', { className: 'yy-btn', type: 'button', text: '取消' })
    cancelBtn.addEventListener('click', () => this.close())
    const submitBtn = el('button', { className: 'yy-btn yy-btn-primary', type: 'submit', text: params.confirmText })
    actions.append(cancelBtn, submitBtn)

    form.addEventListener('submit', event => {
      event.preventDefault()
      const value = input.value.trim()
      if (!value) {
        errorEl.textContent = '名称不能为空'
        input.focus()
        return
      }
      if (/[\\/]/.test(value)) {
        errorEl.textContent = '名称不能包含路径分隔符'
        input.focus()
        return
      }
      this.close(false)
      params.onConfirm(value)
      this.fallbackFocus()
    })

    form.append(fieldLabel, errorEl, actions)
    dialog.append(header, form)
    this.open(dialog, { initialFocus: input, size: [450, 256] })
    queueMicrotask(() => input.select())
  }

  openConfirm(params: {
    title: string
    message: string
    confirmText: string
    danger?: boolean
    onConfirm: () => void
  }) {
    const dialog = el('div', {
      className: 'yy-modal yy-modal-prompt',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': params.title },
    })

    const header = el('div', { className: 'yy-modal-header' })
    header.append(el('h2', { text: params.title }))
    const closeBtn = el('button', {
      className: 'yy-icon-btn',
      type: 'button',
      html: icons.close,
      attrs: { 'aria-label': '关闭' },
    })
    closeBtn.addEventListener('click', () => this.close())
    header.append(closeBtn)

    const body = el('div', { className: 'yy-modal-body' })
    body.append(el('p', { className: 'yy-confirm-text', text: params.message }))

    const actions = el('div', { className: 'yy-modal-actions' })
    const cancelBtn = el('button', { className: 'yy-btn', type: 'button', text: '取消' })
    cancelBtn.addEventListener('click', () => this.close())
    const confirmBtn = el('button', {
      className: `yy-btn ${params.danger ? 'yy-btn-danger' : 'yy-btn-primary'}`,
      type: 'button',
      text: params.confirmText,
    })
    confirmBtn.addEventListener('click', () => {
      this.close(false)
      params.onConfirm()
      this.fallbackFocus()
    })
    actions.append(cancelBtn, confirmBtn)
    body.append(actions)
    dialog.append(header, body)
    this.open(dialog, { initialFocus: confirmBtn, size: [440, 208] })
  }

  openShortcutsModal(registry: ShortcutRegistry) {
    const isMac = detectMac()
    let recordingId: ShortcutCommandId | null = null
    let statusMessage = ''

    const dialog = el('div', {
      className: 'yy-modal yy-modal-shortcuts',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '快捷键设置' },
    })

    const header = el('div', { className: 'yy-modal-header' })
    header.append(el('h2', { text: '快捷键设置' }))
    const headerRight = el('div', { className: 'yy-row-gap' })
    const resetAllBtn = el('button', { className: 'yy-btn yy-btn-sm', type: 'button', text: '恢复默认' })
    const closeBtn = el('button', {
      className: 'yy-icon-btn',
      type: 'button',
      html: icons.close,
      attrs: { 'aria-label': '关闭快捷键设置' },
    })
    headerRight.append(resetAllBtn, closeBtn)
    header.append(headerRight)

    const filterRow = el('div', { className: 'yy-shortcuts-toolbar' })
    const filterInput = el('input', {
      className: 'yy-input',
      type: 'text',
      attrs: { placeholder: '筛选命令名称或快捷键…', 'aria-label': '筛选快捷键' },
    })
    const hint = el('span', { className: 'yy-muted-note', text: '配置保存在本地浏览器存储中' })
    filterRow.append(filterInput, hint)

    const noticeEl = el('div', { className: 'yy-shortcuts-notice', attrs: { 'aria-live': 'polite' } })
    const listWrap = el('div', { className: 'yy-shortcuts-list' })

    const stopRecording = () => {
      recordingId = null
      delete dialog.dataset.recording
    }

    const renderRows = () => {
      noticeEl.textContent = statusMessage
      listWrap.replaceChildren()
      const q = filterInput.value.trim().toLowerCase()
      const categories: ShortcutCategory[] = ['文件', '导航与检索', '视图与侧栏', '格式与编辑', '设置']

      for (const category of categories) {
        const defs = SHORTCUT_DEFINITIONS.filter(def => {
          if (def.category !== category) return false
          if (!q) return true
          const label = registry.getLabel(def.id, isMac).toLowerCase()
          const combo = registry.get(def.id).toLowerCase()
          return def.label.toLowerCase().includes(q) || label.includes(q) || combo.includes(q)
        })
        if (defs.length === 0) continue

        const group = el('section', { className: 'yy-shortcut-group' })
        group.append(el('h3', { className: 'yy-shortcut-cat', text: category }))

        for (const def of defs) {
          const combo = registry.get(def.id)
          const isRecording = recordingId === def.id
          const conflict = combo ? registry.findConflict(def.id, combo) : undefined
          const row = el('div', { className: `yy-shortcut-row${isRecording ? ' is-recording' : ''}` })

          const info = el('div', { className: 'yy-shortcut-info' })
          info.append(el('span', { className: 'yy-shortcut-name', text: def.label }))
          if (conflict) {
            info.append(el('span', { className: 'yy-shortcut-conflict', text: `与「${conflict.label}」冲突` }))
          }

          const controls = el('div', { className: 'yy-shortcut-controls' })
          const recordBtn = el('button', {
            className: `yy-kbd-btn${isRecording ? ' is-active' : ''}`,
            type: 'button',
            text: isRecording ? '请按下组合键… (Esc 取消)' : (formatComboLabel(combo, isMac) || '未绑定'),
            attrs: { 'data-shortcut-id': def.id },
          })
          recordBtn.addEventListener('click', () => {
            if (recordingId === def.id) {
              stopRecording()
            } else {
              recordingId = def.id
              dialog.dataset.recording = 'true'
              statusMessage = `正在录制「${def.label}」的快捷键，请按下组合键，或按 Backspace 清除。`
            }
            renderRows()
          })

          const clearBtn = el('button', {
            className: 'yy-btn yy-btn-xs yy-btn-ghost',
            type: 'button',
            text: '清除',
            title: '解除该快捷键绑定',
          })
          clearBtn.disabled = !combo
          clearBtn.addEventListener('click', () => {
            stopRecording()
            registry.set(def.id, '')
            statusMessage = `已清除「${def.label}」的快捷键`
            renderRows()
          })

          const resetBtn = el('button', {
            className: 'yy-btn yy-btn-xs yy-btn-ghost',
            type: 'button',
            text: '重置',
            title: `恢复为 ${formatComboLabel(def.defaultCombo, isMac)}`,
          })
          resetBtn.disabled = combo === def.defaultCombo
          resetBtn.addEventListener('click', () => {
            stopRecording()
            registry.resetOne(def.id)
            statusMessage = `已恢复「${def.label}」默认快捷键`
            renderRows()
          })

          controls.append(recordBtn, clearBtn, resetBtn)
          row.append(info, controls)
          group.append(row)
        }
        listWrap.append(group)
      }
      // 重绘会移除刚点击的按钮。把键盘焦点交给新按钮，让独立窗口继续接收录制按键。
      if (recordingId) listWrap.querySelector<HTMLButtonElement>('button.is-active[data-shortcut-id]')?.focus({ preventScroll: true })
    }

    const recordKeyHandler = (event: KeyboardEvent) => {
      if (!recordingId) return
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        stopRecording()
        statusMessage = '已取消录制'
        renderRows()
        return
      }
      if (event.key === 'Backspace' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const id = recordingId
        stopRecording()
        registry.set(id, '')
        statusMessage = '已清除绑定'
        renderRows()
        return
      }
      const combo = eventToCombo(event, isMac)
      if (!combo) {
        statusMessage = '请包含 ⌘/Ctrl/Alt 修饰键或使用功能键 F1-F12'
        noticeEl.textContent = statusMessage
        return
      }
      const id = recordingId
      stopRecording()
      const res = registry.set(id, combo)
      if (res.conflict) {
        statusMessage = `已更新为 ${formatComboLabel(combo, isMac)}（注意：与「${res.conflict.label}」冲突）`
      } else {
        statusMessage = `已保存快捷键 ${formatComboLabel(combo, isMac)}`
      }
      renderRows()
    }

    dialog.addEventListener('keydown', recordKeyHandler, true)

    filterInput.addEventListener('input', () => renderRows())
    resetAllBtn.addEventListener('click', () => {
      stopRecording()
      registry.resetDefaults(true)
      statusMessage = '已恢复全部默认快捷键'
      renderRows()
    })
    closeBtn.addEventListener('click', () => this.close())

    dialog.append(header, filterRow, noticeEl, listWrap)
    renderRows()
    this.open(dialog, {
      initialFocus: filterInput,
      onClose: () => {
        dialog.removeEventListener('keydown', recordKeyHandler, true)
      },
    })
  }

  destroy() {
    this.close(false)
    window.removeEventListener('keydown', this.keydownHandler, true)
    this.backdrop.remove()
  }
}

export type DialogPresenter = Pick<ModalManager, 'open' | 'close'>
