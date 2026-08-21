#!/bin/bash
# actdsh 一键安装器（随 dmg 附带）。
# 作用：把 actdsh.app 装入应用程序目录、解除 macOS Gatekeeper 隔离标记并启动。
# 面向不熟悉终端的用户：双击本文件即可，无需手动输入任何命令。
set -u
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_SRC="$SELF_DIR/actdsh.app"
if [ ! -d "$APP_SRC" ]; then
  # 兼容：用户可能已把 app 先拖到了应用程序目录，只把本脚本留在下载目录。
  if [ -d "/Applications/actdsh.app" ]; then
    APP_SRC="/Applications/actdsh.app"
  else
    echo "未找到 actdsh.app。请把本脚本与 actdsh.app 放在同一窗口（dmg 打开后的窗口）再双击。"
    read -r -p "按回车退出…"
    exit 1
  fi
fi
DEST_DIR="/Applications"
if [ ! -w "$DEST_DIR" ]; then
  DEST_DIR="$HOME/Applications"
  mkdir -p "$DEST_DIR"
fi
APP_DST="$DEST_DIR/actdsh.app"
echo "==> 正在安装到 $APP_DST …"
rm -rf "$APP_DST"
cp -R "$APP_SRC" "$APP_DST"
echo "==> 解除系统安全隔离标记 …"
xattr -dr com.apple.quarantine "$APP_DST" 2>/dev/null || true
echo "==> 安装完成，正在启动 actdsh …"
open "$APP_DST"
echo "（以后直接从『启动台』或 $APP_DST 打开即可，本窗口可以关闭了。）"
