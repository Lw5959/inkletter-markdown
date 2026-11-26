# 本地打包与更新

页屿使用 [Lw5959/yeyu](https://github.com/Lw5959/yeyu) 发布安装包。macOS 的 Apple Silicon 和 Intel 各有一个 DMG，各自的签名应用归档也独立，更新按当前运行架构选择。

每次提升应用版本都在本机生成对应的安装包，并以 `v<版本号>` 发布 GitHub Release。发布说明写明本版改动、可下载的平台和实际验收范围。

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

在 macOS 上交叉构建 Windows 包时，安装 `cargo-xwin` 和 Unix 版 `makensis`，使用 `sh scripts/build-windows-cross.sh --ci --config '{"bundle":{"createUpdaterArtifacts":true}}' -- --locked`。这个入口按 Unix 版 NSIS 的参数生成安装器，发布链接也按交叉工具链提供的 CRT 生成。

使用临时签名时，macOS 的每个架构先用 `pnpm tauri build --ci --target <目标> --bundles app --no-sign -- --locked` 生成应用包。设置 `TAURI_SIGNING_PRIVATE_KEY_PATH` 后，运行 `node scripts/package-macos-adhoc.mjs <应用包路径> <产物目录>` 生成对应的 DMG 和签名更新归档。持有 Developer ID 且已配置公证凭据时，使用上表的 Tauri 签名构建流程。

Android 构建安装 JDK、Android SDK 37、Build Tools 37.0.0、NDK 28.2.13676358 和可供 bindgen 使用的 libclang。Gradle 使用 AGP 内置 Kotlin，Java 和 Kotlin 均生成 Java 17 字节码。为 `BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android` 指定所选 NDK 的 `--sysroot`。在 `src-tauri/gen/android/app/build/outputs/apk` 找到未签名 APK，签名后用 `apksigner verify` 核对。

## 发布到 GitHub

1. 将安装包归入 `release/<版本号>/`，保留架构及扩展名。用 `node scripts/stage-desktop-release.mjs <bundle目录> <平台> <产物目录>` 整理桌面包。Android 包命名为 `Yeyu_<版本号>_android-arm64.apk`。
2. 所有平台就绪后，用 `node scripts/release-manifest.mjs <产物目录> v<版本号> Lw5959/yeyu` 生成 `latest.json` 与 `SHA256SUMS`。在产物目录执行 `shasum -a 256 -c SHA256SUMS`，并用配置中的公钥验证五个桌面更新包的签名。
3. 推送源码并将标签指向实际构建提交。在 GitHub 创建对应标签的 Release 草稿，上传安装包、更新包、签名和两个清单。核对远端资产列表和 SHA-256 后再公开发布。
4. 将安装包和更新包齐全的稳定版本设为最新，并从公开的 `releases/latest/download/latest.json` 读回版本和下载地址。

应用内「检查更新」从 GitHub Releases 获取最新稳定版。macOS、Windows 和 Linux AppImage 使用 `latest.json` 下载签名更新包。Linux DEB 和 Android 在页屿里显示下载进度，依据发布资产的 SHA-256 核对文件，下载完成后可打开系统安装器。Android 首次从页屿安装时需要在系统设置中授权来源，返回后可继续安装。Linux 缺少关联的安装程序时，可将 DEB 保存到指定位置。
