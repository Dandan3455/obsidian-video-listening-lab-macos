#!/usr/bin/env bash
set -euo pipefail

if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python3)"
else
  echo "错误：未找到 Python 3。请先安装 Python 3.10 或更高版本。" >&2
  exit 1
fi

"$PYTHON_BIN" -m pip install --user --upgrade yt-dlp imageio-ffmpeg

echo
echo "依赖安装完成。插件设置中的 Python 路径可填写：$PYTHON_BIN"
