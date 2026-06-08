/**
 * 回测引擎 — 支持短线信号/波段回调/龙回头三种策略
 *
 * 用法: node scripts/backtest.mjs [strategy] [startDate] [endDate]
 * 示例: node scripts/backtest.mjs short-term 2026-05-01 2026-06-08
 *       node scripts/backtest.mjs band-dip
 *       node scripts/backtest.mjs all
 *
 * 依赖 history/ 目录下的每日扫描快照
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, "..");
const HISTORY = join(PROJECT, "history");
const OUT = join(PROJECT, "outputs");

const STRATEGIES = ["short-term", "band-dip", "dragon-reverse"];

const CFG = {
  maxPositions: 5,
  stopLoss: -0.05,
  takeProfit: 0.10,
  maxHoldDays: 3,
  initialCapital: 100000,
  positionPct: { "main-up": 0.80, "trial": 0.50, "swing": 0.30, "decline": 0.15, "offday": 0.40, "default": 0.30 },
};

// 短线信号用 action 字段，波段/龙回头用 score 阈值
function isBuy(r, strategy) {
  if (strategy === "short-term") return r.action === "买入" || r.action === "加仓";
  return r.score >= 65;
}
function isStrongBuy(r, strategy) {
  if (strategy === "short-term") return r.action === "买入";
  return r.score >= 80;
}

async function fetchKLineRange(code, startDate, endDate) {
  const prefix = code.startsWith("6") ? "sh" : "sz";
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${prefix}${code},day,,,120,qfq`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const d = await r.json();
    const key = `${prefix}${code}`;
    const rows = d?.data?.[key]?.qfqday || d?.data?.[key]?.day || [];
    return rows
      .map(row => ({ date: row[0], open: +row[1], close: +row[2], high: +row[3], low: +row[4] }))
      .filter(row => row.date >= startDate && row.date <= endDate);
  } catch { return []; }
}

function loadSnapshots(strategy, startDate, endDate) {
  if (!existsSync(HISTORY)) {
    console.error("history/ 目录不存在");
    process.exit(1);
  }

  const prefix = strategy === "short-term" ? "" : `${strategy}-`;
  const files = readdirSync(HISTORY)
    .filter(f => {
      if (!f.endsWith(".json")) return false;
      if (strategy === "short-term") {
        // 短线快照: YYYY-MM-DD.json (无前缀)
        return /^\d{4}-\d{2}-\d{2}\.json$/.test(f);
      }
      return f.startsWith(`${strategy}-`) && f.endsWith(".json");
    })
    .map(f => f.replace(".json", ""))
    .filter(d => {
      const date = strategy === "short-term" ? d : d.replace(`${strategy}-`, "");
      return date >= (startDate || "2000-01-01") && date <= (endDate || "2099-12-31");
    })
    .sort();

  const snapshots = [];
  for (const fname of files) {
    const date = strategy === "short-term" ? fname : fname.replace(`${strategy}-`, "");
    try {
      const data = JSON.parse(readFileSync(join(HISTORY, `${fname}.json`), "utf-8"));
      snapshots.push({ date, strategy, ...data });
    } catch (e) { console.error(`  [!] 跳过损坏快照: ${fname}.json`); }
  }
  return snapshots;
}

async function runBacktest(snapshots, strategy) {
  let cash = CFG.initialCapital;
  const positions = [];
  const trades = [];
  const navHistory = [];

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  策略: ${strategy} | 回测: ${snapshots[0]?.date} ~ ${snapshots[snapshots.length - 1]?.date}`);
  console.log(`  快照天数: ${snapshots.length} | 初始资金: ${CFG.initialCapital.toLocaleString()}`);
  console.log(`${"=".repeat(60)}\n`);

  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    const today = snap.date;
    const phase = snap.emotion?.phase || "default";
    const positionPct = CFG.positionPct[phase] || CFG.positionPct.default;

    // ── 1. 检查持仓 ──
    for (let p = positions.length - 1; p >= 0; p--) {
      const pos = positions[p];
      const holdDays = daysBetween(pos.entryDate, today);
      let exitPrice = null;
      let exitReason = "";

      const klines = await fetchKLineRange(pos.code, pos.entryDate, today);
      if (klines.length > 1) {
        for (let k = 1; k < klines.length; k++) {
          const bar = klines[k];
          const pnlPct = (bar.close - pos.entryPrice) / pos.entryPrice;
          if ((bar.low - pos.entryPrice) / pos.entryPrice <= CFG.stopLoss) {
            exitPrice = pos.entryPrice * (1 + CFG.stopLoss); exitReason = "止损"; break;
          }
          if ((bar.high - pos.entryPrice) / pos.entryPrice >= CFG.takeProfit) {
            exitPrice = pos.entryPrice * (1 + CFG.takeProfit); exitReason = "止盈"; break;
          }
          if (holdDays >= CFG.maxHoldDays && k === klines.length - 1) {
            exitPrice = bar.close; exitReason = `到期(${holdDays}天)`;
          }
        }
      } else if (holdDays >= CFG.maxHoldDays) {
        const inSnap = snap.results?.find(r => r.code === pos.code);
        exitPrice = inSnap?.price || pos.entryPrice;
        exitReason = `到期(${holdDays}天)`;
      }

      if (exitPrice !== null) {
        cash += pos.shares * exitPrice;
        trades.push({
          type: "卖出", code: pos.code, name: pos.name,
          entryDate: pos.entryDate, exitDate: today,
          entryPrice: pos.entryPrice, exitPrice: +exitPrice.toFixed(2),
          shares: pos.shares, pnl: +((exitPrice - pos.entryPrice) * pos.shares).toFixed(2),
          pnlPct: +((exitPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(2),
          reason: exitReason,
        });
        positions.splice(p, 1);
      }
    }

    // ── 2. 买入 ──
    const candidates = (snap.results || [])
      .filter(r => isBuy(r, strategy))
      .sort((a, b) => b.score - a.score);

    const targetValue = CFG.initialCapital * positionPct;
    const currentValue = positions.reduce((sum, p) => {
      const s = snap.results?.find(r => r.code === p.code);
      return sum + p.shares * (s?.price || p.entryPrice);
    }, 0);
    const availableCash = Math.max(0, targetValue - currentValue);

    if (candidates.length > 0 && positions.length < CFG.maxPositions && availableCash > 0) {
      const slots = CFG.maxPositions - positions.length;
      const perSlot = Math.min(availableCash / slots, cash / slots);

      for (const c of candidates) {
        if (positions.length >= CFG.maxPositions || positions.some(p => p.code === c.code)) break;
        if (perSlot < c.price * 100) continue;
        const shares = Math.floor(perSlot / c.price / 100) * 100;
        if (shares < 100) continue;

        const klines = await fetchKLineRange(c.code, today, today);
        const canTrade = klines.length === 0 || klines[0].open !== klines[0].close || klines[0].high !== klines[0].low;
        if (!canTrade) continue;

        cash -= shares * c.price;
        positions.push({ code: c.code, name: c.name, entryDate: today, entryPrice: c.price, shares, cost: shares * c.price });
        trades.push({ type: "买入", code: c.code, name: c.name, entryDate: today, entryPrice: c.price, shares, cost: +(shares * c.price).toFixed(2), score: c.score, action: c.action || "" });
      }
    }

    const posValue = positions.reduce((sum, p) => {
      const s = snap.results?.find(r => r.code === p.code);
      return sum + p.shares * (s?.price || p.entryPrice);
    }, 0);
    navHistory.push({ date: today, cash: +cash.toFixed(2), posValue: +posValue.toFixed(2), nav: +(cash + posValue).toFixed(2), positions: positions.length, phase });

    if (i % Math.max(1, Math.floor(snapshots.length / 10)) === 0 || i === snapshots.length - 1) {
      console.log(`  ${today} | 净值: ${(cash + posValue).toFixed(0)} | 持仓: ${positions.length}只 | 阶段: ${phase}`);
    }
  }

  // 强制清仓
  if (positions.length > 0) {
    const lastSnap = snapshots[snapshots.length - 1];
    for (const pos of positions) {
      const s = lastSnap.results?.find(r => r.code === pos.code);
      const exitPrice = s?.price || pos.entryPrice;
      cash += pos.shares * exitPrice;
      trades.push({
        type: "卖出", code: pos.code, name: pos.name,
        entryDate: pos.entryDate, exitDate: lastSnap.date,
        entryPrice: pos.entryPrice, exitPrice: +exitPrice.toFixed(2),
        shares: pos.shares, pnl: +((exitPrice - pos.entryPrice) * pos.shares).toFixed(2),
        pnlPct: +((exitPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(2),
        reason: "清仓",
      });
    }
  }

  return { trades, navHistory, finalCash: cash };
}

function generateReport(trades, navHistory, finalCash, strategy) {
  const sellTrades = trades.filter(t => t.type === "卖出");
  const wins = sellTrades.filter(t => t.pnl > 0);
  const losses = sellTrades.filter(t => t.pnl < 0);
  const winRate = sellTrades.length > 0 ? (wins.length / sellTrades.length) * 100 : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;

  let peak = CFG.initialCapital;
  let maxDrawdown = 0;
  for (const n of navHistory) {
    if (n.nav > peak) peak = n.nav;
    const dd = (n.nav - peak) / peak;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  const dailyReturns = [];
  for (let i = 1; i < navHistory.length; i++) {
    dailyReturns.push((navHistory[i].nav - navHistory[i - 1].nav) / navHistory[i - 1].nav);
  }
  const avgDaily = dailyReturns.reduce((s, r) => s + r, 0) / (dailyReturns.length || 1);
  const stdDaily = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgDaily) ** 2, 0) / (dailyReturns.length || 1));
  const sharpe = stdDaily > 0 ? (avgDaily / stdDaily) * Math.sqrt(252) : 0;

  const totalReturn = (finalCash - CFG.initialCapital) / CFG.initialCapital;

  printReport({ totalReturn, winRate, avgWin, avgLoss, maxDrawdown, sharpe, finalCash, strategy }, trades, navHistory);
  return { totalReturn, winRate, avgWin, avgLoss, maxDrawdown, sharpe, finalCash, strategy };
}

function printReport(r, trades, navHistory) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  绩效报告 — ${r.strategy}`);
  console.log(`${"=".repeat(60)}\n`);
  console.log(`  总收益率:    ${(r.totalReturn * 100).toFixed(2)}%`);
  console.log(`  最终资金:    ${r.finalCash.toFixed(0)} (初始 ${CFG.initialCapital.toLocaleString()})`);
  console.log(`  交易次数:    ${trades.filter(t => t.type === "买入").length}买 ${trades.filter(t => t.type === "卖出").length}卖`);
  console.log(`  胜率:        ${r.winRate.toFixed(1)}%`);
  console.log(`  平均盈利:    ${r.avgWin.toFixed(2)}% / 平均亏损: ${r.avgLoss.toFixed(2)}%`);
  console.log(`  盈亏比:      ${r.avgLoss !== 0 ? (Math.abs(r.avgWin / r.avgLoss)).toFixed(2) : "∞"}`);
  console.log(`  最大回撤:    ${(r.maxDrawdown * 100).toFixed(2)}%`);
  console.log(`  夏普比率:    ${r.sharpe.toFixed(2)}\n`);

  const sellTrades = trades.filter(t => t.type === "卖出").slice(-10);
  if (sellTrades.length) {
    console.log("  最近交易:");
    for (const t of sellTrades) {
      const sign = t.pnl > 0 ? "+" : "";
      console.log(`    ${t.exitDate} ${t.code} ${(t.name||"").padEnd(8)} ${sign}${t.pnlPct.toFixed(2)}% | ${t.reason} | 持${daysBetween(t.entryDate, t.exitDate)}天`);
    }
  }
  console.log(`\n${"=".repeat(60)}\n`);
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

async function main() {
  const args = process.argv.slice(2);
  const strategy = args[0] || "all";
  const startDate = args[1] || "2020-01-01";
  const endDate = args[2] || new Date().toISOString().slice(0, 10);

  const targets = strategy === "all" ? STRATEGIES : [strategy];

  if (strategy !== "all" && !STRATEGIES.includes(strategy)) {
    console.error(`未知策略: ${strategy}，可选: ${STRATEGIES.join(", ")}, all`);
    process.exit(1);
  }

  const allReports = [];

  for (const s of targets) {
    const snapshots = loadSnapshots(s, startDate, endDate);
    if (snapshots.length < 2) {
      console.log(`[!] ${s}: 只有${snapshots.length}天快照，跳过回测\n`);
      continue;
    }
    const { trades, navHistory, finalCash } = await runBacktest(snapshots, s);
    const report = generateReport(trades, navHistory, finalCash, s);
    allReports.push({ strategy: s, report, trades, navHistory });
  }

  // 保存
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const reportFile = join(OUT, `backtest-${startDate}_${endDate}.json`);
  const payload = allReports.map(({ strategy, report, trades, navHistory }) => ({
    strategy,
    config: { ...CFG, startDate, endDate },
    summary: {
      totalReturn: +report.totalReturn.toFixed(4),
      winRate: +report.winRate.toFixed(2),
      avgWin: +report.avgWin.toFixed(2),
      avgLoss: +report.avgLoss.toFixed(2),
      maxDrawdown: +report.maxDrawdown.toFixed(4),
      sharpe: +report.sharpe.toFixed(2),
      finalCash: +report.finalCash.toFixed(2),
      totalTrades: trades.filter(t => t.type === "卖出").length,
    },
    navHistory,
    trades,
  }));
  writeFileSync(reportFile, JSON.stringify(payload, null, 2), "utf-8");
  console.log(`[ok] 报告已保存: ${reportFile}`);
}

main().catch(e => { console.error(e); process.exit(1); });
