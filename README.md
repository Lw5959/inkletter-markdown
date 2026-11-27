# 页屿

页屿是原创 Markdown 编辑器，支持 macOS、Windows、Linux，另提供 Android 预览版。文档保存在普通 `.md` 文件中，实时视图和源码视图共用文本和撤销记录。默认主题使用系统字体与黑白灰配色，随系统切换明暗。桌面端的文档、标题栏、文件侧栏、AI、MCP 和设置页会随主题换色。编辑、打开和保存可以离线使用。[GitHub Releases](https://github.com/Lw5959/yeyu/releases)

## 使用

1. 桌面端从「文件 → 打开文件…」可一次选择多份 Markdown 或 TXT。不同文件各有一个窗口，重复打开同一文件会聚焦已有窗口。左、右侧栏显示在各自的文档窗口。macOS 也可从 Finder 的「打开方式」选页屿，首份文件会使用空白启动窗口。打开文件夹后可用文件树、快速打开和跨文件检索。
2. 「实时」视图在输入、选中文本和大纲跳转时保持渲染，点击表格单元格即可修改。切换到「源码」可编辑完整的 Markdown。macOS 可用 `⌘/`，Windows、Linux 可用 `Ctrl+/`。
3. 从「视图 → 文档主题」选择默认、白纸、青瓷、石墨、松夜或本机 Typora 的主题。白纸是纯白底的衬线主题。本机款式首次选择时保存一份可离线使用的副本，也可以用「导入本机 Typora 主题」一次导入，或用「导入主题 CSS…」选择主文件。相对字体、图片、子目录以及 `base.user.css` 和同名覆盖样式一并导入。
4. 文件菜单可导出 HTML、PDF、PNG 和常见办公文档。PDF 与 PNG 使用本机的 Chrome、Chromium 或 Edge。DOCX、EPUB、ODT、LaTeX 等需要安装 Pandoc。

左右侧栏展开和收起时有过渡效果，菜单、弹窗和查找条也有动效。在「视图 → 界面动画」中可关闭，重启后保留设置。系统启用「减少动态效果」时，页屿会自动关闭这些动效。

拖动左右侧栏与正文之间的分隔线可调整宽度。键盘聚焦分隔线后可用左右方向键微调。每侧宽度单独保存，窗口变窄时会给正文保留可用空间。

「视图 → 正文宽度」可选主题默认、宽、超宽和铺满。桌面会记住所选档位，实时编辑和源码模式使用同一个设置。

关闭、退出或重载有未保存编辑的文档时，可以选择保存或继续编辑。选择「放弃更改」后，点「确认放弃」才会丢弃编辑。每个桌面文档窗口单独保存恢复草稿。

PDF 与 PNG 导出可用 `YEYU_CHROME` 指定浏览器可执行文件。如果程序找不到 Pandoc，可用 `YEYU_PANDOC` 指定其可执行文件后重新启动页屿。两个环境变量均可省略。

## Android

Android 提供 ARM64 APK。启动进入首页，文件入口纵向排列，下面是最近打开的文档。点「打开文件」进入系统文件选择器，也可以新建 Markdown、打开工作区或恢复草稿。首页和「更多操作 → 最近打开」可重开最近 12 份文档。文档被移动或授权失效时，可以重新选择文件或移出记录。保存由系统文档提供方授权，支持 UTF-8、BOM 和混合换行。只读文件可以另存副本。

工具栏的调色盘切换主题。底部提供实时／源码切换、大纲、查找替换和撤销重做。「更多操作」打开独立页面，可进入 Markdown 格式、阅读设置、字数统计、导出、AI、MCP、插件市场和软件更新。从这些页面点左上角或用系统返回会回到菜单，并保留菜单的滚动位置。授权文件夹后可筛选 Markdown 文件或检索正文。键盘出现时，编辑区会缩小并滚动到当前光标。文件选择和打印由 Android 系统界面处理。

打开和返回页面时有滑动过渡。Android 14 及以上使用手势导航时，从屏幕边缘向内滑可以预览上一页，取消手势后回到当前页。在首页返回时由系统处理。选择「更多操作 → 界面动画」可关闭页屿的动效，页屿也会遵循系统的减少动态效果设置。[Android 预测返回](https://developer.android.com/guide/navigation/custom-back/support-animations-views)

AI 写作沿用桌面端的供应商、模型、提示词和差异审阅，API 密钥由 Android Keystore 保护。插件市场提供在线目录、内置离线安装，以及 JavaScript、Rust 插件运行。MCP 可通过 Streamable HTTP 连接、发现和调用工具、资源及提示词。移动端的 MCP 服务、Typora 设置迁移、相对图片整理和 Pandoc 格式仍待适配。

## 更新

桌面端从「帮助 → 检查更新…」打开更新窗口。macOS 系统菜单的「页屿 → 检查更新…」也可打开。Android 从「更多操作 → 检查更新」进入更新页面。勾选「启动时自动检查更新」后，页屿启动时检查一次，有新版时显示更新提示。该开关默认关闭并会记住选择。更新源可选「自动」「GitHub」或「Gitee」。下载进度在页屿中显示，安装包校验通过后才可安装。初次从 0.2.4 升级需要手动下载安装包。 [发布说明](docs/releases.md)

## 从 Typora 迁移

在「编辑 → 导入 Typora 配置…」预览并应用本机偏好，或选择 Typora 的 plist、JSON 或 JSONC 文件。可迁移当前主题、图床、支持的快捷键、自动保存与等待时间、拼写检查、侧栏标签和查找偏好。发生快捷键冲突时保留页屿已有键位。

使用 PicGo 或 PicList 时，启用其本机上传服务，然后从「格式 → 图片资源策略 → 按配置上传图片」上传文档中的图片。页屿把文件路径交给图床服务并写入返回的图片链接。自定义 HTTP 上传接口也可导入。iPic、自定义脚本及第三方图床的凭据暂待适配。[Typora 图床说明](https://support.typora.io/Upload-Image/) · [PicGo 本机接口](https://docs.picgo.app/gui/guide/advance)

## AI 写作

在 AI 侧栏打开「模型配置」，点击「添加供应商」。每个供应商有自己的 API 地址、协议和密钥，可添加多个模型 ID。协议支持 Chat Completions、Anthropic Messages 和 Responses。地址可填 HTTP 或 HTTPS 的服务根地址、API 前缀或完整接口地址。macOS 使用页屿自己的加密密钥库。已有钥匙串密钥可点「迁移旧密钥」，系统可能在这一步要求授权，也可直接重新填写密钥。Windows、Linux 和 Android 使用各平台的凭据存储。HTTP 会明文传输密钥及请求内容。已有单模型配置会自动显示为一个供应商。

使用 OpenCode Go 时，API 地址可填 `https://opencode.ai/inference/go`，再选择协议并填入 Go 所用的 Console API 密钥。页屿会随同一对话的生成、重试和智能体请求发送稳定的会话标识。OpenCode 工作区接入插件用于让 OpenCode 通过 MCP 读取文档和提交修改建议。 [OpenCode Go 接入说明](https://opencode.ai/docs/console/go/#where-can-i-use-it) · [OpenCode 工作区接入](examples/plugins/opencode.md)

填写供应商的地址和所需密钥后，点「获取模型」读取列表并更新已有模型的规格。可以按 ID 或显示名筛选，勾选后点「添加所选」。对部分只提供 ID 的直连服务，页屿用公开的 Models.dev 目录补充规格。供应商未提供模型列表时，可用「添加模型」手动配置。 [Models.dev 目录](https://github.com/anomalyco/models.dev)

保存后，在对话顶部的模型菜单选择供应商和模型。下次启动时沿用最后选择。切换供应商会切换到对应的会话，原供应商的对话保留在当前应用会话中。

每个模型可以单独填写 ID、显示名、输入和输出上限、思考强度及图片输入能力。API 请求使用模型 ID，菜单显示自定义名称、接口名称或 ID。手动填写的值优先。接口只给出总窗口时，输入预算按总窗口扣去输出额度估算。点模型旁的「上下文窗口」可查看预计已用、剩余输入容量和输出上限。供应商有返回用量时也会显示最近一次的实测输入。

在输入框点「添加文件或图片」，也可用 `/attach`、从剪贴板粘贴图片，或在桌面拖入侧栏。UTF-8 文本、Markdown、CSV 可展开预览，PNG、JPEG、WebP 和 GIF 显示缩略图。PDF 以及 Responses 下的 DOCX、XLSX、PPTX 由支持对应格式的模型服务读取。文件保留在当前对话的输入区供续问，可单独移除，历史记录保存附件名。首次遇到图片能力未知的模型时会尝试读取规格，发送前按当前模型和图片格式校验。

在模型菜单旁也能调整当前模型的思考强度。可用档位随模型和接口变化，默认档沿用供应商设置。各模型的设置在切换和重启后保留。调整强度后可以用新档位重新生成上一条回复。

在「默认提示词」中可以编辑或恢复十二种操作的内置内容，也可以预览当前写作模式下会发给模型的完整系统提示词。内置提示词按操作明确读者、输出范围、事实保留和 Markdown 格式。选择扩写、精简、润色、翻译等改稿操作时，添加当前文档的选区、段落或全文并核对预览。已选文字发生变化后，需要重新选取确认。

「提取待办」可从已添加的上下文或直接粘贴的材料生成 Markdown 清单。页屿会核对复选框、表格状态和完成或归档小节，沿用已写明的负责人和期限。没有明确未完成事项时会显示空结果。添加上下文后可在输入框填写筛选条件，模型只从核对后的候选事项中选择。

桌面和 Android 会渲染 AI 回复里的标题、列表、表格、代码、公式和链接。流式回复也会逐步排版，宽表和代码块可横向滚动。回复下方可以复制原始 Markdown，或预览插入到光标位置的差异。改稿与插入都可按差异块应用和撤销。重新生成成功后会替换上一条回复，等待时可以先输入下一条草稿。

模型接口返回思考文本或摘要时，生成中会显示「思考过程」，完成后可在对应回复里展开。复制与插入使用回复正文。

同一模型连续处理相同材料时，页屿沿用会话标识和请求中的公共前缀。模型服务返回缓存统计时，回复下方会显示命中 Token。压缩、改动材料或切换模型会改变可复用的前缀，实际命中由供应商决定。

在侧栏进入「对话管理」可新建、切换、重命名或删除对话。记录保存在本机，并按供应商和地址保留。可点「压缩上下文」或在输入框运行 `/compact`。当前模型把较早的消息和已有摘要合成新摘要，保留目标、决定、关键事实和待办。对话中可展开摘要，看覆盖条数和前后字符数。长会话会在发送前自动压缩。后续请求使用新摘要和最近消息，完整记录仍可翻阅。

在 AI 输入框输入 `/` 可打开命令菜单。可点击选项，也可用方向键和 Enter 执行。`/new` 新建对话，`/model` 切换模型，`/context` 添加上下文，`/attach` 添加附件，`/skills` 打开写作技能，`/help` 查看命令。

写作技能内置会议纪要、文档审阅、技术说明和周报整理。点「本轮使用」或运行 `/skill <名称>` 选用技能。输入写作要求，或添加材料后直接发送。技能库可预览、导入和移除 `SKILL.md`，重导入同名技能会更新内容。文件开头用 YAML 声明 `name`、`description`，下方写 Markdown 工作步骤。选用的技能沿用当前写作操作和工具审批。 [Agent Skills 格式](https://github.com/agentskills/agentskills/blob/main/docs/specification.mdx)

从输入框打开「智能体」，用自然语言提出需要多步完成的任务。智能体可对文字材料列计划、搜索关键词、查看大纲和按行读取，按工具实际读取的片段继续处理。图片和二进制文档随请求交给模型。思考、工具动作和回复按发生顺序出现在会话里，完成后可回看。改稿建议在当前文档预览范围内定位，新内容可建议插入光标处。审阅后选择应用，运行中可取消或按相同快照重试。[Codex CLI 轮次执行](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn.rs) · [上下文压缩实现](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs)

启用智能体后，可在输入框选择「自动审核」或「请求批准」。自动审核通过文档范围、行号和参数检查后执行工具。请求批准会列出当前一轮的工具、读取范围和建议预览，可批准、拒绝或取消。产生的改稿仍从差异审阅中应用。审批方式随应用设置保存。

智能体需要支持工具调用的模型，与「模型配置」中的 Chat Completions、Responses 和 Anthropic Messages 共用设置。每次任务最多执行八轮，自带工具查询这次选中的文档和选区。[OpenAI 工具调用](https://developers.openai.com/api/docs/guides/function-calling) · [Anthropic 工具调用](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)

## Markdown 默认打开方式

安装后打开「文件 → 设为 Markdown 默认打开方式」。macOS 12 及以上由系统弹窗确认，较早版本可按应用提示在 Finder 设置。Windows 会打开「默认应用」，将 `.md` 和 `.markdown` 都选择为页屿。Linux 从已安装的桌面入口设置 `text/markdown`。

## 插件

桌面从「编辑 → 插件市场」打开独立插件窗口，Android 从「更多操作 → 插件市场」进入。顶部可切换在线市场、内置插件和已安装插件。「内置插件」可离线安装批量格式化、图片整理、表格排版等插件。桌面还内置 OpenCode 工作区接入。市场可刷新目录或填写其他市场源。[官方插件市场](https://lw5959.github.io/yeyu-plugin-market/) · [OpenCode 使用说明](examples/plugins/opencode.md)

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
