#!/bin/sh
set -eu

runner=${YEYU_WINDOWS_RUNNER:-cargo-xwin}
command -v "$runner" >/dev/null
command -v makensis >/dev/null

# 先构建 Windows 应用，再由 Unix 版 NSIS 编译同一套安装器模板。
# 交叉工具链的发布 CRT 没有 PDB，发布链接无需生成调试数据库。
export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }-C link-arg=/DEBUG:NONE"
pnpm tauri build --no-bundle --runner "$runner" --target x86_64-pc-windows-msvc "$@"
node scripts/package-windows-nsis.mjs
