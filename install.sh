#!/usr/bin/env bash
# 把插件装进指定 Obsidian 仓库
# 用法: ./install.sh "/path/to/YourVault"
set -euo pipefail

VAULT="${1:-}"
PLUGIN_ID="pale-view"
SRC="$(cd "$(dirname "$0")" && pwd)"

if [ -z "$VAULT" ]; then
  echo "用法: ./install.sh \"/path/to/YourVault\""
  exit 1
fi
if [ ! -d "$VAULT/.obsidian" ]; then
  echo "找不到 $VAULT/.obsidian，确认这是一个 Obsidian 仓库目录"
  exit 1
fi

DEST="$VAULT/.obsidian/plugins/$PLUGIN_ID"
mkdir -p "$DEST"
cp "$SRC/main.js" "$SRC/manifest.json" "$SRC/styles.css" "$DEST/"

echo "已安装到: $DEST"
echo "下一步：Obsidian → 设置 → 第三方插件 → 关闭安全模式（如未关闭）→ 启用「Pale View」"
