# 应用结构

- `src/contracts.ts` 声明编辑器、界面和应用协调层的公共接口。统一的 `ShellAction` 将用户操作交给应用层。
- `src/editor/index.ts` 导出 `createEditor(host, options)` 和异步 `renderMarkdown(markdown, options?)`。文本与选择位置以 BOM 之外的原文为准。大纲建议按文档更新节流读取，切换模式应保留同一编辑状态。
- `src/ui/index.ts` 导出 `mountShell(root, actions)`。界面通过 `shell.editorHost` 暴露可编辑的挂载点，保留 `#write` 和 `.document-theme` 文档样式作用域。主题、AI 差异和 MCP 由协调层推送结构化状态。窗口级快捷键由界面层统一管理。
- `src/main.ts` 协调文件、编辑状态和视图。它在防抖后取原文、选区和大纲。原生命令位于 `src-tauri/src/`。
- Tauri 只向应用界面开放对话框和本项目注册的命令。导出的标记经过编辑器渲染，导入主题资源由原生层解析。
