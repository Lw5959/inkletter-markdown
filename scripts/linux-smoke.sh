#!/bin/sh
set -eu

program=${1:-/usr/bin/yeyu}
stage=$(mktemp -d -t yeyu-linux-smoke.XXXXXX)
printf '\357\273\277# Linux desktop\r\n\r\n' > "$stage/note.md"
export XDG_DATA_HOME="$stage/data" XDG_CONFIG_HOME="$stage/config" XDG_CACHE_HOME="$stage/cache"
export XDG_RUNTIME_DIR="$stage/run"
mkdir -m 700 "$XDG_RUNTIME_DIR"

# 在独立的 X11 会话中操作真实窗口，不占用用户的键盘焦点。
dbus-run-session -- xvfb-run -a -s '-screen 0 1280x900x24' sh -eu -c '
  program=$1
  stage=$2
  "$program" "$stage/note.md" > "$stage/app.log" 2>&1 &
  app=$!
  trap "kill $app 2>/dev/null || true" EXIT
  window=
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    window=$(xdotool search --onlyvisible --name . | tail -1)
    if [ -n "$window" ] && test -f "$XDG_DATA_HOME/io.yeyu.markdown/settings.json"; then break; fi
    sleep 1
  done
  if [ -z "$window" ]; then cat "$stage/app.log"; exit 1; fi
  xdotool windowfocus --sync "$window"
  xdotool mousemove --window "$window" 512 100 click 1
  xdotool key --clearmodifiers ctrl+End Return
  xdotool type --clearmodifiers linux-desktop-smoke
  xdotool key --clearmodifiers ctrl+s
  for attempt in 1 2 3 4 5; do
    if grep -q linux-desktop-smoke "$stage/note.md"; then break; fi
    sleep 1
  done
  grep -q "Linux desktop" "$stage/note.md"
  grep -q linux-desktop-smoke "$stage/note.md"
  test "$(od -An -tx1 -N3 "$stage/note.md" | tr -d " \n")" = efbbbf
  printf "Linux 窗口打开、编辑、保存和 BOM 校验通过\n"
' sh "$program" "$stage"
