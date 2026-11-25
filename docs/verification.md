# 验收与性能

## 验收方法

- macOS 使用实际 Tauri/WKWebView 窗口。QA 构建使用独立应用标识和临时工作区，生产安装包不包含 QA 驱动。
- PDF/PNG 使用实际 Chromium 打印与截图能力，DOCX 往返使用 Pandoc 3.14。
- AI 流式测试使用本机 llama.cpp b12671 和 Qwen2.5-0.5B-Instruct Q4_K_M。通过模型配置页接通 Chat Completions、Anthropic Messages 和 Responses。保存改写提示词后，模型将选区中的 `wordy` 改为 `verbose`。验收覆盖差异应用、撤销及恢复默认提示词。
- MCP 使用官方 TypeScript SDK 作为外部 stdio 客户端，发现并调用搜索、读取、选区与建议。页屿还连接了独立 SDK 实现的 Streamable HTTP 端点并调用三类能力。
- 自动化验收在临时工作区模拟磁盘外部更新和异常退出。原始文件带 BOM、混合行尾、中文、Emoji、相对图片和未识别标记。
- 通过原生插件管理流程安装和启用示例 Wasm 模块，运行中替换版本，处理选区并审阅、应用与撤销，随后停用和卸载。
- macOS 原生窗体验证插件市场的离线浏览、搜索和三款内置插件安装，并通过任务清单验证选区、差异、应用与撤销。用实际构建脚本生成目录并通过回环 HTTP 提供。首份更新包的字节与摘要不一致时原版本继续可用，重试更新成功并沿用启用状态。市场源保存和切回内置目录均通过。
- 公网市场通过 GitHub Pages 发布。匿名请求目录和三个插件包均返回 HTTP 200，并通过 SHA-256 和包身份核对。macOS 0.2.1 原生 QA 首次打开即连接官方目录，完成下载和安装。在线目录请求挂起时仍可切换内置插件并完成安装。断网 Linux 桌面也通过主动切换与自动显示内置插件的安装测试，两次均保留官方源设置。[公网市场页面](https://lw5959.github.io/yeyu-plugin-market/) · [开源市场仓库](https://github.com/Lw5959/yeyu-plugin-market)
- macOS 的标题栏为 44 pt。在毛玻璃和液态玻璃下，关闭、最小化和缩放按钮的中心均距窗口顶部 22 pt。
- AI 输入框在 Chromium 中通过单行起步、多行展开、清空收回以及发送按钮状态验证。上下文选择和写作操作保留键盘导航。
- 查找、快速打开、下拉、状态及实时列表使用 SVG。浏览器检查验证了 SVG 节点、主题色和原有交互。
- Chromium 和 WebKit 验证了编辑区的 8 px 滚动条、4 px 可见滑块和透明轨道，明暗主题下均可用滚轮滚动。Chromium 另验证悬停加深和拖动滚动。

## 主题视觉回归

| 样本 | 核对结果 | 已知差异 |
|---|---|---|
| 默认 | 白底黑字，系统深色可覆盖整窗 | 界面布局及编辑标记使用页屿自己的样式 |
| Themeable Light 1.1.0 | 导入样式、标题、表格与 InterVariable 字体 | 部分规则依赖 Typora 专有文档结构 |
| Themeable Dark 1.1.0 | 深色文档、窗体与 AI 区域，InterVariable 字体可用，任务勾号对齐 | 已完成任务的实时编辑文字使用正文样式 |
| Dracula | 深色文档、侧栏和原生窗体 | 代码字体未在本轮样本中确认实际使用 |
| 相对资源夹具 | 子目录背景图片保持原路径，`base.user.css` 和同主题覆盖按顺序生效 | 夹具刻意使用角标背景图验证导出 |

[Themeable 源码](https://github.com/jhildenbiddle/typora-themeable) · [Dracula 源码](https://github.com/dracula/typora)

在本机 Typora 1.8.10 的主题目录，用固定样稿验证六套随附主题和两套已安装主题。Chromium 和 WebKit 都加载了八套 CSS 及其引用资源。实时视图与 HTML 导出中的同一条链接颜色、代码块底色均一致。Whitey 的正文容器占满编辑区可用宽度。Night 和 Vue Dark 会同时切换标题栏、侧栏和状态栏的明暗。

macOS 原生窗口在首次导入前从顶栏菜单发现八套本机主题。点击 Night 即应用并显示选中态，批量导入和重复导入沿用每套主题的 ID。八套主题均逐套切换并核对样稿正文，Night 和 Vue Dark 同时切换了原生窗口的明暗。带自定义 CSS、相对背景图和覆盖样式的样稿通过 HTML、PDF、PNG 和 DOCX 导出。

| 本机主题 | 核对的字体或样式 |
|---|---|
| GitHub、Gothic、Newsprint | Open Sans、TeX Gyre Adventor、PT Serif 的正文与粗体随主题加载。Gothic 的一个 Didact Gothic 备用字形范围在 macOS 原生窗口报字体加载错误 |
| Night、Vue Dark | 整窗暗色和主题任务框。Vue Dark 加载 Source Sans Pro 和 Roboto Mono |
| Pixyll、Vue | Pixyll 加载 Merriweather 和 Lato，Vue 加载 Source Sans Pro 和 Roboto Mono |
| Whitey | 正常正文宽度、标题分隔线及任务框。样本 CSS 依赖系统中的 Vollkorn 字体，未安装时由浏览器回退 |

Chromium 和 WebKit 用相同的样稿复查了本机八套主题和四套内置主题。实时标题的边框和内边距随标题行排版，Whitey 保留居中短线。水平线、引用、YAML、目录、表格和代码块沿用导出的语义标签与区块留白。点击引用可以编辑原文，切换源码后保留 CRLF 和 Markdown 标记。较大的区块和光标所在的区块会展开为可编辑行。针对旧版 CodeMirror 源码界面编写的选择器仍有兼容差异。测试使用本机 CSS 和字体，安装包只包含页屿自带主题。

### 整窗配色

Chromium 和 WebKit 通过青瓷、松夜的全窗回归。核对了文件树、跨文件检索、标题栏的半透明材质叠色、状态栏、AI 对话、模型设置、默认提示词、MCP 表单、快速打开、插件、快捷键和应用内输入弹窗。低对比度的导入主题使用其侧栏颜色，应用控件的文字和强调色经过对比度调整。切回默认后，浅色正文和侧栏恢复纯白。

macOS 原生窗口也核对了青瓷和松夜的标题栏、左右侧栏、状态栏及模型配置背景，并确认原生窗口明暗同步。

### 悬停、按下和选中

Chromium 和 WebKit 验证了默认浅色和深色、白纸、青瓷、石墨、松夜、本机八套 Typora 主题和一个相对资源夹具。每套测量恢复与放弃草稿、标题栏、文件树、状态栏、一级与二级菜单、AI 和 MCP 中的 14 个控件。普通或选中、悬停和按下时的文字或图标与背景对比度均达到 4.5:1，悬停和按下各有可见反馈。

窄窗口中用鼠标从一级菜单移入二级菜单，独立滚动并选择末尾导出选项。核对标题栏缩放时的左侧展开，以及键盘方向键和 Esc 的逐级导航。macOS 原生窗口验证了导出菜单侧展和强制退出后的草稿恢复，并确认恢复弹窗先聚焦「恢复草稿」。

### Typora 设置迁移

macOS 原生窗口读取本机 Typora 配置，预览并成功应用 Vue 主题、大纲侧栏和查找偏好。自动化用例覆盖 JSONC 注释、上传地址、macOS 菜单快捷键、键位互换和保留冲突键位。

本机测试服务核对了 PicGo 上传请求中的图片绝对路径和返回的 URL。真实图床账号联调待验收。[Typora 快捷键格式](https://support.typora.io/Shortcut-Keys/) · [PicGo 上传协议](https://docs.picgo.app/gui/guide/advance)

## 性能首轮

Apple M1 Pro，32 GB 内存，macOS 27.2.1。本地 APFS 外置 SSD 上运行发布配置，测试程序生成 1 MiB 和 10 MiB 固定文件，包含中英文、标题、表格、行内格式和混合换行。

| 指标 | 目标 | 首轮实测 |
|---|---:|---:|
| 进程启动到首个界面帧 | ≤ 2,000 ms | 615 ms |
| 读取 1 MiB 到编辑区新增帧 | ≤ 1,000 ms | 64 ms |
| 1 MiB 文档输入到下一帧 P95 | ≤ 32 ms | 19.0 ms，34 次 |
| 10 MiB 打开 | 可编辑 | 115 ms |
| 10 MiB 保存 | 可保存 | 107 ms |
| 编辑区首屏 DOM 行数（10 MiB） | 保持视窗级挂载 | 34 |
| 进程 RSS（启动 / 10 MiB 往返后） | 观察 | 113 / 200 MiB |

启动数据是一次新的进程启动，系统页面缓存未清空。输入以 Cocoa 文本输入回调和紧接的浏览器帧计时，包括 IPC 和下一帧等待。RSS 仅统计页屿主进程，WebKit 媒体/渲染进程另由系统管理。10 MiB 滚动到底，追加“十兆末尾”后保存并回读成功。

## 发布配置复测

在同一台 Apple M1 Pro 上用发布配置重复三次，构建源为 `3726ac6`。各次使用相同的 1 MiB 和 10 MiB 文档。每次输入 P95 取 34 次 Cocoa 输入样本。

| 指标 | 三次实测 |
|---|---:|
| 新进程启动到首帧 | 641–813 ms |
| 1 MiB 打开到首帧 | 69–71 ms |
| 1 MiB 输入到下一帧 P95 | 9–15 ms |
| 10 MiB 打开 / 末尾编辑后保存 | 113–125 ms / 114–116 ms |
| 10 MiB 首屏 DOM 行数 | 28 |
| 页屿主进程 RSS（启动 / 10 MiB 往返后） | 113–114 MiB / 202–204 MiB |

## 导出响应

Chrome 158 使用 `node tests/export-browser.mjs` 的固定样本，比较导出 Markdown 渲染前后的界面响应。PDF、PNG 和 HTML 共用这一阶段。窗口生成图表 SVG，Worker 完成净化。下表的耗时包含生成 HTML，PDF 和 PNG 的排版与写盘另计。

| 样本与指标 | 原实现 | Worker 实现 |
|---|---:|---:|
| 1 MiB 连续 5 次渲染，界面线程 ≥ 50 ms 的长任务 | 10 次，最长 254 ms | 0 次 |
| 1 MiB 热渲染耗时中位数 | 328 ms | 376 ms |
| 同一张本地图片在文档引用 8 次 | 读取 8 次，最长任务 136 ms | 读取 1 次，0 个长任务 |

两组样本的 HTML 与原实现逐字节一致。macOS 通过相对图片、主题 CSS、MathML 和 Mermaid 的 HTML、A4 PDF、PNG 导出检查。

## 平台验收范围

### Android 原生服务

- NDK r28c 下，`aarch64-linux-android` 目标的 `cargo check --lib` 和 `cargo build --lib` 通过，输出 AArch64 ELF 动态库。Android 的 rmcp 特性仅启用客户端及 Streamable HTTP。
- Keystore 凭据类通过 Android SDK 37.0、Tauri Android 2.12.7 和 Kotlin 2.3.21 的独立编译。Gradle 项目编译在下载 Kotlin Gradle 依赖时遇到 Maven TLS 握手失败。手机上的凭据读写、Android 面板和 APK 流程待验。

### 0.2.4

安装包与 SHA-256 校验文件位于 `release/0.2.4/`。应用源码为 `829fb56`，macOS 独立打包配置为 `81e69ea`。两个 DMG 分别装入单一架构的应用。

| 安装包 | 验收 |
|---|---|
| macOS Apple Silicon `arm64.dmg` | 只读挂载验证映像、`arm64` 二进制和临时签名。Apple M1 Pro 的原生 QA 窗口通过动效开关、模型切换、Cocoa 中文组合输入、文档往返、导出和草稿恢复 |
| macOS Intel `x64.dmg` | 只读挂载验证映像、`x86_64` 二进制和临时签名，在 Rosetta 下通过命令行启动检查。Intel 设备的桌面验收待完成 |
| Windows x64 NSIS | 交叉构建与安装档案校验通过。Windows 桌面验收待完成 |
| Linux ARM64 DEB | Debian 13 断网容器安装成功，在 Xvfb 桌面打开、编辑、保存并保留 BOM |

macOS 安装包尚未公证，Windows 安装包尚未签名。

- Chromium 的全套 30 项测试、Rust 的 15 项测试及 WebKit 的相关界面测试通过。侧栏双向过渡、菜单开关、系统减少动态效果和焦点恢复均已验证。分批检查默认明暗、四款内置、八款本机 Typora 主题和一个导入夹具的悬停、按下及选中态，受检文字样本最低对比度为 5.21:1。
- macOS 原生窗口从旧单模型配置迁移，在设置页添加供应商及模型并验证重启保留选择。Chat Completions 驱动本机 Qwen 改写选区，结果经差异审阅应用后可撤销。Anthropic Messages 和 Responses 通过独立的本机 SSE 夹具核对请求地址、模型 ID 和会话隔离。Responses 的测试密钥经过系统钥匙串，并核对配置文件没有密钥明文。
- 本机验证 HTML、PDF、PNG 和 DOCX 导出、DOCX 导回、MCP 双向调用、插件离线安装及外部改动冲突。动画关闭后侧栏即时展开和收起，强制退出后保留关闭状态。

用发布配置在 Apple M1 Pro、32 GB、macOS 27.2.1 上启动三个独立进程，沿用 1 MiB 和 10 MiB 固定样本。启动为 732–977 ms，打开 1 MiB 为 77–95 ms，输入到下一帧的 P95 为 18–26 ms。10 MiB 打开为 130–132 ms，滚动到底编辑后保存为 119–146 ms，首屏挂载 28 行。主进程 RSS 包括启动时的 114–120 MiB 和 10 MiB 往返后的 199–202 MiB。

### 0.2.3

安装包和 SHA-256 校验文件位于 `release/0.2.3/`，构建源为 `de3ef2b`。市场提交 `5e2f897` 包含九款插件。匿名下载核对了所有包的摘要、接口和版本，前一版六款的包和地址均保留。[公网目录](https://lw5959.github.io/yeyu-plugin-market/index.json) · [市场发布提交](https://github.com/Lw5959/yeyu-plugin-market/commit/5e2f897)

- macOS 原生 QA 从公网安装了三款新插件，并验证内置安装。批量格式化预览三份文件后只保存勾选且版本仍匹配的文件。打开中的文件同步，BOM 和混合行尾保留。
- 图片整理在确认前未复制资源，三类操作均通过，包括取消、应用和再次运行。两条相同内容的引用共用一个副本，检查了实际副本与两份原图字节。链接更新可撤销、重做和保存。表格排版保留了中文、转义竖线和列对齐。
- Linux ARM64 在 Debian 13 断网容器中安装三款新插件，并用原生文件选择器选择两份文档，预览后实际写回。通过「文件」菜单设置默认应用，再用系统默认打开带中文和空格的 `.md` 文件，完成编辑和保存。确认 `.desktop` 声明 `text/markdown` 并传入文件参数。
- macOS Universal DMG 通过镜像、签名、文档类型和两种架构的命令行启动检查，Intel 使用 Rosetta。Windows x64 NSIS 通过构建和安装档案校验，生成的安装脚本包含默认应用登记。macOS 系统确认和 Windows 设置切换待实机验证。macOS 公证与 Windows 签名待完成。

### 0.2.2

安装包和 SHA-256 校验文件位于 `release/0.2.2/`，构建源为 `64ddbed`。六款插件随包提供，公网市场由 `792f84a` 发布。已匿名下载全部六个包，核对 SHA-256、身份、版本和接口。[公网目录](https://lw5959.github.io/yeyu-plugin-market/index.json) · [市场发布提交](https://github.com/Lw5959/yeyu-plugin-market/commit/792f84a)

| 安装包 | 验收 |
|---|---|
| macOS Universal DMG | Apple Silicon 上用原生 QA 窗口从官方市场实际下载 JavaScript 包，并验证三款插件的安装、运行、差异应用和撤销。测试了 CSV 往返、中文排版保留代码、重复标题跳转及目录移除。八套本机 Typora 主题、协作子菜单、导出、文档往返和恢复通过。DMG 校验和临时签名验证通过，`arm64` 与 `x86_64` 均通过命令行启动检查，后者使用 Rosetta。 |
| Windows x64 NSIS | 交叉构建和安装档案校验通过。安装包未签名，Windows 原生窗口待验收。 |
| Linux ARM64 DEB | Debian 13 断网容器安装成功。通过 Xvfb 桌面打开、编辑、保存并保留 BOM。市场主动切换到内置目录安装 JavaScript 表格转换，自动回退到内置目录后安装 Rust 中文排版。 |

macOS 公证和 Intel 物理设备验收、Linux x64 安装包仍待完成。

0.2.2 的两次独立性能复测均在等待首帧结果时超时。性能表保留此前发布配置的实测数据。

### 历史版本

0.2.1 安装包和 SHA-256 校验文件位于 `release/0.2.1/`，构建源为 `501dbe0`。该版本的三个插件由市场提交 `8a5f9a1` 发布。

0.2.0、0.1.4 和 0.1.3 的安装包仍在各版本目录，构建源分别为 `5c67e00`、`db9debd` 和 `ecb99ef`。

| 安装包 | 验收 |
|---|---|
| macOS Universal DMG | Apple Silicon 原生 QA 窗口通过官方市场首次安装、在线请求挂起时的内置安装、导出、文档往返和草稿恢复。DMG 含 `arm64` 和 `x86_64`。只读挂载后校验应用临时签名，x86_64 在 Rosetta 下通过命令行启动检查。公证待完成。 |
| Windows x64 NSIS | 交叉构建与安装档案校验通过。安装包未签名，Windows 原生窗口待验收。 |
| Linux ARM64 DEB | Debian 13 容器中安装。在断网容器的 WebKitGTK 与 Xvfb 桌面窗口中分别通过直接切换和自动回退安装任务清单。打开、编辑和保存 Markdown 通过，原文件 BOM 保留。 |

Intel 物理 Mac、Linux x64 安装包和人工中文拼音候选操作待验收。三种 AI 协议均在本机真实模型上通过，远程账号鉴权待验收。Typora 功能差异及后续里程碑见[功能对照表](feature-matrix.md)。

## 复测命令

```sh
pnpm test
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path examples/plugins/workflows/Cargo.toml
node tests/editor-browser.mjs
```

在 macOS 有桌面会话的环境中，可以运行以下 QA 构建。先留出一个系统临时目录，确保发布构建继续使用项目自己的 `dist/`。

```sh
qa_dist=$(mktemp -d)
YEYU_QA=1 pnpm exec vite build --outDir "$qa_dist"
qa_config=$(node -p 'JSON.stringify({identifier:"io.yeyu.markdown.qa",build:{frontendDist:process.argv[1],beforeBuildCommand:""}})' "$qa_dist")
pnpm tauri build --features qa --config "$qa_config" --no-bundle --ci
node scripts/native-qa.mjs src-tauri/target/release/yeyu measure
```

完整验收用 `full` 参数。可设置 `YEYU_PANDOC`、`YEYU_TEST_MODEL_URL`、`YEYU_TEST_MODEL`。`YEYU_TEST_THEMES` 接受 `[{ "path": "/path/to/theme.css", "name": "主题名" }]`，`YEYU_TEST_TYPORA` 接受期望从本机发现的主题名列表，例如 `["github", "night"]`。测试本机设置预览与迁移时可设置 `YEYU_TEST_TYPORA_CONFIG=1`。脚本会打印临时证据路径。

可把 `YEYU_TEST_THEME_SNAPSHOTS` 指向验收目录下的 `app-data/themes`，再运行 `pnpm test` 将导入主题加入交互回归。设置 `YEYU_TEST_WEBKIT=1` 并安装 Playwright 的 WebKit 后，可以用同一批主题复测 WebKit。

运行原生 `full` 验收时可设置 `YEYU_TEST_PUBLIC_MARKET=https://lw5959.github.io/yeyu-plugin-market/index.json`，验证首次打开时的官方目录连接、实际包下载，以及从自定义源恢复到官方市场。
