#!/usr/bin/env bash
# Starts baoanlight at login on Linux desktops (GNOME, KDE, XFCE...).
set -e
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/baoanlight.desktop"
sed "s|^Exec=.*|Exec=node $(dirname "$here")/src/cli.js start|" "$here/baoanlight.desktop" > "$target"
echo "installed $target"
