# 本地打包与更新

页屿使用 [Lw5959/yeyu](https://github.com/Lw5959/yeyu) 发布安装包。macOS 的 Apple Silicon 和 Intel 各有一个 DMG，各自的签名应用归档也独立，更新按当前运行架构选择。

## 准备签名

- 桌面更新的 Minisign 公钥位于 `src-tauri/tauri.conf.json`。本机签名通过 `TAURI_SIGNING_PRIVATE_KEY` 指定私钥，可用 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 解锁。macOS 公证和 Windows Authenticode 使用各平台的签名流程。
- Android 用 `apksigner` 和本地签名库签名。升级时沿用原 APK 的签名密钥，并提高 `versionCode`。
- 私钥需要离线备份并保存在受限位置。签名材料不得加入源码库，也不应作为构建产物上传。

## 生成安装包

同步 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 和 `Cargo.lock` 的版本，在装有目标平台工具链的主机或本地容器中构建。先执行 `pnpm install --frozen-lockfile`。每条桌面构建命令可追加 `--config '{"bundle":{"createUpdaterArtifacts":true}}'` 生成签名更新包。

| 目标 | 本地构建命令 |
| --- | --- |
| macOS Apple Silicon | `pnpm tauri build --ci --target aarch64-apple-darwin --bundles app,dmg -- --locked` |
| macOS Intel | `pnpm tauri build --ci --target x86_64-apple-darwin --bundles app,dmg -- --locked` |
| Windows x64 | `pnpm tauri build --ci --target x86_64-pc-windows-msvc --bundles nsis -- --locked` |
| Linux x64 | `APPIMAGE_EXTRACT_AND_RUN=1 pnpm tauri build --ci --target x86_64-unknown-linux-gnu --bundles deb,appimage -- --locked` |
| Linux ARM64 | `APPIMAGE_EXTRACT_AND_RUN=1 pnpm tauri build --ci --target aarch64-unknown-linux-gnu --bundles deb,appimage -- --locked` |
| Android ARM64 | `pnpm tauri android build --ci --apk --target aarch64` |

Android 构建安装 Android SDK 37、Build Tools 37.0.0、NDK 28.2.13676358 和可供 bindgen 使用的 libclang。为 `BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android` 指定所选 NDK 的 `--sysroot`。在 `src-tauri/gen/android/app/build/outputs/apk` 找到未签名 APK，签名后用 `apksigner verify` 核对。

将安装包归入 `release/<版本号>/`，保留架构及扩展名。需要将本地构建发布到 GitHub Releases 时，用 `node scripts/stage-desktop-release.mjs <bundle目录> <平台> <产物目录>` 整理桌面包。Android 包命名为 `Yeyu_<版本号>_android-arm64.apk`。所有包就绪后运行 `node scripts/release-manifest.mjs <产物目录> v<版本号> Lw5959/yeyu`，核对生成的 `latest.json`、`SHA256SUMS` 和签名，再手动上传。只交付本地包时可直接用 `shasum -a 256` 生成校验文件。

应用查询 GitHub 最新稳定 Release。桌面原生更新使用 `latest.json` 并验证产物签名。DEB 和 Android 在用户确认后交给系统安装器。用户仍可从 Releases 页面下载对应系统和架构的安装包。
