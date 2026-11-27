// 文档偏移使用原始 Markdown 字符串的 UTF-16 单位，文件 BOM 在原生文件层处理。
export type EditorMode = 'live' | 'source'
export type Selection = { anchor: number; head: number }
export type OutlineEntry = { level: number; title: string; from: number; id?: string }
export type Presentation = { focus: boolean; typewriter: boolean; spellcheck: boolean; readonly?: boolean }
export type EditorFormat = 'bold' | 'italic' | 'strike' | 'underline' | 'highlight' | 'subscript' | 'superscript' | 'inline-code' | 'link' | 'image'
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
export type Appearance = 'light' | 'dark'
export type TitlebarMaterial = 'frosted' | 'liquid'
export type TitlebarView = { material: TitlebarMaterial; liquidAvailable: boolean }
export type Theme = { id: string; name: string; styles: string[]; swatch?: { paper: string; ink: string } }
export type SidebarTab = 'files' | 'outline' | 'search'
export type DocumentWidth = 'default' | 'wide' | 'extra-wide' | 'full'
export type WorkspaceEntry = { path: string; name: string; children?: WorkspaceEntry[] }
export type SearchResult = { path: string; name: string; line: number; preview: string }
export type FindQuery = { text: string; replacement: string; regex: boolean; matchCase: boolean; wholeWord: boolean }
export type AiIntent = 'chat' | 'outline' | 'draft' | 'continue' | 'rewrite' | 'expand' | 'condense' | 'polish' | 'summary' | 'actions' | 'translate' | 'proofread'
export type AiPrompts = Partial<Record<AiIntent, string>>
export type AiSkill = { name: string; label?: string; description: string; instructions: string; builtIn?: true }
export type AiScope = 'selection' | 'paragraph' | 'document' | 'files'
export type AiProtocol = 'chat' | 'anthropic' | 'responses'
export type AiReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type AiSelection = { providerId: string; model: string; reasoningEffort?: AiReasoningEffort }
export type AiModelMetadata = {
  displayName?: string; inputTokens?: number; outputTokens?: number; contextTokens?: number; reasoningEfforts?: AiReasoningEffort[];
  inputModalities?: string[]
}
export type AiModelOptions = {
  displayName?: string; inputTokens?: number; outputTokens?: number; reasoningEffort?: AiReasoningEffort; imageInput?: boolean; detected?: AiModelMetadata
}
export type AiDiscoveredModel = { id: string; metadata: AiModelMetadata }
export type AiProviderDraft = {
  id: string; name: string; endpoint: string; protocol: AiProtocol; models: string[]; modelOptions?: Record<string, AiModelOptions>
}
export type AiModelDiscovery = Pick<AiProviderDraft, 'id' | 'endpoint' | 'protocol'> & { key?: string }
export type AiProvider = AiProviderDraft & { hasKey: boolean; legacyKey?: boolean }
export type AiSettings = { providers: AiProvider[]; active: AiSelection | null; notice?: string }
export type AiContext = { scope: AiScope; label: string; text: string }
export type AiInputFile = { name: string; mediaType: string; data: string }
export type AiAttachment = { id: string } & ({ kind: 'text'; name: string; text: string } | ({ kind: 'binary' } & AiInputFile))
export type AiUsage = { cachedTokens?: number; inputTokens?: number }
export type AiMessage = {
  role: 'user' | 'assistant'; text: string; reasoning?: string; agentTrace?: AiAgentEntry[]; skill?: string;
  attachments?: string[]; usage?: AiUsage[]; usageModel?: string
}
export type AiAgentStep = { title: string; detail: string; failed?: boolean; plan?: AiAgentPlanItem[] }
export type AiAgentPlanItem = { step: string; status: 'pending' | 'in_progress' | 'completed' }
export type AiAgentEntry = { kind: 'reasoning' | 'text'; text: string } | ({ kind: 'tool' } & AiAgentStep)
export type AiAgentApprovalMode = 'auto' | 'ask'
export type AiAgentApproval = { id: string; round: number; tools: { title: string; detail: string; markdown?: string }[] }
export type AiAgentActivity = {
  round: number; trace: AiAgentEntry[]; approval?: AiAgentApproval;
  status: 'running' | 'complete' | 'cancelled' | 'failed'
}
export type AiConversations = {
  active: string | null; items: { id: string; title: string; count: number }[];
  covered: number; canCompress: boolean; summary?: { text: string; originalCharacters: number }
}
export type DiffPart = { kind: 'keep' | 'add' | 'remove'; text: string; hunk?: number }
export type Suggestion = { id: string; title: string; parts: DiffPart[]; hunks: number; source: 'ai' | 'mcp' | 'plugin' }
export type AiView = {
  settings: AiSettings; prompts: AiPrompts; context: AiContext | null; messages: AiMessage[]; stream: string;
  pending: boolean; error: string; suggestion: Suggestion | null; canRetry: boolean; agent?: AiAgentActivity;
  conversations?: AiConversations; compacting?: boolean; canRegenerate?: boolean; reasoning?: string; agentApprovalMode?: AiAgentApprovalMode
  skills?: AiSkill[]
  attachments?: AiAttachment[]
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
type PluginScope = 'selection' | 'document'
export type PluginInfo = {
  id: string; name: string; version: string; enabled: boolean;
  commands: { id: string; label: string; scope?: PluginScope; workflow?: 'files' | 'images' | 'mcp' }[]
}
export type MarketPlugin = {
  id: string; name: string; version: string; apiVersion: number; sha256: string;
  description: string; author: string; license: string; installedVersion: string | null;
  availability: 'install' | 'update' | 'installed' | 'incompatible'
}
export type PluginCatalog = { name: string; source: string | null; plugins: MarketPlugin[] }
export type PluginMarketPort = {
  official: string
  source(): string
  bundled(): Promise<PluginCatalog>
  load(source?: string, refresh?: boolean): Promise<PluginCatalog>
  install(source: string | null, plugin: MarketPlugin): Promise<PluginCatalog>
}
export type ShellAction =
  | { type: 'new' | 'open' | 'open-folder' | 'save' | 'save-as' | 'reload' | 'print' | 'import' | 'theme-import' | 'undo' | 'redo' | 'export-again' | 'copy-markdown' | 'copy-html' | 'paste-plain' | 'reopen' }
  | { type: 'markdown-default' }
  | { type: 'check-update' }
  | { type: 'open-path'; path: string; line?: number }
  | { type: 'mode'; mode: EditorMode }
  | { type: 'document-width'; width: DocumentWidth }
  | { type: 'titlebar-zoom' }
  | { type: 'theme'; id: string }
  | { type: 'theme-import-typora' }
  | { type: 'typora-config-import' }
  | { type: 'export'; format: ExportFormat }
  | { type: 'outline'; from: number }
  | { type: 'search-workspace'; text: string; regex: boolean }
  | { type: 'format'; format: EditorFormat }
  | { type: 'presentation'; value: Presentation }
  | { type: 'find'; query: FindQuery; operation: 'next' | 'previous' | 'replace' | 'replace-all' }
  | { type: 'workspace-filter'; option: 'hidden' | 'all' | 'glob' }
  | { type: 'window-view'; operation: 'fullscreen' | 'zoom-in' | 'zoom-out' | 'zoom-default' }
  | { type: 'titlebar-material'; material: TitlebarMaterial }
  | { type: 'workspace-create'; parent: string; name: string; folder: boolean }
  | { type: 'workspace-rename'; path: string; name: string }
  | { type: 'workspace-trash'; path: string }
  | { type: 'image-import'; files?: File[] }
  | { type: 'images'; mode: ImageMode }
  | { type: 'ai-provider-save'; provider: AiProviderDraft; key?: string }
  | { type: 'ai-provider-remove'; id: string }
  | { type: 'ai-key-migrate'; id: string }
  | { type: 'ai-model-select'; selection: AiSelection; updateEffort?: boolean }
  | { type: 'ai-agent-approval-mode'; mode: AiAgentApprovalMode }
  | { type: 'ai-agent-approval'; id: string; allow: boolean }
  | { type: 'ai-prompts'; prompts: AiPrompts }
  | { type: 'ai-skill-import' }
  | { type: 'ai-skill-remove'; name: string }
  | { type: 'ai-context'; scope: AiScope }
  | { type: 'ai-context-clear' }
  | { type: 'ai-model-detect' }
  | { type: 'ai-attach'; paths?: string[]; images?: File[] }
  | { type: 'ai-attachment-remove'; id: string }
  | { type: 'ai-send'; intent: AiIntent; prompt: string; agent?: boolean; skill?: string }
  | { type: 'ai-insert-reply'; message: AiMessage }
  | { type: 'ai-chat-new' | 'ai-compress' }
  | { type: 'ai-chat-select' | 'ai-chat-remove'; id: string }
  | { type: 'ai-chat-rename'; id: string; title: string }
  | { type: 'ai-cancel' | 'ai-retry' | 'ai-clear' }
  | { type: 'suggestion-apply'; id: string; hunks: number[] }
  | { type: 'suggestion-dismiss'; id: string }
  | { type: 'plugin-install' }
  | { type: 'plugin-enabled'; id: string; enabled: boolean }
  | { type: 'plugin-remove'; id: string }
  | { type: 'plugin-run'; id: string; command: string; scope: PluginScope }
  | { type: 'mcp-config'; server: McpServer }
  | { type: 'mcp-remove' | 'mcp-connect' | 'mcp-disconnect'; id: string }
  | { type: 'mcp-call'; id: string; item: McpItem; args: Record<string, unknown> }
  | { type: 'mcp-authorize'; allow: boolean }
  | { type: 'mcp-next' }
  | { type: 'autosave'; enabled: boolean }
  | { type: 'animations'; enabled: boolean }
  | { type: 'sidebar-resize'; side: SidebarSide; width: number }
export type SidebarSide = 'left' | 'right'
export type SidebarWidths = Partial<Record<SidebarSide, number>>
export type ShellState = {
  title: string; path: string | null; dirty: boolean; mode: EditorMode;
  detail: string; words: number; characters: number; line: number; column: number;
  workspace: string | null; autosave: boolean; presentation: Presentation
  animations?: boolean
  documentWidth?: DocumentWidth
  workspaceFilter?: { hidden: boolean; all: boolean; glob: string }
}
export type ShellActions = {
  dispatch: (action: ShellAction) => void | Promise<string | void>
  listAiModels?: (request: AiModelDiscovery) => Promise<AiDiscoveredModel[]>
  pluginMarket?: PluginMarketPort
  onWindowAppearance?: (appearance: Appearance | null) => void
  macTitlebar?: boolean
}
export interface Shell {
  editorHost: HTMLElement
  setState(state: ShellState): void
  setOutline(outline: OutlineEntry[]): void
  setWorkspace(entries: WorkspaceEntry[]): void
  setSearchResults(results: SearchResult[]): void
  setThemes(themes: Theme[], active: string, localThemes?: Theme[]): void
  importShortcutBindings(bindings: Readonly<Record<string, string>>): { applied: number; conflicts: number }
  setSidebarTab(tab: SidebarTab): void
  setSidebarWidths(widths: SidebarWidths): void
  setFindOptions(options: Pick<FindQuery, 'matchCase' | 'wholeWord'>): void
  getAppearance(): Appearance
  setTitlebar(view: TitlebarView): void
  setAI(view: AiView): void
  setPlugins(plugins: PluginInfo[]): void
  setMcp(view: McpView): void
  destroy(): void
}
