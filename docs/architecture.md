# 应用结构

- `src/contracts.ts` 声明编辑器、界面和应用协调层的公共接口。统一的 `ShellAction` 将用户操作交给应用层。
- `src/editor/index.ts` 导出 `createEditor(host, options)` 和异步 `renderMarkdown(markdown, options?)`。文本与选择位置以 BOM 之外的原文为准。实时和源码使用同一 CodeMirror 状态。文档统计和全量大纲由 Worker 计算，实时排版装饰只处理视窗内的内容。
- `src/ui/index.ts` 导出 `mountShell(root, actions)`。界面通过 `shell.editorHost` 暴露可编辑的挂载点，保留 `#write` 和 `.document-theme` 文档样式作用域。主题、AI 差异和 MCP 由协调层推送结构化状态。窗口级快捷键由界面层统一管理。
- `src/main.ts` 协调文件、编辑状态和视图。它在防抖后读取原文和选区，并将统计任务发送给 Worker。原生命令位于 `src-tauri/src/`。
- Tauri 注册文件、导出、主题、AI 和 MCP 命令。导出与编辑区共享文档基础样式。主题资源经原生层读取，CSS 在协调层解析相对路径和作用域。
- `src/ui/plugin-market.ts` 展示在线市场、内置插件和安装状态。`src-tauri/src/plugins/market.rs` 核对下载包后复用插件安装记录和 Wasm 宿主。线上目录默认来自 GitHub Pages，内置安装直接读取安装包中的资源，因此在线请求挂起时仍可使用。`examples/plugins/` 提供示例包和源码。
