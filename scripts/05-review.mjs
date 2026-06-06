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

let _m = null;
async function getMod() {
  if (!_m) _m = await import(STOCK_DATA);
  return _m;
}

// 用户持仓（从 portfolio.json 读取）
const PF_FILE = join(OUT, "portfolio.json");
const PORTFOLIO = existsSync(PF_FILE) ? JSON.parse(readFileSync(PF_FILE, "utf-8")) : [];

function fmt(n, d = 2) { return typeof n === "number" ? n.toFixed(d) : n; }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKLine(code) {
  const prefix = code.startsWith("6") ? "sh" : "sz";
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${prefix}${code},day,,,60,qfq`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
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
  const curr = closes[len - 1];
  const prev = closes[len - 2];
  const dayChg = ((curr - prev) / prev) * 100;
  const wChg = len >= 5 ? ((closes[len - 1] - closes[len - 5]) / closes[len - 5]) * 100 : 0;
  const mChg = len >= 20 ? ((closes[len - 1] - closes[len - 20]) / closes[len - 20]) * 100 : 0;
  const distMA20 = ((curr - ma20) / ma20) * 100;
  const trend = ma5 > ma10 && ma10 > ma20 ? "多头排列" : curr > ma20 ? "偏多" : curr > ma10 ? "震荡" : "偏弱";

  // Recent volume trend
  const vols = rows.slice(-5).map(r => r.volume);
  const volTrend = vols[4] < vols[0] * 0.7 ? "缩量" : vols[4] > vols[0] * 1.5 ? "放量" : "平量";

  // High/low in last 20 days
  const highs20 = rows.slice(-20).map(r => r.high);
  const lows20 = rows.slice(-20).map(r => r.low);
  const nearHigh20 = ((Math.max(...highs20) - curr) / Math.max(...highs20)) * 100;
  const nearLow20 = ((curr - Math.min(...lows20)) / Math.min(...lows20)) * 100;

  return { ma5: fmt(ma5), ma10: fmt(ma10), ma20: fmt(ma20), distMA20: fmt(distMA20, 1), trend, dayChg: fmt(dayChg, 1), wChg: fmt(wChg, 1), mChg: fmt(mChg, 1), volTrend, nearHigh20: fmt(nearHigh20, 1), nearLow20: fmt(nearLow20, 1) };
}

async function main() {
  const m = await getMod();
  const now = new Date().toLocaleString("zh-CN", { hour12: false });
  const today = new Date().toISOString().slice(0, 10);
  const log = console.log;

  log(`\n${"=".repeat(60)}`);
  log(`  持仓复盘分析 — ${now}`);
  log(`${"=".repeat(60)}\n`);

  const report = { date: today, generatedAt: now };

  // ── 1. 大盘 ──────────────────────────────────────
  log("1/3 大盘数据...");
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

    // 热门题材
    if (hotReasons?.length) {
      const reasonMap = new Map();
      for (const r of hotReasons.slice(0, 30)) {
        const tags = (r.reason || "").split(/[,，、]/).map(t => t.trim()).filter(Boolean);
        for (const t of tags) reasonMap.set(t, (reasonMap.get(t) || 0) + 1);
      }
      report.market.hotTopics = [...reasonMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, n]) => ({ topic: t, count: n }));
    }
    log(`  情绪: ${report.market.sentiment} | 涨跌比: ${report.market.advDecRatio} | 北向: ${report.market.northbound?.total ?? "?"}亿`);
  } catch (e) { log("  大盘数据失败:", e.message); }

  // ── 2. 持仓行情 ──────────────────────────────────
  log("2/3 持仓数据...");
  const codes = PORTFOLIO.map(p => p.code);
  if (!codes.length) {
    log("  暂无持仓数据，请先在 portfolio.json 添加股票");
  }
  let quotes = {};
  try {
    quotes = await m.tencentQuote(codes);
  } catch (e) { log("  行情获取失败:", e.message); }

  // 逐个拉K线 + 龙虎榜 + 新闻
  const holdings = [];
  for (const p of PORTFOLIO) {
    process.stderr.write(".");
    const q = quotes[p.code];
    if (!q) { holdings.push({ ...p, error: "行情获取失败" }); continue; }

    const h = { code: p.code, name: q.name, price: q.price, changePct: q.changePct, pe: q.peTtm, pb: q.pb, mcap: q.mcapYi, turnover: q.turnoverPct, amount: q.amountWan };

    // K线
    try {
      const rows = await fetchKLine(p.code);
      h.kline = analyzeKLine(rows);
    } catch { /* skip */ }

    // 资金流向（近120日）
    try {
      const flows = await m.stockFundFlow120d(p.code);
      if (flows?.length) {
        const sum = (arr, key, n) => arr.slice(-n).reduce((s, f) => s + (f[key] || 0), 0);
        h.fundFlow = {
          today: flows[flows.length - 1],
          main3d: sum(flows, 'mainNet', 3),
          main5d: sum(flows, 'mainNet', 5),
          main10d: sum(flows, 'mainNet', 10),
          main20d: sum(flows, 'mainNet', 20),
        };
        let consDays = 0;
        for (let i = flows.length - 1; i >= 0; i--) {
          if ((flows[i].mainNet > 0) === (flows[flows.length - 1].mainNet > 0)) consDays++;
          else break;
        }
        h.fundFlow.consDays = consDays;
        h.fundFlow.consDir = flows[flows.length - 1].mainNet > 0 ? '流入' : '流出';
      }
    } catch { /* skip */ }

    // 龙虎榜（近30天）
    try {
      const dt = await m.dragonTigerBoard(p.code, today, 30);
      if (dt?.records?.length) {
        const allSeats = [
          ...(dt.seats?.buy || []).map(s => ({ ...s, side: "buy" })),
          ...(dt.seats?.sell || []).map(s => ({ ...s, side: "sell" })),
        ];
        h.dragonTiger = {
          count: dt.records.length,
          latest: dt.records.slice(0, 3).map(r => ({ date: r.date, reason: r.reason, netBuy: r.netBuy, turnover: r.turnover })),
          seats: allSeats,
          institution: dt.institution || null,
        };
      }
    } catch { /* skip */ }

    // 概念板块
    try {
      const cb = await m.eastmoneyConceptBlocks(p.code);
      if (cb?.conceptTags?.length) {
        h.conceptTags = cb.conceptTags.slice(0, 6);
        h.mainSector = (cb.boards || [])[0];
      }
    } catch { /* skip */ }

    // 近期新闻
    try {
      const news = await m.eastmoneyStockNews(p.code, 3);
      if (news?.length) {
        h.recentNews = news.slice(0, 2).map(n => ({ title: n.title || "", date: (n.time || "").slice(0, 10), source: n.source || "", url: n.url || "" }));
      }
    } catch { /* skip */ }

    // 研报（最新5份）
    try {
      const reports = await m.eastmoneyReports(p.code, 1);
      if (reports?.length) {
        const recent = reports
          .filter(r => r.predictThisYearEps || r.predictNextYearEps)
          .slice(0, 5)
          .map(r => ({
            date: (r.publishDate || "").slice(0, 10),
            org: r.orgSName || "",
            rating: r.emRatingName || "",
            eps1: r.predictThisYearEps ? +r.predictThisYearEps : null,
            eps2: r.predictNextYearEps ? +r.predictNextYearEps : null,
            eps3: r.predictNextTwoYearEps ? +r.predictNextTwoYearEps : null,
            targetPrice: r.indvAimPriceT ? +r.indvAimPriceT : null,
          }));
        if (recent.length) {
          // 平均目标价
          const targets = recent.filter(r => r.targetPrice).map(r => r.targetPrice);
          const avgEps1 = recent.filter(r => r.eps1).reduce((s, r) => s + r.eps1, 0) / (recent.filter(r => r.eps1).length || 1);
          const avgEps2 = recent.filter(r => r.eps2).reduce((s, r) => s + r.eps2, 0) / (recent.filter(r => r.eps2).length || 1);
          h.reports = {
            items: recent,
            avgTarget: targets.length ? +(targets.reduce((a, b) => a + b, 0) / targets.length).toFixed(2) : null,
            highTarget: targets.length ? Math.max(...targets) : null,
            lowTarget: targets.length ? Math.min(...targets) : null,
            avgEps1: +avgEps1.toFixed(2),
            avgEps2: +avgEps2.toFixed(2),
            consensusRating: recent[0]?.rating || "",
          };
        }
      }
    } catch { /* skip */ }

    await delay(200); // 东财限流
    holdings.push(h);
  }
  process.stderr.write("\n");

  // 按涨跌排序
  holdings.sort((a, b) => (b.changePct || 0) - (a.changePct || 0));
  report.holdings = holdings;

  // ── 3. 持仓龙虎榜汇总 ─────────────────────────────
  const dtHoldings = holdings.filter(h => h.dragonTiger);
  if (dtHoldings.length) {
    report.dragonAlert = dtHoldings.map(h => ({
      code: h.code, name: h.name,
      count: h.dragonTiger.count,
      latest: h.dragonTiger.latest,
      seats: h.dragonTiger.seats,
      institution: h.dragonTiger.institution,
    }));
    log(`  持仓龙虎榜: ${dtHoldings.length}只近期上榜`);
  }

  // 持仓统计
  const upCount = holdings.filter(h => h.changePct > 0).length;
  const downCount = holdings.filter(h => h.changePct < 0).length;
  const avgChg = holdings.length ? (holdings.reduce((s, h) => s + (h.changePct || 0), 0) / holdings.length) : 0;
  const totalMcap = holdings.reduce((s, h) => s + (h.mcap || 0), 0);
  report.summary = {
    total: holdings.length,
    up: upCount, down: downCount,
    avgChg: fmt(avgChg, 2),
    totalMcap: fmt(totalMcap, 0),
    topGainer: holdings[0] ? `${holdings[0].name} +${fmt(holdings[0].changePct)}%` : "-",
    topLoser: holdings[holdings.length - 1] ? `${holdings[holdings.length - 1].name} ${fmt(holdings[holdings.length - 1].changePct)}%` : "-",
  };

  log(`3/3 输出...`);
  log(`  持仓: ${upCount}涨${downCount}跌 | 均涨幅: ${report.summary.avgChg}% | 总市值: ${report.summary.totalMcap}亿`);

  // ── 输出 ──────────────────────────────────────────
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const outFile = join(OUT, `review-${today}.json`);
  writeFileSync(outFile, JSON.stringify(report, null, 2), "utf-8");
  log(`\n复盘报告已保存: ${outFile}`);
  log(`${"=".repeat(60)}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
