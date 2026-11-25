# 页屿

页屿是原创桌面 Markdown 编辑器，支持 macOS、Windows 和 Linux。文档保存在普通 `.md` 文件中，实时视图和源码视图共用文本和撤销记录。默认主题使用系统字体与黑白灰配色，随系统切换明暗。选择深色主题后，整个窗口会同步变暗。打开、编辑、保存、主题与文件管理可以离线使用。

## 使用

1. 在文件菜单打开 Markdown 文件，或选择文件夹来使用文件树、快速打开和跨文件检索。
2. 用顶栏的「实时」「源码」切换视图。macOS 可用 `⌘/`，Windows、Linux 可用 `Ctrl+/`。
3. 从顶栏主题菜单选择默认、白纸、青瓷、石墨或松夜。白纸是纯白底的衬线主题。用「导入本机 Typora 主题」批量加入已安装的主题，也可以用「导入主题 CSS…」选择主文件。主题引用的相对字体、图片、子目录以及 `base.user.css` 和同名覆盖样式一并导入。
4. 文件菜单可导出 HTML、PDF、PNG 和常见办公文档。PDF 与 PNG 使用本机的 Chrome、Chromium 或 Edge。DOCX、EPUB、ODT、LaTeX 等需要安装 Pandoc。

PDF 与 PNG 导出可用 `YEYU_CHROME` 指定浏览器可执行文件。如果程序找不到 Pandoc，可用 `YEYU_PANDOC` 指定其可执行文件后重新启动页屿。两个环境变量均可省略。

## AI 写作

在 AI 侧栏打开「模型配置」，选择 Chat Completions、Anthropic Messages 或 Responses，填写 API 地址和模型。支持远程 HTTPS 和本机回环 HTTP，例如 `http://127.0.0.1:8080/v1`。可以填 API 前缀或完整接口地址。API 密钥保存到系统的 Keychain、Credential Manager 或 Secret Service。

在「默认提示词」中可编辑九种操作的提示词，或恢复内置内容。改稿前从输入框旁添加上下文并核对全文预览。结果生成后可选择应用整份建议或指定差异块，应用操作可以撤销。

## 插件

在「编辑 → 插件管理」安装 `.yeyu-plugin.json` 包，启用后选择处理范围并运行命令。重装相同 ID 可更新插件，启用、停用、更新和卸载立即生效。示例插件可清理行尾空白，处理结果通过差异审阅应用。[插件包格式与示例](docs/plugins.md)

## macOS 标题栏

原生窗口按钮与页屿工具共用一行。在「视图 → 标题栏材质」切换毛玻璃和液态玻璃。液态玻璃需要 macOS 26 或更新，旧系统使用毛玻璃。Universal 安装包包含 Apple Silicon 和 Intel。Windows 和 Linux 使用平台原生标题栏。

## 双向 MCP

在 MCP 侧栏添加 stdio 命令及参数，或添加 Streamable HTTP 地址。连接成功后可以浏览服务提供的工具、资源和提示词，并在调用前确认发送的参数。

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
