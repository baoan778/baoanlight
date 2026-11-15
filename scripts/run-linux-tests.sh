#!/usr/bin/env bash
# Runs the suite on Linux. Used to verify Linux support from a Windows box via
# WSL, and equally useful on a real Linux machine.
set -u

NODE="$(command -v node || true)"
if [ -z "$NODE" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1)"
fi
if [ -z "$NODE" ]; then
  echo "no node found on this Linux system" >&2
  exit 1
fi

echo "node    : $("$NODE" -v)"
echo "kernel  : $(uname -sr)"
echo "distro  : $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"
echo

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/bao-linux-check"

# Copy out of /mnt so the run is on a native filesystem, and so Windows-built
# node_modules can never be picked up by accident.
rm -rf "$WORK"
mkdir -p "$WORK"
# docs/ 与 README.md 也要带上：contracts 用例会逐字节比对 docs/demo、并校验
# README 里的场景清单，缺了就是两条与代码无关的 ENOENT 假红。
( cd "$SRC" && tar cf - src test scripts package.json docs README.md ) | ( cd "$WORK" && tar xf - )

# 测试里有需要 zod / MCP SDK 的路径；不带 Windows 的 node_modules，这里从零装一份
# （只装真依赖，跳过可选 Electron/node-pty）。离线时容忍失败，让下面的用例自己报。
NPM="$(command -v npm || true)"
if [ -n "$NPM" ]; then
  echo "=== installing deps ==="
  ( cd "$WORK" && "$NPM" install --omit=optional --no-audit --no-fund >/dev/null 2>&1 ) \
    || echo "(npm install failed — offline? some cases may fail)" >&2
fi

cd "$WORK"
echo "=== test suite ==="
"$NODE" --test
RC=$?

echo
echo "=== CLI smoke test ==="
"$NODE" src/cli.js start --no-overlay --port 4799 >/tmp/bao-linux.log 2>&1 &
SRV=$!
for _ in $(seq 1 20); do
  curl -sf http://127.0.0.1:4799/health >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf http://127.0.0.1:4799/health && echo
BAOANLIGHT_PORT=4799 "$NODE" src/cli.js set busy --agent linux --session smoke --detail "checking"
BAOANLIGHT_PORT=4799 "$NODE" src/cli.js fuel 55 --agent linux --session smoke --label "plan quota"
BAOANLIGHT_PORT=4799 "$NODE" src/cli.js status
BAOANLIGHT_PORT=4799 "$NODE" src/cli.js doctor | tail -n 20
BAOANLIGHT_PORT=4799 "$NODE" src/cli.js stop
kill $SRV 2>/dev/null

exit $RC
