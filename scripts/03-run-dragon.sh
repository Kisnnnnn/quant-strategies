#!/bin/bash
# 03_运行龙回头策略
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT"

echo ""
echo "==== 策略: 龙回头二次启动 ===="
echo "⚠️ 量化时代此策略胜率已大幅下降，仅供观察验证"
echo ""
node -e "
import('./src/pipeline.mjs').then(async m => {
  const cfg = m.loadConfig('dragon-reverse');
  await m.runStrategy('dragon-reverse', cfg);
  process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
"
