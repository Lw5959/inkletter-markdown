#!/bin/sh
set -eu

arch=$(dpkg --print-architecture)
case "$arch" in
  amd64) machine=x86_64 ;;
  arm64) machine=aarch64 ;;
  *) exit 2 ;;
esac
target="$machine-unknown-linux-gnu"
config=${YEYU_TAURI_CONFIG:-'{}'}
pnpm tauri build --ci --no-bundle --target "$target" --config "$config" "$@"

base=$(cd src-tauri && cargo metadata --no-deps --format-version 1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')
version=$(node -p 'require("./package.json").version')
release="$base/$target/release"
staging=$(mktemp -d "${TMPDIR:-/tmp}/yeyu-linux-pack.XXXXXX")
trap 'rm -rf -- "$staging"' EXIT
mkdir -p "$staging/$target/release"
copy="$staging/$target/release/yeyu"
cp -p "$release/yeyu" "$copy"
python3 - "$copy" <<'PY'
from pathlib import Path
import sys
binary = Path(sys.argv[1])
data = binary.read_bytes()
prefix = b'__TAURI_BUNDLE_TYPE_VAR_'
if data.count(prefix) != 1:
    raise SystemExit('找不到唯一的 Linux 更新类型标记')
offset = data.index(prefix) + len(prefix)
if data[offset:offset + 3] not in (b'UNK', b'DEB', b'APP'):
    raise SystemExit('Linux 更新类型标记无效')
# Tauri 只会修改这份打包副本，失败后重试仍从原始编译文件开始。
binary.write_bytes(data[:offset] + b'UNK' + data[offset + 3:])
PY
CARGO_TARGET_DIR="$staging" pnpm tauri bundle --ci --target "$target" --bundles deb --config "$config"
deb="Yeyu_${version}_$arch.deb"
image="Yeyu_${version}_$machine.AppImage"
package="$staging/$target/release/bundle/deb/$deb"
python3 scripts/package-linux-appimage.py "$package" "$staging/$image"
if [ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  pnpm tauri signer sign --app-version "$version" "$staging/$image"
fi

mkdir -p "$release/bundle/deb" "$release/bundle/appimage"
cp -p "$package" "$release/bundle/deb/$deb"
cp -p "$staging/$image" "$release/bundle/appimage/$image"
if [ -f "$staging/$image.sig" ]; then
  cp -p "$staging/$image.sig" "$release/bundle/appimage/$image.sig"
else
  rm -f "$release/bundle/appimage/$image.sig"
fi
