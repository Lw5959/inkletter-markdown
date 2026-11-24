# 技术栈试验

使用 Apple M1 Pro（32 GB）、macOS 27.2.1、Chrome 158.0.8127.88。运行 `pnpm test` 检查使用原始 Markdown 的往返差异，启动 `pnpm dev` 后运行 `node scripts/basis-probe.mjs` 检查编辑视图。

| 试验 | 结果 |
|---|---|
| ProseMirror 默认 Markdown 解析及序列化 | 多余列表空格与引用形式在往返中被重写。若采用结构化文档作为主状态，需另行维护原文映射。 |
| CodeMirror 单缓冲区切换实时和源码视图 | 保留选区 2–4，撤销还原原文。 |
| Chromium composition 协议输入中文 | 合成提交一次，文本包含预期的“中文”。 |
| 样式选择器 | `#write .live-h1` 命中实时标题，计算颜色为 `rgb(32, 82, 72)`。 |
| 长文档原型 | 7,140,013 字节的合成 Markdown 设置缓冲区用时 27 ms，可见 DOM 有 37 行。这是开发模式中的单次测量。 |

采用 Tauri 2、Rust、TypeScript 和 CodeMirror 6。使用同一个源码缓冲区驱动两种视图，显示装饰与渲染不参与文档往返。系统中文输入和发布构建性能各有独立验收。
