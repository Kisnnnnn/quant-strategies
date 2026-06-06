#!/bin/bash
# 04_一键执行全部策略
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT"

echo ""
echo "╔════════════════════════════════════════════════╗"
echo "║         A股短线策略 — 一键全扫描              ║"
echo "╚════════════════════════════════════════════════╝"
echo ""

bash "$SCRIPT_DIR/02-run-band.sh"
bash "$SCRIPT_DIR/03-run-dragon.sh"

echo ""
echo "全部策略执行完毕。结果保存在 outputs/ 目录下。"
