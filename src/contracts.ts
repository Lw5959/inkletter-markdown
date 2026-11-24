// 文档偏移使用原始 Markdown 字符串的 UTF-16 单位，文件 BOM 在原生文件层处理。
export type EditorMode = 'live' | 'source'
export type Selection = { anchor: number; head: number }
export type OutlineEntry = { level: number; title: string; from: number; id?: string }
export type Presentation = { focus: boolean; typewriter: boolean; spellcheck: boolean; readonly?: boolean }
export type EditorFormat = 'bold' | 'italic' | 'strike' | 'underline' | 'inline-code' | 'link' | 'image'
  | 'heading-1' | 'heading-2' | 'heading-3' | 'quote' | 'bullet-list' | 'ordered-list'
  | 'task' | 'table' | 'code-block' | 'math' | 'mermaid' | 'rule' | 'toc' | 'footnote' | 'clear'
export type RenderOptions = { resolveImage?: (url: string) => string | Promise<string> }
export type EditorOptions = {
  onChange: () => void
  onSelectionChange: () => void
  onAssetPaste?: (file: File) => Promise<void>
  resolveImage?: (url: string) => string | Promise<string>
  onOpenLink?: (url: string) => void
}
export interface Editor {
  setMarkdown(markdown: string): void
  getMarkdown(): string
  getSelection(): Selection
  select(selection: Selection, scroll?: boolean): void
  replace(from: number, to: number, markdown: string): void
  setMode(mode: EditorMode): void
  setPresentation(presentation: Presentation): void
  format(format: EditorFormat): void
  getOutline(): OutlineEntry[]
  focus(): void
  undo(): void
  redo(): void
  destroy(): void
}
export type Theme = { id: string; name: string; styles: string[] }
export type WorkspaceEntry = { path: string; name: string; children?: WorkspaceEntry[] }
export type SearchResult = { path: string; name: string; line: number; preview: string }
export type FindQuery = { text: string; replacement: string; regex: boolean; matchCase: boolean; wholeWord: boolean }
export type AiIntent = 'chat' | 'outline' | 'draft' | 'continue' | 'rewrite' | 'polish' | 'summary' | 'translate' | 'proofread'
export type AiScope = 'selection' | 'paragraph' | 'document' | 'files'
export type AiSettings = { endpoint: string; model: string; hasKey: boolean }
export type AiContext = { scope: AiScope; label: string; text: string }
export type AiMessage = { role: 'user' | 'assistant'; text: string }
export type DiffPart = { kind: 'keep' | 'add' | 'remove'; text: string; hunk?: number }
export type Suggestion = { id: string; title: string; parts: DiffPart[]; hunks: number; source: 'ai' | 'mcp' }
export type AiView = {
  settings: AiSettings; context: AiContext | null; messages: AiMessage[]; stream: string;
  pending: boolean; error: string; suggestion: Suggestion | null; canRetry: boolean
}
export type McpServer = { id: string; name: string; transport: 'stdio' | 'http'; command?: string; args?: string[]; url?: string }
export type McpItem = { kind: 'tool' | 'resource' | 'prompt'; name: string; title?: string; description?: string; schema?: unknown }
export type McpConnection = { server: McpServer; status: 'idle' | 'connecting' | 'connected' | 'error'; items: McpItem[]; error?: string }
export type McpView = {
  connections: McpConnection[]; workspaceAllowed: boolean; command: string; proposals: number; result: string; error: string
}
export type ExportFormat = 'html' | 'plain-html' | 'pdf' | 'png' | 'docx' | 'epub' | 'odt' | 'latex'
  | 'rtf' | 'rst' | 'textile' | 'opml' | 'revealjs' | 'json' | 'commonmark'
export type ImageMode = 'copy' | 'move' | 'upload'
export type ShellAction =
  | { type: 'new' | 'open' | 'open-folder' | 'save' | 'save-as' | 'reload' | 'print' | 'import' | 'theme-import' | 'undo' | 'redo' | 'export-again' | 'copy-markdown' | 'copy-html' | 'paste-plain' | 'reopen' }
  | { type: 'open-path'; path: string; line?: number }
  | { type: 'mode'; mode: EditorMode }
  | { type: 'theme'; id: string }
  | { type: 'export'; format: ExportFormat }
  | { type: 'outline'; from: number }
  | { type: 'search-workspace'; text: string; regex: boolean }
  | { type: 'format'; format: EditorFormat }
  | { type: 'presentation'; value: Presentation }
  | { type: 'find'; query: FindQuery; operation: 'next' | 'previous' | 'replace' | 'replace-all' }
  | { type: 'workspace-create'; parent: string; name: string; folder: boolean }
  | { type: 'workspace-rename'; path: string; name: string }
  | { type: 'workspace-trash'; path: string }
  | { type: 'image-import'; files?: File[] }
  | { type: 'images'; mode: ImageMode }
  | { type: 'ai-config'; endpoint: string; model: string; key?: string }
  | { type: 'ai-context'; scope: AiScope }
  | { type: 'ai-context-clear' }
  | { type: 'ai-send'; intent: AiIntent; prompt: string }
  | { type: 'ai-cancel' | 'ai-retry' | 'ai-clear' }
  | { type: 'suggestion-apply'; id: string; hunks: number[] }
  | { type: 'suggestion-dismiss'; id: string }
  | { type: 'mcp-config'; server: McpServer }
  | { type: 'mcp-remove' | 'mcp-connect' | 'mcp-disconnect'; id: string }
  | { type: 'mcp-call'; id: string; item: McpItem; args: Record<string, unknown> }
  | { type: 'mcp-authorize'; allow: boolean }
  | { type: 'mcp-next' }
  | { type: 'autosave'; enabled: boolean }
export type ShellState = {
  title: string; path: string | null; dirty: boolean; mode: EditorMode;
  detail: string; words: number; characters: number; line: number; column: number;
  workspace: string | null; autosave: boolean; presentation: Presentation
}
export type ShellActions = { dispatch: (action: ShellAction) => void | Promise<void> }
export interface Shell {
  editorHost: HTMLElement
  setState(state: ShellState): void
  setOutline(outline: OutlineEntry[]): void
  setWorkspace(entries: WorkspaceEntry[]): void
  setSearchResults(results: SearchResult[]): void
  setThemes(themes: Theme[], active: string): void
  setAI(view: AiView): void
  setMcp(view: McpView): void
  destroy(): void
}
