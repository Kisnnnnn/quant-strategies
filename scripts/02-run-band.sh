#!/bin/bash
# 02_运行波段回调策略
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT"

echo ""
echo "==== 策略: 波段回调选股 ===="
echo ""
node -e "
import('./src/pipeline.mjs').then(async m => {
  const cfg = m.loadConfig('band-dip');
  await m.runStrategy('band-dip', cfg);
  process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
"
