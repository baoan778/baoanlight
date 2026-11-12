#!/usr/bin/env bash
# Starts baoanlight at login on Linux desktops (GNOME, KDE, XFCE...).
set -e
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/baoanlight.desktop"
# 登录时 PATH 里通常没有 nvm/volta 装的那个 node，所以写绝对路径，并加引号
# （家目录里带空格并不罕见）。这和 src/autostart.js 的做法保持一致 —— 同一件
# 事有两套写法时，总有一套会在某台机器上悄悄失败。
node_bin="$(command -v node || echo node)"
cli_path="$(dirname "$here")/src/cli.js"
sed "s|^Exec=.*|Exec=\"$node_bin\" \"$cli_path\" start|" "$here/baoanlight.desktop" > "$target"
echo "installed $target"
