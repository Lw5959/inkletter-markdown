#!/bin/sh
set -eu

runner="${YEYU_WINDOWS_RUNNER:-cargo-xwin}"
command -v "$runner" >/dev/null
YEYU_NSIS_BINARY=$(command -v makensis)
export YEYU_NSIS_BINARY

shim=$(mktemp -d "${TMPDIR:-/tmp}/yeyu-nsis.XXXXXX")
trap 'rm -f "$shim/makensis"; rmdir "$shim"' EXIT

# Tauri 会传入仅供 Windows 控制台使用的输出编码参数。Unix 版 NSIS 使用终端编码。
cat > "$shim/makensis" <<'NSIS'
#!/bin/sh
set -eu
original=$#
skip=0
for option in "$@"; do
  if [ "$skip" -eq 1 ]; then
    skip=0
  elif [ "$option" = -OUTPUTCHARSET ]; then
    skip=1
  else
    set -- "$@" "$option"
  fi
done
shift "$original"
exec "$YEYU_NSIS_BINARY" "$@"
NSIS
chmod +x "$shim/makensis"
export PATH="$shim:$PATH"

# 交叉工具链的发布 CRT 不附 PDB。发布链接不生成调试数据库。
export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }-C link-arg=/DEBUG:NONE"
pnpm tauri build --runner "$runner" --target x86_64-pc-windows-msvc --bundles nsis "$@"
