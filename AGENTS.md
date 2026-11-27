# 墨笺 Markdown 编辑器

- 正式根目录为本仓库。桌面运行用 `pnpm tauri dev`，前端检查用 `pnpm check`，测试用 `pnpm test`，发布构建用 `pnpm tauri build`。
- `src/editor/` 维护 Markdown 文档模型、编辑器视图、渲染和编辑器样式。`src/ui/` 维护桌面界面与交互。`src/contracts.ts` 维护两者边界，`src/main.ts` 与 `src-tauri/` 维护应用协调及原生能力。
- Markdown 文本是文档状态的唯一来源，BOM 由文件层处理。编辑接口使用含原始换行字符的 UTF-16 偏移。切换视图沿用同一个撤销栈。
- 离线功能不得依赖 CDN。用户导入的 CSS 作用于文档区域。窗口外观跟随当前主题，应用外壳使用自己的布局。按任务补齐功能对照和验证结果。
