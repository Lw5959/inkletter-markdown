# 本地打包与更新

页屿在 GitHub 和 Gitee 发布安装包。macOS 的 Apple Silicon 和 Intel 各有一个 DMG，各自的签名应用归档也独立，更新按当前运行架构选择。 [GitHub](https://github.com/Lw5959/yeyu/releases) · [Gitee](https://gitee.com/Lw5959/yeyu/releases)

每次提升应用版本都在本机生成对应的安装包，并以 `v<版本号>` 发布。发布说明写明本版改动、可下载的平台和实际验收范围。

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
| Linux x64 | 在 x64 Debian 环境运行 `sh scripts/build-linux-local.sh -- --locked` |
| Linux ARM64 | 在 ARM64 Debian 环境运行 `sh scripts/build-linux-local.sh -- --locked` |
| Android ARM64 | `pnpm tauri android build --ci --apk --target aarch64` |

在 macOS 上交叉构建 Windows 包时，安装 `cargo-xwin` 和 Unix 版 `makensis`，使用 `sh scripts/build-windows-cross.sh --ci -- --locked`。构建入口先编译 Windows 应用，再由 NSIS 严格编译固定版本的 Tauri 安装器模板。可用 `YEYU_NSIS_CACHE` 指定工具缓存。配置更新私钥时同时生成更新签名。Windows 系统级 Authenticode 签名使用独立的发布凭据。

使用临时签名时，macOS 的每个架构先用 `env -u APPLE_SIGNING_IDENTITY -u APPLE_CERTIFICATE pnpm tauri build --ci --target <目标> --bundles app -- --locked` 生成应用包。设置 `TAURI_SIGNING_PRIVATE_KEY_PATH` 后，运行 `node scripts/package-macos-adhoc.mjs <应用包路径> <产物目录>` 写入临时签名，并生成对应的 DMG 和签名更新归档。持有 Developer ID 且已配置公证凭据时，使用上表的 Tauri 签名构建流程。

Android 构建安装 JDK、Android SDK 37、Build Tools 37.0.0、NDK 28.2.13676358 和可供 bindgen 使用的 libclang。Gradle 使用 AGP 内置 Kotlin，Java 和 Kotlin 均生成 Java 17 字节码。为 `BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android` 指定所选 NDK 的 `--sysroot`。在 `src-tauri/gen/android/app/build/outputs/apk` 找到未签名 APK，签名后用 `apksigner verify` 核对。

Debian 构建需要 `appstreamcli`、`gpg` 和同架构的 `appimagetool`。用 `YEYU_APPIMAGETOOL` 或 `PATH` 指定 `appimagetool`。使用独立 runtime 时，用 `YEYU_APPIMAGE_RUNTIME` 指定同架构的官方文件。构建入口从 DEB 生成 AppDir，一次收集 WebKitGTK 依赖和许可证，并用 xz 打包。DEB 与 AppImage 分别含 `DEB` 和 `APP` 标记，用于应用内选择正确的更新包。

## 发布到 GitHub 和 Gitee

1. 将安装包归入 `release/<版本号>/`，保留架构及扩展名。用 `node scripts/stage-desktop-release.mjs <bundle目录> <平台> <产物目录>` 整理桌面包。Android 包命名为 `Yeyu_<版本号>_android-arm64.apk`。
2. 所有平台就绪后，用 `node scripts/release-manifest.mjs <产物目录> v<版本号> Lw5959/yeyu <Gitee 清单目录>` 生成两套 `latest.json` 与 `SHA256SUMS`。在产物目录执行 `shasum -a 256 -c SHA256SUMS`，并用配置中的公钥核对五个桌面更新包的签名。
3. 将源码和同一标签推到两个仓库。分别创建发行版，上传同一批安装包和签名，以及对应站点的清单。Gitee 的附件名须与清单中的文件名一致，单个附件须在 100 MB 以内。
4. 用 `pnpm tauri signer sign --app-version <版本号> <Gitee 清单目录>/latest.json` 为 Gitee 清单签名。在 Gitee 的 `updates` 分支提交 `latest.json` 和 `latest.json.sig`。确认所有附件可匿名下载后，再推动这个分支，让客户端见到完整版本。
5. 将完整的 GitHub Release 设为最新。从 GitHub 的 `releases/latest/download/latest.json` 和 Gitee 的 `raw/updates/latest.json` 回读版本，核对附件摘要与签名。

应用内「检查更新」可选自动、GitHub 或 Gitee。自动会检查两个源，同版本下载失败时可切换。手动选择按指定的来源检查和下载。macOS、Windows 和 Linux AppImage 使用发布签名验证更新包。Linux DEB 和 Android 在页屿里显示下载进度并核对 SHA-256。Gitee 上的 DEB 和 APK 摘要来自签名清单。Android 首次从页屿安装时需要在系统设置中授权来源，返回后可继续安装。Linux 缺少关联的安装程序时，可将 DEB 保存到指定位置。
