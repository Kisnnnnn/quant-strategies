/**
 * 指标计算层 — 兼容两种K线格式：
 *   - 百度: 自带 ma5avgprice/ma10avgprice/ma20avgprice
 *   - 东财/mootdx: 仅OHLCV，本地计算MA
 */

function sma(arr, window, offset = 0) {
  const end = arr.length - offset;
  if (end - window < 0) return null;
  let sum = 0;
  for (let i = end - window; i < end; i++) sum += arr[i];
  return sum / window;
}

function ema(arr, window) {
  if (arr.length < window) return null;
  const k = 2 / (window + 1);
  let ema = arr[0];
  for (let i = 1; i < arr.length; i++) ema = arr[i] * k + ema * (1 - k);
  return ema;
}

function detectCandle(row) {
  const { open, close, high, low } = row;
  const body = Math.abs(+close - +open);
  const range = +high - +low;
  const upperWick = +high - Math.max(+close, +open);
  const lowerWick = Math.min(+close, +open) - +low;
  const bodyRatio = range > 0 ? body / range : 0;

  // 十字星: 实体很小, 上下影线
  if (bodyRatio < 0.1) return "doji";
  // 锤子线: 小实体 + 长下影 (>2倍实体+上影很短)
  if (lowerWick > body * 2 && upperWick < body * 0.5) return "hammer";
  // 看涨吞没前提: 收阳
  if (+close > +open) return "bullish";
  // 大阴线
  if (+close < +open && bodyRatio > 0.5 && +close < +open) return "big_bear";
  return "normal";
}

export function calcIndicators(rows, stratCfg = {}) {
  if (!rows?.length || rows.length < 40) return null;

  const len = rows.length;
  const last = rows[len - 1];
  const curr = +last.close;
  const prev = +rows[len - 2].close;

  const closes = rows.map(r => +r.close);
  const highs = rows.map(r => +r.high);
  const lows = rows.map(r => +r.low);
  const vols = rows.map(r => +r.volume);

  // 均线：优先用百度自带字段，否则本地计算
  const ma5 = last.ma5avgprice && last.ma5avgprice !== "--" ? +last.ma5avgprice : sma(closes, 5);
  const ma10 = last.ma10avgprice && last.ma10avgprice !== "--" ? +last.ma10avgprice : sma(closes, 10);
  const ma20 = last.ma20avgprice && last.ma20avgprice !== "--" ? +last.ma20avgprice : sma(closes, 20);
  if (!ma5 || !ma10 || !ma20) return null;

  // 均线斜率: 优先用百度历史字段，否则本地计算
  const ma20Prev5Row = rows[len - 6];
  let ma20Prev5 = null;
  if (ma20Prev5Row?.ma20avgprice && ma20Prev5Row.ma20avgprice !== "--") {
    ma20Prev5 = +ma20Prev5Row.ma20avgprice;
  } else {
    ma20Prev5 = sma(closes.slice(0, -5), 20);
  }

  const curVol = vols[len - 1];
  const avg5Vol = mean(vols.slice(-6, -1));
  const avg20Vol = mean(vols.slice(-21, -1));

  const distMA5 = ((curr - ma5) / ma5) * 100;
  const distMA10 = ((curr - ma10) / ma10) * 100;
  const distMA20 = ((curr - ma20) / ma20) * 100;
  const ma20Slope5 = ma20Prev5 ? (ma20 / ma20Prev5 - 1) * 100 : 0;

  const trendLabel = getTrendLabel(curr, ma5, ma10, ma20);
  const trendOK = curr > ma20 && ma20Slope5 >= 0;

  const high20 = Math.max(...highs.slice(-21, -1));
  const drawdownFrom20High = high20 > 0 ? (curr / high20 - 1) * 100 : 0;

  const priceRange = (+last.high || curr) - (+last.low || curr);
  const closePosition = priceRange === 0 ? 0.5 : (curr - (+last.low || curr)) / priceRange;

  const volRatio5 = avg5Vol > 0 ? curVol / avg5Vol : 1;
  const volRatio20 = avg20Vol > 0 ? curVol / avg20Vol : 1;
  const volShrinking = volRatio5 < 0.8;

  const wChg = len >= 6 ? ((curr - closes[len - 6]) / closes[len - 6]) * 100 : 0;
  const mChg = len >= 21 ? ((curr - closes[len - 21]) / closes[len - 21]) * 100 : 0;

  // 布林带 (20,2)
  const bbMid = ma20;
  let bbWidth = 0, bbLower = bbMid, bbUpper = bbMid;
  if (closes.length >= 20) {
    const slice = closes.slice(-20);
    const mean = slice.reduce((a, b) => a + b, 0) / 20;
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / 20;
    const std = Math.sqrt(variance);
    bbWidth = (std * 4) / mean; // 带宽
    bbLower = bbMid - 2 * std;
    bbUpper = bbMid + 2 * std;
  }

  // K线形态
  const candleType = detectCandle(last);
  const prevCandle = detectCandle(rows[len - 2]);

  // 近5日量价分析
  let heavyVolDrop = false;
  let consecutiveVolShrink = 0;
  for (let i = 1; i <= 5 && len - 1 - i >= 0; i++) {
    const r = rows[len - 1 - i];
    const dayVol = vols[len - 1 - i];
    const dayChg = ((+r.close - +r.open) / +r.open) * 100;
    // 放量大阴线: 量>均量2倍 且 跌幅>5%
    if (dayVol > avg20Vol * 2 && dayChg < -5) heavyVolDrop = true;
    // 连续缩量: vol[i] < vol[i-1]
    if (i < 5 && dayVol < vols[len - 1 - i - 1]) consecutiveVolShrink++;
    else if (i < 5 && consecutiveVolShrink < 3) consecutiveVolShrink = 0;
  }

  // 近3天最低价是否持续不创新低（止跌确认）
  let noNewLow = 0;
  for (let i = 1; i <= 3 && len - 1 - i >= 0; i++) {
    if (lows[len - 1 - i] > lows[len - 1 - i - 1]) noNewLow++;
  }

  // 近15天涨停日统计
  let limitUpDays = 0;
  for (let i = 1; i <= 15 && len - 1 - i >= 0; i++) {
    const r = rows[len - 1 - i];
    const chg = ((+r.close - +r.open) / +r.open) * 100;
    if (chg > 9.8) limitUpDays++;
  }

  return {
    curr, prev, ma5, ma10, ma20,
    distMA5, distMA10, distMA20,
    ma20Slope5, trendLabel, trendOK,
    high20, drawdownFrom20High, closePosition,
    curVol, avg5Vol, avg20Vol, volRatio5, volRatio20, volShrinking,
    wChg, mChg,
    bbMid, bbLower, bbUpper, bbWidth,
    candleType, prevCandle,
    heavyVolDrop, consecutiveVolShrink,
    noNewLow, limitUpDays,
    closes, highs, lows, vols,
    raw: { last, rows, len },
  };
}

function getTrendLabel(curr, ma5, ma10, ma20) {
  if (curr > ma5 && ma5 > ma10 && ma10 > ma20) return "大多头";
  if (curr > ma5 && curr > ma10 && curr > ma20 && ma5 > ma10) return "多头排列";
  if (curr > ma10 && curr > ma20) return "多头";
  if (curr > ma20) return "震荡偏多";
  return "弱势";
}

function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}
