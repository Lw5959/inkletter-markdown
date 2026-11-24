import { invoke } from '@tauri-apps/api/core'
import { open, save, ask, message } from '@tauri-apps/plugin-dialog'

export type FileSnapshot = { path: string; text: string; bom: boolean; version: string; name: string }
export { invoke, open, save, ask, message }

export const native = {
  read: (path: string) => invoke<FileSnapshot>('open_document', { path }),
  write: (path: string, text: string, bom: boolean, expected: string | null) =>
    invoke<FileSnapshot>('save_document', { path, text, bom, expected }),
}
