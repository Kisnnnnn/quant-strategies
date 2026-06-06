/**
 * 波段回调信号生成 V2
 *
 * 逻辑：
 *   1. 趋势确认：close > MA20 且 MA20 上行
 *   2. 回踩到位：离20日线距离在阈值内
 *   3. 假信号排除：放量大阴线 · 板块逆势
 *   4. 动态权重：趋势市偏好趋势，震荡市偏好贴线+缩量
 *   5. 加分项：布林下轨支撑 · 连续缩量 · 锤子线 · 板块共振
 */

export function generateBandSignals(stock, indicators, stratCfg = {}, marketCtx = {}) {
  const ind = indicators;
  if (!ind?.trendOK) return null;

  const p = stratCfg.pullback || {};
  const maxDist = p.max_dist_ma20_pct ?? 5;

  const nearMA20 = Math.abs(ind.distMA20) <= maxDist;
  if (!nearMA20) return null;

  // ── P0: 排除假信号 ──────────────────────────────────

  // 放量大阴线（出货特征）
  if (ind.heavyVolDrop) return null;

  // 板块强度过滤：个股所属板块涨跌幅不能太差
  const sectorFilter = stratCfg.filters?.sector || {};
  const minSectorPct = sectorFilter.min_sector_change_pct ?? -5;
  if (marketCtx.sectorChangePct != null && marketCtx.sectorChangePct < minSectorPct) return null;

  // ── 信号标签 ────────────────────────────────────────
  const signals = [];
  if (ind.volShrinking) signals.push("缩量");
  if (ind.consecutiveVolShrink >= 3) signals.push("连缩" + ind.consecutiveVolShrink + "日");
  if (ind.curr > ind.prev) signals.push("收阳");
  if (ind.distMA20 > -2 && ind.distMA20 < 3) signals.push("贴20线");
  if (ind.volRatio5 > 1.2) signals.push("放量");
  if (ind.ma5 > ind.ma10 && ind.ma10 > ind.ma20) signals.push("多排");
  if (ind.curr > ind.bbLower && ind.curr <= ind.bbMid) signals.push("布林下轨支撑");
  if (ind.candleType === "hammer") signals.push("锤子线");
  if (ind.candleType === "doji") signals.push("十字星");
  if (ind.noNewLow >= 3) signals.push("止跌确认");

  // ── 质量等级 ────────────────────────────────────────
  let quality = "B";
  if (ind.ma5 > ind.ma10 && ind.ma10 > ind.ma20) quality = "S";
  else if (ind.curr > ind.ma10 && ind.curr > ind.ma20 && ind.curr > ind.ma5) quality = "A";

  // ── P2: 动态权重（按市场情绪调整）────────────────────
  const advDec = marketCtx.advDecRatio;
  const isTrendMarket = advDec > 2;     // 趋势市
  const isRangeMarket = advDec >= 0.5;  // 正常/震荡

  let wTrend, wDist, wVol, wPrice, wLiq;
  if (isTrendMarket) {
    // 趋势市：趋势质量+价格形态更重要
    wTrend = 0.35; wDist = 0.20; wVol = 0.15; wPrice = 0.20; wLiq = 0.10;
  } else if (isRangeMarket) {
    // 震荡市：贴线距离+缩量更重要
    wTrend = 0.25; wDist = 0.30; wVol = 0.25; wPrice = 0.10; wLiq = 0.10;
  } else {
    // 弱势：保守，缩量+贴线权重最高
    wTrend = 0.20; wDist = 0.30; wVol = 0.30; wPrice = 0.10; wLiq = 0.10;
  }

  // ── 评分 ────────────────────────────────────────────
  const trendScore = quality === "S" ? 1 : quality === "A" ? 0.7 : 0.3;
  const distScore = Math.max(0, 1 - Math.abs(ind.distMA20) / maxDist);
  // 量能得分：连续缩量 > 单日缩量 > 平量
  let volScore = 0.2;
  if (ind.consecutiveVolShrink >= 3) volScore = 1;
  else if (ind.volShrinking) volScore = 0.8;
  else if (ind.volRatio5 < 1.1) volScore = 0.5;
  // 价格得分：收阳+锤子线加分
  let priceScore = ind.curr > ind.prev ? 0.7 : 0.3;
  if (ind.candleType === "hammer" || ind.candleType === "doji") priceScore = 1;
  // 流动性
  const liqScore = Math.min(1, (stock.turnoverPct || 0) / 10);

  let score = (
    wTrend * trendScore + wDist * distScore + wVol * volScore +
    wPrice * priceScore + wLiq * liqScore
  );

  // 板块共振加分（板块>0 +5分）
  if (marketCtx.sectorChangePct > 0) score += 0.05;
  // 布林下轨支撑加分
  if (ind.curr > ind.bbLower && ind.curr <= ind.bbMid) score += 0.03;

  score = Math.min(1, Math.max(0, score));

  // ── 选中原因 ────────────────────────────────────────
  const reasons = [];
  if (ind.ma5 > ind.ma10 && ind.ma10 > ind.ma20) reasons.push("均线多头排列(MA5>MA10>MA20)");
  else if (ind.curr > ind.ma10 && ind.curr > ind.ma20) reasons.push("站上MA10/MA20");
  if (ind.consecutiveVolShrink >= 3) reasons.push(`连续${ind.consecutiveVolShrink}日缩量`);
  else if (ind.volShrinking) reasons.push("缩量止跌");
  if (ind.curr > ind.prev) reasons.push("收阳企稳");
  if (Math.abs(ind.distMA20) <= 3) reasons.push(`紧贴20日均线(偏离${ind.distMA20.toFixed(1)}%)`);
  if (ind.ma20Slope5 > 0) reasons.push("20日线趋势上行");
  if (ind.candleType === "hammer") reasons.push("锤子线止跌信号");
  if (ind.candleType === "doji") reasons.push("十字星变盘信号");
  if (ind.noNewLow >= 3) reasons.push("连续3日不创新低");
  if (marketCtx.sectorChangePct > 0) reasons.push("板块共振上行");
  if (marketCtx.marketLabel) reasons.push(`市场:${marketCtx.marketLabel}`);

  // 语义化原因
  const simple = [];
  if (ind.ma5 > ind.ma10 && ind.ma10 > ind.ma20) simple.push("上升趋势良好，均线向上发散");
  else if (ind.curr > ind.ma10 && ind.curr > ind.ma20) simple.push("股价站稳关键均线，趋势转好");
  if (ind.consecutiveVolShrink >= 3) simple.push("卖盘持续萎缩，抛压已近尾声");
  else if (ind.volShrinking) simple.push("成交量萎缩，下跌动能不足");
  if (ind.curr > ind.prev) simple.push("今日收阳，开始止跌回升");
  if (Math.abs(ind.distMA20) <= 3) simple.push("股价回调至20日均线支撑位附近");
  if (ind.candleType === "hammer") simple.push("出现经典锤子线，底部反转概率大");
  if (ind.candleType === "doji") simple.push("十字星出现，短期即将选择方向");
  if (ind.noNewLow >= 3) simple.push("连续3日不创新低，底部已确认");
  if (marketCtx.sectorChangePct > 0) simple.push("所属板块同步走强，增加成功率");
  const simpleReason = simple.slice(0, 3).join("；");

  let confidence = Math.round(score * 100);
  if (marketCtx.advDecRatio < 0.5) confidence = Math.max(0, confidence - 8);
  else if (marketCtx.advDecRatio > 2) confidence = Math.min(100, confidence + 5);

  return {
    code: stock.code,
    name: stock.name,
    price: stock.price,
    quality,
    confidence,
    score: +(score * 100).toFixed(0),
    trend: ind.trendLabel,
    reason: reasons.join("，"),
    simpleReason,
    ma5: ind.ma5.toFixed(2), ma10: ind.ma10.toFixed(2), ma20: ind.ma20.toFixed(2),
    distMA20: ind.distMA20.toFixed(1) + "%",
    distMA5: ind.distMA5.toFixed(1) + "%",
    volShrink: ind.volShrinking ? "是" : "否",
    volRatio: ind.volRatio5.toFixed(1) + "x",
    closePos: (ind.closePosition * 100).toFixed(0) + "%",
    signals: signals.join("·"),
    wChg: ind.wChg.toFixed(1) + "%",
    mChg: ind.mChg.toFixed(1) + "%",
    turn: stock.turnoverPct, pe: stock.peTtm, mcap: stock.mcapYi,
  };
}
