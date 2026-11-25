# 页屿

页屿是原创桌面 Markdown 编辑器，支持 macOS、Windows 和 Linux。文档保存在普通 `.md` 文件中，实时视图和源码视图共用文本和撤销记录。默认主题使用系统字体与黑白灰配色，随系统切换明暗。切换主题时，文档、标题栏、文件侧栏、AI、MCP 和应用内设置页会同步换色。打开、编辑、保存、主题与文件管理可以离线使用。

## 使用

1. 在文件菜单打开 Markdown 文件，或选择文件夹来使用文件树、快速打开和跨文件检索。
2. 用顶栏的「实时」「源码」切换视图。macOS 可用 `⌘/`，Windows、Linux 可用 `Ctrl+/`。
3. 从「视图 → 文档主题」选择默认、白纸、青瓷、石墨、松夜或本机 Typora 的主题。白纸是纯白底的衬线主题。本机款式首次选择时保存一份可离线使用的副本，也可以用「导入本机 Typora 主题」一次导入，或用「导入主题 CSS…」选择主文件。相对字体、图片、子目录以及 `base.user.css` 和同名覆盖样式一并导入。
4. 文件菜单可导出 HTML、PDF、PNG 和常见办公文档。PDF 与 PNG 使用本机的 Chrome、Chromium 或 Edge。DOCX、EPUB、ODT、LaTeX 等需要安装 Pandoc。

PDF 与 PNG 导出可用 `YEYU_CHROME` 指定浏览器可执行文件。如果程序找不到 Pandoc，可用 `YEYU_PANDOC` 指定其可执行文件后重新启动页屿。两个环境变量均可省略。

## 从 Typora 迁移

在「编辑 → 导入 Typora 配置…」预览并应用本机偏好，或选择 Typora 的 plist、JSON 或 JSONC 文件。可迁移当前主题、图床、支持的快捷键、自动保存与等待时间、拼写检查、侧栏标签和查找偏好。发生快捷键冲突时保留页屿已有键位。

使用 PicGo 或 PicList 时，启用其本机上传服务，然后从「格式 → 图片资源策略 → 按配置上传图片」上传文档中的图片。页屿把文件路径交给图床服务并写入返回的图片链接。自定义 HTTP 上传接口也可导入。iPic、自定义脚本及第三方图床的凭据暂待适配。[Typora 图床说明](https://support.typora.io/Upload-Image/) · [PicGo 本机接口](https://docs.picgo.app/gui/guide/advance)

## AI 写作

在 AI 侧栏打开「模型配置」，选择 Chat Completions、Anthropic Messages 或 Responses，填写 API 地址和模型。支持远程 HTTPS 和本机回环 HTTP，例如 `http://127.0.0.1:8080/v1`。可以填 API 前缀或完整接口地址。API 密钥保存到系统的 Keychain、Credential Manager 或 Secret Service。

在「默认提示词」中可编辑九种操作的提示词，或恢复内置内容。改稿前从输入框旁添加上下文并核对全文预览。结果生成后可选择应用整份建议或指定差异块，应用操作可以撤销。

## Markdown 默认打开方式

安装后打开「文件 → 设为 Markdown 默认打开方式」。macOS 12 及以上由系统弹窗确认，较早版本可按应用提示在 Finder 设置。Windows 会打开「默认应用」，将 `.md` 和 `.markdown` 都选择为 Yeyu。Linux 从已安装的桌面入口设置 `text/markdown`。

## 插件

从「编辑 → 插件市场」打开官方市场。切换到「内置插件」即可离线安装九款插件，包括批量格式化、图片整理、表格排版、表格转换、中文排版和文档目录。市场右上角可刷新目录或填写其他市场源。[官方插件市场](https://lw5959.github.io/yeyu-plugin-market/)

在「已安装」启用插件后，从「编辑 → 运行插件」执行命令。修改可逐段审阅、应用和撤销。JavaScript 模块与 Rust 编译的 WebAssembly 都使用 `.yeyu-plugin.json` 包，可以从文件安装。安装、启用、更新、停用和卸载即时生效。[插件开发指南](docs/plugins.md) · [搭建和发布市场目录](docs/plugin-market.md)

## macOS 标题栏

原生窗口按钮与页屿工具共用一行。在「视图 → 标题栏材质」切换毛玻璃和液态玻璃。液态玻璃需要 macOS 26 或更新，旧系统使用毛玻璃。Universal 安装包包含 Apple Silicon 和 Intel。Windows 和 Linux 使用平台原生标题栏。

## 双向 MCP

从「视图 → 协作侧栏 → MCP 工具与连接」打开 MCP 侧栏，添加 stdio 命令及参数，或添加 Streamable HTTP 地址。连接成功后可以浏览服务提供的工具、资源和提示词，并在调用前确认发送的参数。

如果要让其他客户端访问当前工作区，在 MCP 侧栏授权该文件夹并复制生成的 stdio 配置。服务提供 `search_documents`、`read_document`、`current_selection` 和 `suggest_edit`。提交的建议会进入审阅队列，点击应用后可使用普通保存写入文件。[MCP 使用说明](docs/mcp.md)

## 从源码运行

需要 Node.js 24、pnpm 10、Rust 稳定版，以及目标平台的编译工具。

| 平台 | 开发依赖 | 打包 |
|---|---|---|
| macOS | Xcode Command Line Tools，Rust 的 `aarch64-apple-darwin` 和 `x86_64-apple-darwin` 目标 | `pnpm tauri build --target universal-apple-darwin --bundles dmg` |
| Windows | MSVC C++ 构建工具、WebView2 Runtime | `pnpm tauri build --bundles nsis` |
| Linux | GTK 3、WebKitGTK 4.1 开发包、CMake、pkg-config | `pnpm tauri build --bundles deb,appimage` |

```sh
pnpm install --frozen-lockfile
pnpm tauri dev
pnpm test
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

[功能对照表](docs/feature-matrix.md) · [架构与文件归属](docs/architecture.md) · [性能和验收](docs/verification.md) · [三平台打包配置](.github/workflows/desktop.yml)
