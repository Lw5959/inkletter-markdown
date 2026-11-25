# GitHub Releases 发布与更新

页屿使用 [Lw5959/yeyu](https://github.com/Lw5959/yeyu) 发布安装包。macOS 的 Apple Silicon 和 Intel 各有一个 DMG，各自的签名应用归档也独立，更新按当前运行架构选择。

## 准备签名

- 桌面更新的 Minisign 公钥位于 `src-tauri/tauri.conf.json`。GitHub Actions 使用 `TAURI_SIGNING_PRIVATE_KEY` 和可选的 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。它们与 macOS 公证、Windows Authenticode 签名是独立流程。
- Android 构建用 `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEY_PASSWORD` 和密钥别名 `yeyu`。发布后保留同一签名密钥，Android 据此验收应用升级。
- 私钥需要离线备份并保存在受限位置。签名材料不得加入源码库，也不应作为构建产物上传。

## 发布版本

1. 同步 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 和 `Cargo.lock` 的版本。在源提交打 `v` 开头的版本标签并推送。
2. 「发布页屿」矩阵构建两个 macOS、一个 Windows、两个 Linux 目标及 Android ARM64。每个发布包以版本和架构命名。
3. 汇总任务检查必需安装包，生成 `latest.json` 和 `SHA256SUMS`。先上传到草稿，文件全部上传成功后发布。

应用查询 GitHub 最新稳定 Release。桌面原生更新使用 `latest.json` 并验证产物签名。DEB 和 Android 在用户确认后交给系统安装器。用户仍可从 Releases 页面下载对应系统和架构的安装包。
