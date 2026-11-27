import { invoke, Channel } from '@tauri-apps/api/core'
import { open, save, ask, message } from '@tauri-apps/plugin-dialog'
import type { AiAgentApprovalMode, AiPrompts, AiSkill, AiUsage, DocumentWidth, EditorMode, FindQuery, McpServer, Selection, SidebarTab, TitlebarMaterial } from './contracts'
import type { ImageUploadService, TyporaProfile } from './typora'

export type FileSnapshot = { path: string; text: string; bom: boolean; version: string; name: string }
export type Recovery = Selection & { path: string | null; text: string; bom: boolean; title: string; baseVersion: string | null; mode: EditorMode }
export type Preferences = {
  autosave: boolean; autoCheckUpdates: boolean; animations: boolean; theme: string; typoraThemes: Record<string, string>; workspace: string | null; mcp: McpServer[];
  hidden: boolean; allFiles: boolean; fileGlob: string; zoom: number; remoteImages: boolean; uploadEndpoint: string; recent: string[];
  aiPrompts: AiPrompts;
  aiSkills: AiSkill[];
  aiAgentApprovalMode: AiAgentApprovalMode;
  titlebarMaterial: TitlebarMaterial;
  pluginMarketSource: string;
  uploadService: ImageUploadService;
  autosaveDelay: number;
  spellcheck: boolean;
  sidebarTab?: SidebarTab;
  documentWidth?: DocumentWidth;
  leftSidebarWidth?: number;
  rightSidebarWidth?: number;
  findOptions: Pick<FindQuery, 'matchCase' | 'wholeWord'>;
}
export type McpProposal = { id: string; workspace: string; path: string; version: string; from: number; to: number; replacement: string; summary: string; created: number }
export type LocalMcp = { allowed: boolean; command: string }
export type StreamEvent = { kind: 'delta' | 'reasoning'; text: string } | { kind: 'done'; usage?: AiUsage } | { kind: 'cancelled' }
export { invoke, Channel, open, save, ask, message }

export const native = {
  read: (path: string) => invoke<FileSnapshot>('open_document', { path }),
  version: (path: string) => invoke<string | null>('document_version', { path }),
  write: (path: string, text: string, bom: boolean, expected: string | null) =>
    invoke<FileSnapshot>('save_document', { path, text, bom, expected }),
  recover: () => invoke<Recovery | null>('load_recovery'),
  checkpoint: (recovery: Recovery | null) => invoke<void>('save_recovery', { recovery }),
  preferences: () => invoke<Partial<Preferences> | null>('settings_load'),
  persist: (settings: Partial<Preferences>) => invoke<void>('settings_save', { settings }),
  recent: (path: string, forget = false) => invoke<string[]>('settings_recent', { path, forget }),
  typoraProfiles: (path: string | null = null) => invoke<TyporaProfile[]>('typora_profiles', { path }),
}

export function reason(error: unknown) {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message
  return String(error)
}
