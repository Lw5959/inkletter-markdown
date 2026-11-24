# 页屿

页屿是原创桌面 Markdown 编辑器，支持 macOS、Windows 和 Linux。文档保存在普通 `.md` 文件中，实时视图和源码视图共用文本和撤销记录。默认主题使用系统字体与黑白灰配色，随系统切换明暗。选择深色主题后，整个窗口会同步变暗。打开、编辑、保存、主题与文件管理可以离线使用。

## 使用

1. 在文件菜单打开 Markdown 文件，或选择文件夹来使用文件树、快速打开和跨文件检索。
2. 用顶栏的「实时」「源码」切换视图。macOS 可用 `⌘/`，Windows、Linux 可用 `Ctrl+/`。
3. 导入 Typora 主题时，选择主题 CSS 主文件。它旁边的字体、图片、子目录、`base.user.css` 和主题同名覆盖文件按引用导入。
4. 文件菜单可导出 HTML、PDF、PNG 和常见办公文档。PDF 与 PNG 使用本机的 Chrome、Chromium 或 Edge。DOCX、EPUB、ODT、LaTeX 等需要安装 Pandoc。

PDF 与 PNG 导出可用 `YEYU_CHROME` 指定浏览器可执行文件。如果程序找不到 Pandoc，可用 `YEYU_PANDOC` 指定其可执行文件后重新启动页屿。两个环境变量均可省略。

## AI 写作

在 AI 侧栏填写 OpenAI 兼容的地址和模型。地址可填 `https://服务地址/v1` 或本机回环 HTTP 地址，例如 `http://127.0.0.1:8080/v1`。API 密钥保存到系统的 Keychain、Credential Manager 或 Secret Service。

改写前选择上下文并核对预览。结果生成后可选择应用整份建议或指定差异块，应用操作可以撤销。

## 双向 MCP

在 MCP 侧栏添加 stdio 命令及参数，或添加 Streamable HTTP 地址。连接成功后可以浏览服务提供的工具、资源和提示词，并在调用前确认发送的参数。

如果要让其他客户端访问当前工作区，在 MCP 侧栏授权该文件夹并复制生成的 stdio 配置。服务提供 `search_documents`、`read_document`、`current_selection` 和 `suggest_edit`。提交的建议会进入审阅队列，点击应用后可使用普通保存写入文件。[MCP 使用说明](docs/mcp.md)

## 从源码运行

需要 Node.js 24、pnpm 10、Rust 稳定版，以及目标平台的编译工具。

| 平台 | 开发依赖 | 打包 |
|---|---|---|
| macOS | Xcode Command Line Tools | `pnpm tauri build --bundles dmg` |
| Windows | MSVC C++ 构建工具、WebView2 Runtime | `pnpm tauri build --bundles nsis` |
| Linux | GTK 3、WebKitGTK 4.1 开发包、CMake、pkg-config | `pnpm tauri build --bundles deb,appimage` |

```sh
pnpm install --frozen-lockfile
pnpm tauri dev
pnpm test
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

[功能对照表](docs/feature-matrix.md) · [架构与文件归属](docs/architecture.md) · [性能和验收](docs/verification.md) · [三平台打包配置](.github/workflows/desktop.yml)
