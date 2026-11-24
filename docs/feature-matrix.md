# Typora 1.14.17 功能对照

以 [1.14.17 稳定版记录](https://typora.io/releases/stable)、[Markdown 参考](https://support.typora.io/Markdown-Reference/)、[文件管理](https://support.typora.io/File-Management/)、[快捷键](https://support.typora.io/Shortcut-Keys/)和[导出手册](https://support.typora.io/Export/)为基线。已安装的 Typora 1.8.10 可以辅助核对旧交互。1.14.17 新增项以发行记录和文档为证据。

| 功能 | 平台差异 | 页屿入口 | 验收 | 当前状态 |
|---|---|---|---|---|
| 打开、保存、实时和源码模式 | macOS ⌘，其余 Ctrl | 编辑器、文件命令 | 使用含中文、BOM、CRLF 的文件往返 | 基线 |
| GFM 扩展、图表、LaTeX | 同一语法，WebView 渲染有差异 | 编辑器 | 复合样本的实时视图、源码和导出 | 开发中 |
| 主题和用户覆盖样式 | 主题字体和资源的名称大小写随文件系统 | 主题 | 验证本地字体及层叠顺序 | 基线 |
| PDF、HTML、图片、Pandoc | 打印与外部程序因平台而异 | 导出 | 检查文件文本、版式和主题 | 开发中 |
| 文件管理、查找、视图、快捷键 | 系统目录和键位差异 | 工作区、视图 | 使用键盘与专注模式完成跨文件编辑 | 开发中 |
| 崩溃恢复和外部改动 | 同步盘和原子替换语义需覆盖 | 保存与恢复 | 断开应用后恢复草稿，模拟外部改写 | 开发中 |

## Typora 2 beta 后续里程碑

跟踪主题包与扩展管理、模板与片段、编辑历史、云同步与发布、分屏和标签页。核对 [Typora 2 Beta 发行记录](https://docs.typora.io/changelogs)及对应用户手册。页屿的 AI 和双向 MCP 在当前范围内。
