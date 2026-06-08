/**
 * 日度复盘分析 — 大盘 + 个人持仓
 * 用法: node scripts/05-review.mjs
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, "..");
const STOCK_DATA = join(PROJECT, "../chaogu/stock-data.mjs");
const OUT = join(PROJECT, "outputs");
const UA = "Mozilla/5.0";

let _m = null;
async function getMod() {
  if (!_m) _m = await import(STOCK_DATA);
  return _m;
}

const PF_FILE = join(OUT, "portfolio.json");
const PORTFOLIO = existsSync(PF_FILE) ? JSON.parse(readFileSync(PF_FILE, "utf-8")) : [];

function fmt(n, d = 2) { return typeof n === "number" ? +n.toFixed(d) : n; }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 腾讯实时行情 ──────────────────────────────────────
async function fetchQuotes(codes) {
  const prefix = c => c.startsWith("6") || c.startsWith("9") ? "sh" : "sz";
  const symbols = codes.map(c => `${prefix(c)}${c}`).join(",");
  const url = `https://qt.gtimg.cn/q=${symbols}`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    const text = await r.text();
    const data = {};
    for (const line of text.split(/;\s*\n?/)) {
      const m = line.match(/v_(\w+)="(.+)"/);
      if (!m) continue;
      const fields = m[2].split("~");
      const code = fields[2];
      if (!code || !codes.includes(code)) continue;
      data[code] = {
        name: fields[1],
        price: +fields[3] || 0,
        prevClose: +fields[4] || 0,
        open: +fields[5] || 0,
        volume: +fields[6] || 0,
        changePct: fields[3] && fields[4] ? +(((fields[3] - fields[4]) / fields[4]) * 100).toFixed(2) : 0,
        peTtm: +fields[39] || 0,
        pb: +fields[46] || 0,
        mcapYi: fields[45] ? +(fields[45] / 1e4).toFixed(1) : 0,
        turnoverPct: +fields[38] || 0,
        high: +fields[33] || 0,
        low: +fields[34] || 0,
        amountWan: fields[37] ? +(fields[37] / 1e4).toFixed(0) : 0,
      };
    }
    return data;
  } catch (e) { console.error("行情获取失败:", e.message); return {}; }
}

// ── 腾讯K线 ───────────────────────────────────────────
async function fetchKLine(code) {
  const prefix = code.startsWith("6") ? "sh" : "sz";
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${prefix}${code},day,,,60,qfq`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    const d = await r.json();
    const key = `${prefix}${code}`;
    const rows = d?.data?.[key]?.qfqday || d?.data?.[key]?.day || [];
    if (!rows.length) return null;
    return rows.map(row => ({
      date: row[0], open: +row[1], close: +row[2], high: +row[3], low: +row[4], volume: +row[5] || 0,
    }));
  } catch { return null; }
}

function analyzeKLine(rows) {
  if (!rows || rows.length < 20) return null;
  const len = rows.length;
  const closes = rows.map(r => r.close);
  const sma = (arr, w) => { const s = arr.slice(-w); return s.reduce((a, b) => a + b, 0) / w; };
  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);
  const ma60 = len >= 60 ? sma(closes, 60) : null;
  const curr = closes[len - 1];
  const prev = closes[len - 2];
  const dayChg = ((curr - prev) / prev) * 100;
  const wChg = len >= 5 ? ((closes[len - 1] - closes[len - 5]) / closes[len - 5]) * 100 : 0;
  const mChg = len >= 20 ? ((closes[len - 1] - closes[len - 20]) / closes[len - 20]) * 100 : 0;

  const aboveMA20 = curr > ma20;
  const aboveMA60 = ma60 ? curr > ma60 : null;
  let trend;
  if (ma5 > ma10 && ma10 > ma20) trend = "多头排列";
  else if (curr > ma20 && ma20 > (ma60 || ma20)) trend = "偏多";
  else if (curr > ma10) trend = "震荡";
  else trend = "偏弱";

  const vols = rows.slice(-5).map(r => r.volume);
  const avgVol5 = vols.reduce((a, b) => a + b, 0) / 5;
  const avgVol20 = rows.slice(-20).reduce((s, r) => s + r.volume, 0) / 20;
  const volRatio = avgVol20 > 0 ? +(avgVol5 / avgVol20).toFixed(1) : 1;
  const volTrend = avgVol5 < avgVol20 * 0.7 ? "缩量" : avgVol5 > avgVol20 * 1.5 ? "放量" : "平量";

  const highs20 = rows.slice(-20).map(r => r.high);
  const lows20 = rows.slice(-20).map(r => r.low);
  const high20 = Math.max(...highs20);
  const low20 = Math.min(...lows20);
  const nearHigh20 = ((high20 - curr) / high20) * 100;
  const nearLow20 = ((curr - low20) / low20) * 100;
  const distMA20 = ((curr - ma20) / ma20) * 100;
  const distMA60 = ma60 ? ((curr - ma60) / ma60) * 100 : null;

  // 支撑/压力位
  const support = +low20.toFixed(2);
  const resistance = +high20.toFixed(2);

  return {
    ma5: fmt(ma5), ma10: fmt(ma10), ma20: fmt(ma20), ma60: ma60 ? fmt(ma60) : null,
    distMA20: fmt(distMA20, 1), distMA60: distMA60 != null ? fmt(distMA60, 1) : null,
    trend, dayChg: fmt(dayChg, 1), wChg: fmt(wChg, 1), mChg: fmt(mChg, 1),
    volTrend, volRatio,
    nearHigh20: fmt(nearHigh20, 1), nearLow20: fmt(nearLow20, 1),
    support, resistance,
    aboveMA20, aboveMA60,
  };
}

// ── 个股判断 ──────────────────────────────────────────
function judge(holding) {
  const k = holding.kline;
  if (!k) return { verdict: "数据不足", color: "#64748b", summary: "K线数据获取失败" };

  const lines = [];
  let score = 50;

  // 趋势判断
  if (k.trend === "多头排列") { score += 15; lines.push("均线多头排列，趋势强劲"); }
  else if (k.trend === "偏多") { score += 8; lines.push("站上20日线，中期偏多"); }
  else if (k.trend === "震荡") { score -= 2; lines.push("均线缠绕，方向不明"); }
  else { score -= 12; lines.push("趋势偏弱，受均线压制"); }

  // 量能判断
  if (k.volRatio > 1.5) { score += 5; lines.push("放量(量比" + k.volRatio + ")，资金活跃"); }
  else if (k.volRatio < 0.7) { score -= 3; lines.push("缩量(量比" + k.volRatio + ")，交投清淡"); }

  // 位置判断
  if (k.nearHigh20 < 5) { score -= 5; lines.push("接近20日高点(距" + k.nearHigh20 + "%)，追高风险"); }
  if (k.nearLow20 < 5) { score += 5; lines.push("接近20日低点(距" + k.nearLow20 + "%)，支撑附近"); }

  // 短期动量
  if (k.wChg > 10) { score += 3; lines.push("近5日涨幅" + k.wChg + "%，短期强势"); }
  else if (k.wChg < -5) { score -= 5; lines.push("近5日跌" + k.wChg + "%，短期弱势"); }

  // MA位置
  if (k.distMA20 > 15) { score -= 5; lines.push("偏离20日线" + k.distMA20 + "%，超买"); }
  if (k.distMA20 < -10) { score += 3; lines.push("低于20日线" + k.distMA20 + "%，超卖"); }

  score = Math.max(10, Math.min(95, score));

  let verdict, color;
  if (score >= 70) { verdict = "偏多"; color = "#16a34a"; }
  else if (score >= 55) { verdict = "震荡偏多"; color = "#84cc16"; }
  else if (score >= 45) { verdict = "中性"; color = "#64748b"; }
  else if (score >= 30) { verdict = "震荡偏空"; color = "#d97706"; }
  else { verdict = "偏空"; color = "#dc2626"; }

  return { verdict, color, score, summary: lines.join("；"), lines };
}

async function main() {
  const now = new Date().toLocaleString("zh-CN", { hour12: false });
  const today = new Date().toISOString().slice(0, 10);
  const log = console.log;

  log(`\n${"=".repeat(60)}`);
  log(`  持仓复盘分析 — ${now}`);
  log(`${"=".repeat(60)}\n`);

  const report = { date: today, generatedAt: now, quoteTime: now };

  if (!PORTFOLIO.length) {
    log("暂无持仓，请先在 portfolio.json 添加股票");
    const outFile = join(OUT, `review-${today}.json`);
    writeFileSync(outFile, JSON.stringify({ error: "no holdings" }, null, 2), "utf-8");
    log(`复盘报告已保存: ${outFile}`);
    return;
  }

  // ── 1. 大盘 ──────────────────────────────────────────
  log("1/3 大盘数据...");
  const m = await getMod();
  report.market = {};
  try {
    const [breadth, north, hotReasons] = await Promise.all([
      m.getMarketBreadth(),
      m.hsgtRealtime().catch(() => null),
      m.thsHotReason().catch(() => null),
    ]);
    const hgt = north?.hgt?.filter(v => v != null).pop() ?? null;
    const sgt = north?.sgt?.filter(v => v != null).pop() ?? null;
    report.market = {
      advDecRatio: breadth?.advDecRatio ?? "-",
      sentiment: breadth?.sentiment ?? "-",
      advancing: breadth?.advancing ?? 0,
      declining: breadth?.declining ?? 0,
      flat: breadth?.flat ?? 0,
      northbound: { hgt, sgt, total: (hgt != null && sgt != null) ? +(hgt + sgt).toFixed(1) : null },
    };
    if (hotReasons?.length) {
      const reasonMap = new Map();
      for (const r of hotReasons.slice(0, 30)) {
        const tags = (r.reason || "").split(/[,，、]/).map(t => t.trim()).filter(Boolean);
        for (const t of tags) reasonMap.set(t, (reasonMap.get(t) || 0) + 1);
      }
      report.market.hotTopics = [...reasonMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, n]) => ({ topic: t, count: n }));
    }
    log(`  情绪: ${report.market.sentiment} | 涨${report.market.advancing}跌${report.market.declining} | 北向: ${report.market.northbound?.total ?? "?"}亿`);
  } catch (e) { log("  大盘数据失败:", e.message); report.market = { note: "大盘数据暂不可用" }; }

  // ── 2. 持仓行情 + K线分析 ────────────────────────────
  log(`2/3 持仓分析 (${PORTFOLIO.length}只)...`);
  const codes = PORTFOLIO.map(p => p.code);

  // 批量取行情
  const quotes = await fetchQuotes(codes);
  log(`  行情获取: ${Object.keys(quotes).length}/${codes.length} 只`);

  const holdings = [];
  for (const p of PORTFOLIO) {
    process.stderr.write(".");
    const q = quotes[p.code];
    const h = {
      code: p.code, name: p.name, quoteTime: now,
      price: q?.price || null,
      changePct: q?.changePct || null,
      pe: q?.peTtm || null,
      pb: q?.pb || null,
      mcap: q?.mcapYi || null,
      turnover: q?.turnoverPct || null,
      amount: q?.amountWan || null,
      high: q?.high || null,
      low: q?.low || null,
      open: q?.open || null,
      prevClose: q?.prevClose || null,
    };

    // K线分析
    try {
      const rows = await fetchKLine(p.code);
      h.kline = analyzeKLine(rows);
    } catch { /* skip */ }

    // 综合判断
    h.judgment = judge(h);

    await delay(80);
    holdings.push(h);
  }
  process.stderr.write("\n");

  // 按涨跌排序
  holdings.sort((a, b) => (b.changePct || 0) - (a.changePct || 0));
  report.holdings = holdings;

  // ── 3. 统计 ──────────────────────────────────────────
  const validHoldings = holdings.filter(h => h.price != null);
  const upCount = validHoldings.filter(h => h.changePct > 0).length;
  const downCount = validHoldings.filter(h => h.changePct < 0).length;
  const avgChg = validHoldings.length ? (validHoldings.reduce((s, h) => s + (h.changePct || 0), 0) / validHoldings.length) : 0;
  const totalMcap = validHoldings.reduce((s, h) => s + (h.mcap || 0), 0);
  const bullCount = validHoldings.filter(h => h.judgment?.verdict === "偏多").length;
  const bearCount = validHoldings.filter(h => h.judgment?.verdict === "偏空").length;

  report.summary = {
    total: holdings.length, valid: validHoldings.length,
    up: upCount, down: downCount,
    avgChg: fmt(avgChg, 2),
    totalMcap: fmt(totalMcap, 0),
    bullCount, bearCount,
    topGainer: validHoldings[0] ? `${validHoldings[0].name} +${fmt(validHoldings[0].changePct)}%` : "-",
    topLoser: validHoldings[validHoldings.length - 1] ? `${validHoldings[validHoldings.length - 1].name} ${fmt(validHoldings[validHoldings.length - 1].changePct)}%` : "-",
  };

  log(`3/3 输出...`);
  log(`  持仓: ${upCount}涨${downCount}跌 | 均涨幅: ${report.summary.avgChg}% | 偏多${bullCount} 偏空${bearCount}`);
  log(`  总市值: ${report.summary.totalMcap}亿`);

  // 逐只打印
  for (const h of validHoldings) {
    const arrow = h.changePct >= 0 ? "↑" : "↓";
    const j = h.judgment;
    log(`  ${h.code} ${h.name} ${h.price} ${arrow}${fmt(h.changePct)}% | ${j?.verdict || "?"} | ${j?.summary || ""}`);
  }

  // ── 输出 ──────────────────────────────────────────────
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const outFile = join(OUT, `review-${today}.json`);
  writeFileSync(outFile, JSON.stringify(report, null, 2), "utf-8");
  log(`\n复盘报告已保存: ${outFile}`);
  log(`${"=".repeat(60)}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
