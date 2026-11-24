# 页屿桌面界面设计说明

## 布局和默认主题

- 默认浅色使用白底、近黑正文和灰色控件。宽屏打开时显示左侧大纲，工作区打开后显示文件树。默认主题根据系统外观切换，也可从主题菜单恢复。
- 顶栏放置导航开关、文件菜单、当前文件名和实时/源码、主题、AI、MCP 入口。快捷键设置位于编辑菜单。
- 文档区使用系统字体。实时模式显示格式结果，光标进入表格、公式或代码块后可直接编辑原文。主题样式应用于文档区域，编辑、只读与导出共用基础排版。
- 底栏显示操作反馈、编辑状态和统计。空文档保持安静，右栏在需要时展开。

## 2. 模块划分（`src/ui/`）

| 文件 | 职责 |
|---|---|
| `src/ui/index.ts` | 公开入口 `mountShell(root, actions)`，协调状态推送、主题样式注入、拖放图片、全局快捷键分发与 `destroy()` 清理 |
| `src/ui/menus.ts` | 文件 / 编辑 / 格式 / 视图四套菜单，涵盖导出、编辑格式和图片策略及方向键/Esc 菜单导航 |
| `src/ui/left-panel.ts` | 工作区文件树（展开折叠、创建文件/文件夹、重命名、废纸篓确认）、大纲筛选跳转、跨文件检索（含正则切换） |
| `src/ui/find-bar.ts` | 浮动文内查找替换条（大小写、全词、正则、上一个/下一个、替换/全部替换，Esc 返回编辑器焦点） |
| `src/ui/ai-panel.ts` | AI 接口地址/模型/可选密钥配置、四类上下文切换与**全文无截断预览**、九类写作操作、流式会话、取消/重试、差异的全部与逐段审阅应用 |
| `src/ui/mcp-panel.ts` | MCP 本地 `stdio` / 远端 `http` 配置、连接状态管理、工具/资源/提示词浏览、**调用前参数预览与显式许可门控**、工作区授权、复制启动命令、打开待审建议 |
| `src/ui/dialogs.ts` | 焦点陷阱弹窗管理器：快速打开面板、快捷键录制设置、文件创建/重命名/废纸篓确认弹窗 |
| `src/ui/shortcuts.ts` | 跨平台（macOS `⌘` / 其余 `Ctrl`）快捷键注册表、冲突检测与 `localStorage`（`yeyu.shortcuts.v1`）持久化 |
| `src/ui/helpers.ts` | 文件树扁平化与模糊匹配、差异 hunk 分组、CLI 参数引号解析、JSON Schema 初始参数生成与剪贴板工具 |
| `src/ui/icons.ts` | 零外链纯本地内联 SVG 图标集 |
| `src/ui/shell.css` | 中性色界面与跨 WebView 样式隔离 |

## 3. 主题隔离与滚动容器行为

- 界面在 `document.head` 尾部维护独立的 `<style data-yeyu-theme="true">`，在 `setThemes(themes, active)` 时写入当前激活主题的 `styles.join('\n')`。
- 文档滚动容器从共享的 `src/editor/document.css` 读取默认底色与文字色。样式采用零优先级，导入主题可覆盖这些值。
- 所有界面外壳均使用 `.yy-shell .yy-chrome` 命名空间与 `--yy-*` 自定义属性，即使导入主题意外包含 `button`、`body` 等宽泛选择器也不会覆盖外壳样式。
- `setState` 会同步更新 `.yy-paper.document-theme` 的 `data-mode`、`data-focus`、`data-typewriter`、`data-spellcheck`、`data-readonly`、`data-editable` 和 `aria-readonly`，配合打字机模式底部留白及只读状态提示。

## 4. 键盘与焦点策略

- 窗口级快捷键由 `src/ui/index.ts` 统一监听并在 `destroy()` 时释放，不依赖 `src/main.ts` 的按键监听。
- 全面规避输入法组合期（`event.isComposing || event.keyCode === 229`）。
- 区分全局快捷键与 `editorOnly` 格式快捷键：当焦点位于 AI 输入框、MCP JSON 参数框、查找框或弹窗表单时，不会误触文档格式命令。
- 弹窗支持 `Tab`/`Shift+Tab` 焦点循环，`Escape` 关闭后恢复原焦点或回落到编辑器 `#write`；查找条与快速打开在确认/关闭后自动归还编辑器焦点。
- 全部快捷键支持在「快捷键设置」中实时录制、冲突提示、单条清除/重置与恢复默认，并持久化到 `localStorage`。

## 5. AI 与 MCP 安全交互约束

- **AI 上下文透明性**：切换 `selection` / `paragraph` / `document` / `files` 后，展示包含字符数和完整 `<pre>` 文本的上下文全文预览，支持展开/收起与一键清除。
- **AI/MCP 差异审阅**：按 `hunk` 分段展示增删变更，支持逐段「仅应用此段」、勾选组合「应用所选」、一键「全部应用」与「忽略」；当收到 `source: 'mcp'` 的新建议时自动切至差异审阅视图。
- **MCP 调用显式许可**：点击任何工具/资源/提示词不会直接执行，而是打开调用审阅卡，实时校验并展示即将发送的格式化 JSON 参数，必须显式勾选确认后才解锁「确认许可并调用」按钮并派发 `mcp-call`。
