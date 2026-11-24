# 验收与性能

## 验收方法

- macOS 使用实际 Tauri/WKWebView 窗口。QA 构建使用独立应用标识和临时工作区，生产安装包不包含 QA 驱动。
- PDF/PNG 使用实际 Chromium 打印与截图能力，DOCX 往返使用 Pandoc 3.14。
- AI 流式测试使用本机 llama.cpp b12671 和 Qwen2.5-0.5B-Instruct Q4_K_M。通过模型配置页接通 Chat Completions、Anthropic Messages 和 Responses。保存改写提示词后，模型将选区中的 `wordy` 改为 `verbose`。验收覆盖差异应用、撤销及恢复默认提示词。
- MCP 使用官方 TypeScript SDK 作为外部 stdio 客户端，发现并调用搜索、读取、选区与建议。页屿还连接了独立 SDK 实现的 Streamable HTTP 端点并调用三类能力。
- 自动化验收在临时工作区模拟磁盘外部更新和异常退出。原始文件带 BOM、混合行尾、中文、Emoji、相对图片和未识别标记。
- 通过原生插件管理流程安装和启用示例 Wasm 模块，运行中替换版本，处理选区并审阅、应用与撤销，随后停用和卸载。
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

本地安装包构建源为 `9cfd234`。三个包和 SHA-256 校验文件位于 `release/0.1.0/`。原生完整流程以 `6d62074` 的发布配置验收，滚动条改动另做 Chromium 与 WebKit 界面回归。

| 安装包 | 验收 |
|---|---|
| macOS Universal DMG | Apple Silicon 的发布配置通过桌面端完整流程。DMG 含 `arm64` 和 `x86_64`，x86_64 在 Rosetta 下通过命令行启动检查。DMG 内程序使用临时签名，公证待完成。 |
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

完整验收用 `full` 参数。可设置 `YEYU_PANDOC`、`YEYU_TEST_MODEL_URL`、`YEYU_TEST_MODEL`，以及 `YEYU_TEST_THEMES`，后者为 `[{ "path": "/path/to/theme.css", "name": "主题名" }]`。脚本会打印临时证据路径。
