# 验收与性能

## 验收方法

- macOS 使用实际 Tauri/WKWebView 窗口。QA 构建使用独立应用标识和临时工作区，生产安装包不包含 QA 驱动。
- PDF/PNG 使用实际 Chromium 打印与截图能力，DOCX 往返使用 Pandoc 3.14。
- AI 流式测试使用本机 llama.cpp b12671 和 Qwen2.5-0.5B-Instruct Q4_K_M。选区预览后执行真实改写，应用后撤销。
- MCP 使用官方 TypeScript SDK 作为外部 stdio 客户端，发现并调用搜索、读取、选区与建议。页屿还连接了独立 SDK 实现的 Streamable HTTP 端点并调用三类能力。
- 自动化验收在临时工作区模拟磁盘外部更新和异常退出。原始文件带 BOM、混合行尾、中文、Emoji、相对图片和未识别标记。

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

## 复测命令

```sh
pnpm test
cargo test --locked --manifest-path src-tauri/Cargo.toml
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
