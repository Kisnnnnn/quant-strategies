/**
 * 龙回头信号生成 V2
 *
 * 逻辑：
 *   1. 识别首波大涨（至少1次涨停）+ 高点接近60日高点
 *   2. 回调确认：回调幅度和时间在阈值内 + 形态收敛
 *   3. 量能缩量：当前量 vs 首波峰值量 + 连续缩量
 *   4. 企稳确认：止跌K线 + 不创新低 + 放量突破回调趋势
 *   5. 催化剂验证：机构净买加分 · 机构净卖扣分
 *   6. 龙性评分排序
 */

export function generateDragonSignals(stock, indicators, stratCfg = {}, marketCtx = {}) {
  const ind = indicators;
  if (!ind) return null;

  const cfg = stratCfg.dragon || {};
  const minWave = cfg.min_first_wave_pct ?? 25;
  const minRet = cfg.min_retrace_pct ?? 8;
  const maxRet = cfg.max_retrace_pct ?? 35;
  const maxDays = cfg.max_retrace_days ?? 15;
  const maxVolR = cfg.max_vol_ratio ?? 0.6;
  const ratioTh = cfg.wave_high_ratio_threshold ?? 0.85;
  const minLimitUp = cfg.min_limit_up_days ?? 1;

  const { closes, highs, lows, vols, raw } = ind;
  const { rows, len } = raw;
  const curVol = vols[len - 1];

  // 60日高点
  const high60 = Math.max(...highs.slice(-61, -1));

  // 扫描最佳波段
  let best = { peak: 0, start: -1, peakIdx: -1, waveHigh: 0, limitUpCnt: 0 };
  for (let j = len - 15; j < len; j++) {
    for (let k = j - 15; k < j - 5; k++) {
      if (k < 0) continue;
      const waveChg = ((closes[j] - closes[k]) / closes[k]) * 100;
      const waveHigh = Math.max(...highs.slice(k, j + 1));
      const retrace = ((waveHigh - ind.curr) / waveHigh) * 100;
      if (
        waveChg >= minWave &&
        retrace >= minRet && retrace <= maxRet &&
        waveHigh >= high60 * ratioTh
      ) {
        // 统计波段内涨停天数
        let luCnt = 0;
        for (let m = k; m <= j; m++) {
          const dayChg = ((+rows[m].close - +rows[m].open) / +rows[m].open) * 100;
          if (dayChg > 9.8) luCnt++;
        }
        if (waveChg > best.peak || (waveChg === best.peak && luCnt > best.limitUpCnt)) {
          best = { peak: waveChg, start: k, peakIdx: j, waveHigh, limitUpCnt: luCnt };
        }
      }
    }
  }

  if (best.peak < minWave || best.peakIdx <= 0) return null;

  // ── P1: 龙头确认：至少N次涨停 ──────────────────────────
  if (best.limitUpCnt < minLimitUp) return null;

  const retracePct = ((best.waveHigh - ind.curr) / best.waveHigh) * 100;
  const retraceDays = len - 1 - best.peakIdx;
  const peakVol = Math.max(...vols.slice(best.start, best.peakIdx + 1));
  const volRatio = peakVol > 0 ? curVol / peakVol : 1;

  if (retracePct < minRet || retracePct > maxRet ||
      retraceDays < 2 || retraceDays > maxDays || volRatio >= maxVolR) return null;

  // ── 回调形态分析 ──────────────────────────────────────
  // 回调期前3天 vs 后3天振幅比较（振幅收敛=即将变盘）
  const retraceRows = rows.slice(best.peakIdx + 1);
  const firstHalf = retraceRows.slice(0, Math.min(3, Math.floor(retraceRows.length / 2)));
  const lastHalf = retraceRows.slice(-Math.min(3, Math.floor(retraceRows.length / 2)));
  const avgAmp1 = firstHalf.reduce((s, r) => s + (+r.high - +r.low) / +r.open * 100, 0) / (firstHalf.length || 1);
  const avgAmp2 = lastHalf.reduce((s, r) => s + (+r.high - +r.low) / +r.open * 100, 0) / (lastHalf.length || 1);
  const ampConverge = avgAmp2 < avgAmp1 * 0.8; // 振幅收敛20%以上

  // 回调期是否连续缩量
  let consecutiveVolShrink = 0;
  for (let i = best.peakIdx + 2; i < len; i++) {
    if (vols[i] < vols[i - 1]) consecutiveVolShrink++;
    else break;
  }

  // ── 强势日统计 ──────────────────────────────────────
  const dailyChgs = rows.slice(best.start, best.peakIdx + 1)
    .map(r => ((+r.close - +r.open) / +r.open) * 100);
  const strongDays = dailyChgs.filter(c => c > 5).length;

  // ── 企稳信号 ────────────────────────────────────────
  const stabilizing = (
    (ind.curr > ind.prev || Math.abs((ind.curr - ind.prev) / ind.prev) < 0.02) &&
    (ind.candleType === "hammer" || ind.candleType === "doji" || ind.curr > ind.prev || ind.noNewLow >= 2)
  );

  // ── 评分 ────────────────────────────────────────────
  const w = stratCfg.scoring?.weights || {};

  const waveScore = best.peak > 40 ? 1 : best.peak > 30 ? 0.7 : 0.35;
  // 涨停次数加分
  const luBonus = best.limitUpCnt >= 3 ? 0.15 : best.limitUpCnt >= 2 ? 0.1 : 0;
  const strongScore = Math.min(1, strongDays >= 3 ? 1 : strongDays >= 2 ? 0.7 : 0.35 + luBonus);
  const volScore = volRatio < 0.35 ? 1 : volRatio < 0.5 ? 0.7 : 0.35;
  let retQual = 0;
  if (retraceDays >= 3 && retraceDays <= 10) retQual += 0.3;
  if (retracePct >= 15 && retracePct <= 28) retQual += 0.3;
  if (ampConverge) retQual += 0.2;  // 振幅收敛加分
  if (consecutiveVolShrink >= 3) retQual += 0.2; // 连续缩量加分
  let stabScore = (stabilizing && ind.curr > ind.ma20) ? 1 : stabilizing ? 0.7 : 0.2;
  // 3天不创新低加分
  if (ind.noNewLow >= 3) stabScore = Math.min(1, stabScore + 0.2);

  let score = (
    (w.wave_strength || 0.25) * waveScore +
    (w.strong_days || 0.20) * strongScore +
    (w.volume_shrink || 0.20) * volScore +
    (w.retrace_quality || 0.20) * retQual +
    (w.stabilizing || 0.15) * stabScore
  );

  // ── P0: 催化剂调整 ───────────────────────────────────
  const catalyst = marketCtx.catalyst || {};
  // 机构净买入加分
  if (catalyst.instNetBuy > 3000) score += 0.08;
  else if (catalyst.instNetBuy > 1000) score += 0.04;
  // 机构净卖出扣分（排除出货）
  if (catalyst.instNetSell > 5000) score -= 0.12;
  // 近5天有龙虎榜涨停相关
  if (catalyst.hasDragonTiger) score += 0.03;

  score = Math.min(1, Math.max(0, score));

  const level = score > 0.85 ? "S" : score > 0.6 ? "A" : "B";

  // ── 选中原因 ────────────────────────────────────────
  const reasons = [];
  reasons.push(`首波大涨${best.peak.toFixed(1)}%（${retraceDays + (best.peakIdx - best.start)}天前启动，${best.limitUpCnt}次涨停）`);
  reasons.push(`回调${retracePct.toFixed(1)}%已${retraceDays}天`);
  reasons.push(`量能缩至峰值${(volRatio * 100).toFixed(0)}%`);
  if (consecutiveVolShrink >= 3) reasons.push(`连续${consecutiveVolShrink}日缩量`);
  if (ampConverge) reasons.push("振幅收敛(即将变盘)");
  if (strongDays >= 3) reasons.push(`首波有${strongDays}日涨幅>5%（强势龙头）`);
  if (stabilizing && ind.curr > ind.ma20) reasons.push("止跌企稳且站上MA20");
  else if (stabilizing) reasons.push("出现止跌信号");
  if (ind.candleType === "hammer") reasons.push("锤子线确认");
  if (ind.candleType === "doji") reasons.push("十字星变盘信号");
  if (ind.noNewLow >= 3) reasons.push("连续3日不创新低");
  if (catalyst.instNetBuy > 3000) reasons.push("机构净买入>3000万");
  if (catalyst.instNetSell > 5000) reasons.push("⚠机构净卖出>5000万");

  // 语义化原因
  const simple = [];
  simple.push(`前期强势拉升${best.peak.toFixed(0)}%${best.limitUpCnt >= 2 ? "，多次涨停资金介入深" : ""}`);
  simple.push(`已回调${retracePct.toFixed(0)}%共${retraceDays}天，调整较为充分`);
  if (volRatio < 0.4) simple.push("成交量极度萎缩，洗盘接近尾声");
  else if (volRatio < 0.6) simple.push("成交量明显缩小，抛压减轻");
  if (consecutiveVolShrink >= 3) simple.push(`连续${consecutiveVolShrink}天缩量，浮筹已基本清洗`);
  if (ampConverge) simple.push("近期振幅收窄，随时可能再度拉升");
  if (stabilizing && ind.curr > ind.ma20) simple.push("已止跌企稳且站上关键均线，二波启动信号明确");
  else if (stabilizing) simple.push("出现止跌企稳信号");
  if (ind.candleType === "hammer") simple.push("出现锤子线经典反转形态");
  if (ind.candleType === "doji") simple.push("十字星出现，短期变盘概率大");
  if (ind.noNewLow >= 3) simple.push("连续3日不创新低，底部确认");
  if (catalyst.instNetBuy > 3000) simple.push("机构席位大额买入，主力看好");
  if (catalyst.instNetSell > 5000) simple.push("警惕：机构在大量卖出，建议回避");
  const simpleReason = simple.slice(0, 3).join("；");

  let confidence = Math.round(score * 100);
  if (stabilizing) confidence = Math.min(100, confidence + 5);
  if (ind.candleType === "hammer" || ind.candleType === "doji") confidence = Math.min(100, confidence + 3);
  if (catalyst.instNetBuy > 3000) confidence = Math.min(100, confidence + 8);
  if (catalyst.instNetSell > 5000) confidence = Math.max(0, confidence - 15);

  return {
    code: stock.code,
    name: stock.name,
    price: stock.price,
    score: +(score * 100).toFixed(0),
    level,
    confidence,
    reason: reasons.join("，"),
    simpleReason,
    firstWave: best.peak.toFixed(1) + "%",
    limitUpCnt: best.limitUpCnt,
    retrace: retracePct.toFixed(1) + "%",
    retraceDays,
    waveHigh: best.waveHigh.toFixed(2),
    volRatio: (volRatio * 100).toFixed(0) + "%",
    strongDays,
    trend: ind.trendLabel,
    ma5: ind.ma5.toFixed(2), ma10: ind.ma10.toFixed(2), ma20: ind.ma20.toFixed(2),
    stabilizing: stabilizing ? "企稳中" : "待确认",
    wChg: ind.wChg.toFixed(1) + "%",
    mChg: ind.mChg.toFixed(1) + "%",
    turn: stock.turnoverPct, pe: stock.peTtm, mcap: stock.mcapYi,
  };
}
