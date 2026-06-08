#!/bin/bash
# ============================================================
# Serenity 供应链卡点分析 — 入口脚本
# ============================================================
# 用法:
#   bash scripts/run-serenity.sh              # 全赛道分析
#   bash scripts/run-serenity.sh ai_infra     # 仅AI基础设施
#   bash scripts/run-serenity.sh robotics     # 仅机器人
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SERENITY_DIR="$PROJECT_DIR/serenity"

# 默认范围
SCOPE="${1:-all}"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Serenity 供应链卡点分析 v1.0                        ║"
echo "║  范围: $SCOPE                                       ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# 检查文件存在
if [ ! -f "$SERENITY_DIR/pipeline.mjs" ]; then
  echo "[错误] 找不到 serenity/pipeline.mjs"
  exit 1
fi

# 运行分析管线
cd "$PROJECT_DIR"
node serenity/pipeline.mjs --scope="$SCOPE"

echo ""
echo "完成。报告保存在 outputs/ 目录下。"
