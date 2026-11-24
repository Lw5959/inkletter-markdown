# 页屿

页屿是支持实时编辑和源码模式的桌面 Markdown 编辑器。文件以普通 `.md` 保存。

安装 Node.js 24、pnpm、Rust 和 Tauri 对应平台的编译依赖。macOS 需要 Xcode Command Line Tools，Windows 需要 MSVC 与 WebView2，Linux 需要 GTK 3 与 WebKitGTK 4.1。

```sh
pnpm install --frozen-lockfile
pnpm tauri dev
pnpm tauri build
```

[功能对照表](docs/feature-matrix.md) · [接口与文件归属](docs/architecture.md)
