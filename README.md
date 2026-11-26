# 页屿

页屿是原创 Markdown 编辑器，支持 macOS、Windows、Linux，另提供 Android 预览版。文档保存在普通 `.md` 文件中，实时视图和源码视图共用文本和撤销记录。默认主题使用系统字体与黑白灰配色，随系统切换明暗。桌面端的文档、标题栏、文件侧栏、AI、MCP 和设置页会随主题换色。编辑、打开和保存可以离线使用。[GitHub Releases](https://github.com/Lw5959/yeyu/releases)

## 使用

1. 在文件菜单打开 Markdown 文件，或选择文件夹来使用文件树、快速打开和跨文件检索。
2. 用顶栏的「实时」「源码」切换视图。macOS 可用 `⌘/`，Windows、Linux 可用 `Ctrl+/`。
3. 从「视图 → 文档主题」选择默认、白纸、青瓷、石墨、松夜或本机 Typora 的主题。白纸是纯白底的衬线主题。本机款式首次选择时保存一份可离线使用的副本，也可以用「导入本机 Typora 主题」一次导入，或用「导入主题 CSS…」选择主文件。相对字体、图片、子目录以及 `base.user.css` 和同名覆盖样式一并导入。
4. 文件菜单可导出 HTML、PDF、PNG 和常见办公文档。PDF 与 PNG 使用本机的 Chrome、Chromium 或 Edge。DOCX、EPUB、ODT、LaTeX 等需要安装 Pandoc。

左右侧栏展开和收起时有过渡效果，菜单、弹窗和查找条也有动效。在「视图 → 界面动画」中可关闭，重启后保留设置。系统启用「减少动态效果」时，页屿会自动关闭这些动效。

PDF 与 PNG 导出可用 `YEYU_CHROME` 指定浏览器可执行文件。如果程序找不到 Pandoc，可用 `YEYU_PANDOC` 指定其可执行文件后重新启动页屿。两个环境变量均可省略。

## Android

Android 提供 ARM64 APK。启动进入首页，文件入口纵向排列，下面是最近打开的文档。点「打开文件」进入系统文件选择器，也可以新建 Markdown、打开工作区或恢复草稿。首页和「更多操作 → 最近打开」可重开最近 12 份文档。文档被移动或授权失效时，可以重新选择文件或移出记录。保存由系统文档提供方授权，支持 UTF-8、BOM 和混合换行。只读文件可以另存副本。

工具栏的调色盘切换主题。底部提供实时／源码切换、大纲、查找替换和撤销重做。「更多操作」打开独立页面，可进入 Markdown 格式、阅读设置、字数统计、导出、AI、MCP、插件市场和软件更新。授权文件夹后可筛选 Markdown 文件或检索正文。键盘出现时，编辑区会缩小并滚动到当前光标。页面左上角和系统返回均可回到上一层。文件选择和打印由 Android 系统界面处理。

打开和返回页面时有滑动过渡。Android 14 及以上使用手势导航时，从屏幕边缘向内滑可以预览上一页，取消手势后回到当前页。在首页返回时由系统处理。选择「更多操作 → 界面动画」可关闭页屿的动效，页屿也会遵循系统的减少动态效果设置。[Android 预测返回](https://developer.android.com/guide/navigation/custom-back/support-animations-views)

AI 写作沿用桌面端的供应商、模型、提示词和差异审阅，API 密钥由 Android Keystore 保护。插件市场提供在线目录、内置离线安装，以及 JavaScript、Rust 插件运行。MCP 可通过 Streamable HTTP 连接、发现和调用工具、资源及提示词。移动端的 MCP 服务、Typora 设置迁移、相对图片整理和 Pandoc 格式仍待适配。

## 更新

桌面端从「帮助 → 检查更新…」打开居中的更新窗口。macOS 系统菜单的「页屿 → 检查更新…」也可打开。Android 从「更多操作 → 检查更新」进入独立页面。更新界面显示当前版本、检查结果和发布说明。macOS、Windows 和 AppImage 显示下载进度并在安装前核对签名。Android 和 DEB 的下载进度可在浏览器或系统下载界面查看。初次从 0.2.4 升级需要手动下载安装包。[发布说明](docs/releases.md)

## 从 Typora 迁移

在「编辑 → 导入 Typora 配置…」预览并应用本机偏好，或选择 Typora 的 plist、JSON 或 JSONC 文件。可迁移当前主题、图床、支持的快捷键、自动保存与等待时间、拼写检查、侧栏标签和查找偏好。发生快捷键冲突时保留页屿已有键位。

使用 PicGo 或 PicList 时，启用其本机上传服务，然后从「格式 → 图片资源策略 → 按配置上传图片」上传文档中的图片。页屿把文件路径交给图床服务并写入返回的图片链接。自定义 HTTP 上传接口也可导入。iPic、自定义脚本及第三方图床的凭据暂待适配。[Typora 图床说明](https://support.typora.io/Upload-Image/) · [PicGo 本机接口](https://docs.picgo.app/gui/guide/advance)

## AI 写作

在 AI 侧栏打开「模型配置」，点击「添加供应商」。每个供应商有自己的 API 地址、协议和密钥，可添加多个模型 ID。协议支持 Chat Completions、Anthropic Messages 和 Responses。地址支持远程 HTTPS、本机回环 HTTP、API 前缀或完整接口地址。密钥保存到系统的 Keychain、Credential Manager 或 Secret Service。已有单模型配置会自动显示为一个供应商。

保存后，在对话顶部的模型菜单选择供应商和模型。下次启动时沿用最后选择。切换供应商会切换到对应的会话，原供应商的对话保留在当前应用会话中。

在「默认提示词」中可编辑九种操作的提示词，或恢复内置内容。改稿前从输入框旁添加上下文并核对全文预览。结果生成后可选择应用整份建议或指定差异块，应用操作可以撤销。

## Markdown 默认打开方式

安装后打开「文件 → 设为 Markdown 默认打开方式」。macOS 12 及以上由系统弹窗确认，较早版本可按应用提示在 Finder 设置。Windows 会打开「默认应用」，将 `.md` 和 `.markdown` 都选择为页屿。Linux 从已安装的桌面入口设置 `text/markdown`。

## 插件

桌面从「编辑 → 插件市场」进入，Android 从「更多操作 → 插件市场」进入。页面顶部可切换在线市场、内置插件和已安装插件。选择「内置插件」即可离线安装九款插件，包括批量格式化、图片整理、表格排版、表格转换、中文排版和文档目录。市场可刷新目录或填写其他市场源。[官方插件市场](https://lw5959.github.io/yeyu-plugin-market/)

在「已安装」启用插件后，从「编辑 → 运行插件」执行命令。修改可逐段审阅、应用和撤销。JavaScript 模块与 Rust 编译的 WebAssembly 都使用 `.yeyu-plugin.json` 包，可以从文件安装。安装、启用、更新、停用和卸载即时生效。[插件开发指南](docs/plugins.md) · [搭建和发布市场目录](docs/plugin-market.md)

## macOS 标题栏

原生窗口按钮与页屿工具共用一行。在「视图 → 标题栏材质」切换毛玻璃和液态玻璃。液态玻璃需要 macOS 26 或更新，旧系统使用毛玻璃。Apple Silicon 下载 `arm64.dmg`，Intel Mac 下载 `x64.dmg`。Windows 和 Linux 使用平台原生标题栏。

## 双向 MCP

从「视图 → 协作侧栏 → MCP 工具与连接」打开 MCP 侧栏，添加 stdio 命令及参数，或添加 Streamable HTTP 地址。连接成功后可以浏览服务提供的工具、资源和提示词，并在调用前确认发送的参数。

如果要让其他客户端访问当前工作区，在 MCP 侧栏授权该文件夹并复制生成的 stdio 配置。服务提供 `search_documents`、`read_document`、`current_selection` 和 `suggest_edit`。提交的建议会进入审阅队列，点击应用后可使用普通保存写入文件。[MCP 使用说明](docs/mcp.md)

## 从源码运行

需要 Node.js 24、pnpm 10、Rust 稳定版，以及目标平台的编译工具。

| 平台 | 开发依赖 | 打包 |
|---|---|---|
| macOS（Apple Silicon） | Xcode Command Line Tools，Rust 的 `aarch64-apple-darwin` 目标 | `pnpm tauri build --target aarch64-apple-darwin --bundles dmg` |
| macOS（Intel） | Xcode Command Line Tools，Rust 的 `x86_64-apple-darwin` 目标 | `pnpm tauri build --target x86_64-apple-darwin --bundles dmg` |
| Windows | MSVC C++ 构建工具、WebView2 Runtime | `pnpm tauri build --bundles nsis` |
| Linux | GTK 3、WebKitGTK 4.1 开发包、CMake、pkg-config | `pnpm tauri build --bundles deb,appimage` |
| Android ARM64 | JDK 21，Android SDK 37，NDK r28c，libclang，Rust 的 `aarch64-linux-android` 目标 | `pnpm tauri android build --apk --target aarch64 --debug` |

QuickJS 在 Android 构建时用 libclang 生成绑定。先将 `NDK_HOME` 指向 NDK r28c，再设置下列参数。Linux 使用 `linux-x86_64`，Windows 使用 `windows-x86_64`。

```sh
export BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android="--sysroot=$NDK_HOME/toolchains/llvm/prebuilt/darwin-x86_64/sysroot"
```

```sh
pnpm install --frozen-lockfile
pnpm tauri dev
pnpm test
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

[功能对照表](docs/feature-matrix.md) · [架构与文件归属](docs/architecture.md) · [性能和验收](docs/verification.md) · [本地打包与更新](docs/releases.md)

源码采用 [MIT 许可证](LICENSE)，第三方组件仍适用各自的许可条款。
