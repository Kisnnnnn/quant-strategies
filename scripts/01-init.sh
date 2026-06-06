#!/bin/bash
# 01_初始化环境 — 检查依赖
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(dirname "$SCRIPT_DIR")"
STOCK_DATA="$PROJECT/../chaogu/stock-data.mjs"

echo "==== 环境检查 ===="
echo "项目目录: $PROJECT"
echo "数据模块: $STOCK_DATA"

if [ ! -f "$STOCK_DATA" ]; then
  echo "❌ 找不到 stock-data.mjs，请确认 chaogu 项目存在"
  exit 1
fi

if ! command -v node &> /dev/null; then
  echo "❌ 未安装 Node.js"
  exit 1
fi

echo "✅ Node.js: $(node -v)"
echo "✅ stock-data.mjs: 已就绪"

# 创建必要目录
mkdir -p "$PROJECT/outputs" "$PROJECT/data/cache"
echo "✅ 目录结构已就绪"
echo ""
echo "初始化完成。运行方式："
echo "  bash scripts/02-run-band.sh     # 波段回调策略"
echo "  bash scripts/03-run-dragon.sh   # 龙回头策略"
echo "  bash scripts/04-run-all.sh      # 一键执行全部"
