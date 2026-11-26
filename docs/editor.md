# 编辑器核心

`createEditor(host, options)` 挂载一份 CodeMirror 6 编辑状态。界面将文档容器放在 `.document-theme` 内，编辑器挂载点使用 `#write`。窗口滚动由外层文档容器管理。实时模式根据可见范围装饰、请求重算和加载预览，源码模式使用同一个状态及历史。

| 功能 | 实现 |
| --- | --- |
| 打开、保存和编辑 | `setMarkdown` 打开文档并重置历史。原文和接口偏移使用 UTF-16，区分 CRLF、LF 和 CR，保留终止换行。光标停在 CRLF 内时，视图把它显示在行尾。 |
| 剪贴板 | 复制和剪切提供纯文本及用于保留精确换行的应用剪贴板格式，粘贴优先读取应用格式。外部应用和系统可能规范化纯文本换行。文件由 `onAssetPaste` 依次交给应用层处理。 |
| 实时 Markdown | 支持 ATX/Setext 标题、粗斜体、删除线、下划线、引用、列表、任务、表格、代码、图片、脚注标记、YAML 首部和可跳转目录。光标和选区移动时继续渲染语法。点击单元格可直接编辑内容，写入沿用原文分列和撤销栈。引用与普通代码块可以在实时模式编辑文字。公式、图表、元数据及超出实时渲染上限的区块可进入源码模式编辑。 |
| 链接和图片 | 实时模式用 ⌘/Ctrl + 点击打开普通直链或自动链接。文档锚点按大纲定位。图片解析和外部打开由应用层回调处理。引用式链接由 HTML 导出解析。 |
| 图表和公式 | KaTeX 输出 MathML。Mermaid 和旧式 `sequence`、`flowchart` 由浏览器本地渲染。旧格式支持常见消息、节点、连线和条件分支。主题、样式和位置参数仅支持可转换的子集。遇到未知语法、受限配置或解析错误时保留源码。 |
| 展示和格式 | 格式菜单覆盖 `EditorFormat`。专注模式淡化非活动行，打字机模式尝试将光标居中，文档边界受滚动范围限制。拼写词典由系统提供。只读模式允许选取和复制，禁用文字和任务修改。 |
| HTML 导出 | `renderMarkdown(markdown, options?)` 异步返回清理后的 HTML。Markdown 中的原始 HTML 作为文本显示，允许数值表示所需的 MathML 和受限的图表 SVG，`<u>` 可用于下划线。离线代码、语法、数学和图表都来自本地依赖，远程图片由源文件和应用解析决定。 |

CodeMirror 语言数据、Markdown-it、脚注插件、TeXMath、KaTeX、Mermaid 和 sanitize-html 使用 MIT 许可，Highlight.js 使用 BSD-3-Clause，任务列表插件使用 ISC。

## 验证

- `pnpm check`、`pnpm test`、`pnpm build`
- `node tests/editor-browser.mjs` 使用本机 Chrome，可用 `YEYU_CHROME` 指定路径。脚本验证混合换行替换及撤销、剪贴板、主题选择器、任务、目录跳转后继续输入、表格渲染与单元格编辑、图表、中文 composition 和长文档。
- 安装 Playwright WebKit 后运行 `node tests/editor-browser.mjs --webkit`。WebKit 使用同一组 DOM 操作。中文 composition 通过 Chrome CDP 合成协议执行，系统输入法与 Tauri 的原生 WKWebView 需在桌面联调时验证。
