# 验收与性能

## 验收方法

- macOS 使用实际 Tauri/WKWebView 窗口。QA 构建使用独立应用标识和临时工作区，生产安装包不包含 QA 驱动。
- PDF/PNG 使用实际 Chromium 打印与截图能力，DOCX 往返使用 Pandoc 3.14。
- AI 流式测试使用本机 llama.cpp b12671 和 Qwen2.5-0.5B-Instruct Q4_K_M。通过模型配置页接通 Chat Completions、Anthropic Messages 和 Responses。保存改写提示词后，模型将选区中的 `wordy` 改为 `verbose`。验收覆盖差异应用、撤销及恢复默认提示词。
- MCP 使用官方 TypeScript SDK 作为外部 stdio 客户端，发现并调用搜索、读取、选区与建议。页屿还连接了独立 SDK 实现的 Streamable HTTP 端点并调用三类能力。
- 自动化验收在临时工作区模拟磁盘外部更新和异常退出。原始文件带 BOM、混合行尾、中文、Emoji、相对图片和未识别标记。
- 通过原生插件管理流程安装和启用示例 Wasm 模块，运行中替换版本，处理选区并审阅、应用与撤销，随后停用和卸载。
- macOS 原生窗体验证插件市场的离线浏览、搜索和三款内置插件安装，并通过任务清单验证选区、差异、应用与撤销。用实际构建脚本生成目录并通过回环 HTTP 提供。首份更新包的字节与摘要不一致时原版本继续可用，重试更新成功并沿用启用状态。市场源保存和切回内置目录均通过。
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

实时引用和 YAML 仍呈现原文行，HTML 中按完整块排版。针对旧版 CodeMirror 源码界面编写的选择器不会完整匹配。测试使用本机 CSS 和字体，安装包只包含页屿自带主题。

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

## 平台验收范围

0.1.4 安装包和 SHA-256 校验文件位于 `release/0.1.4/`，构建源为 `db9debd`。此前的 0.1.3 安装包仍位于 `release/0.1.3/`，构建源为 `ecb99ef`。

| 安装包 | 验收 |
|---|---|
| macOS Universal DMG | Apple Silicon 原生 QA 窗口通过导出菜单、主题、文档往返和草稿恢复复测。DMG 含 `arm64` 和 `x86_64`。只读挂载后校验应用临时签名，x86_64 在 Rosetta 下通过命令行启动检查。公证待完成。 |
| Windows x64 NSIS | 交叉构建与安装档案校验通过。安装包未签名，Windows 原生窗口待验收。 |
| Linux ARM64 DEB | Debian 13 容器中安装，在 WebKitGTK 与 Xvfb 的桌面窗口打开、编辑和保存 Markdown，验证原文件 BOM 保留。 |

Intel 物理 Mac、Linux x64 安装包和人工中文拼音候选操作待验收。三种 AI 协议均在本机真实模型上通过，远程账号鉴权待验收。Typora 功能差异及后续里程碑见[功能对照表](feature-matrix.md)。

## 复测命令

```sh
pnpm test
cargo test --locked --manifest-path src-tauri/Cargo.toml
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
