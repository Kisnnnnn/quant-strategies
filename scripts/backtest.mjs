/**
 * 短线策略回测引擎
 *
 * 用法: node scripts/backtest.mjs [startDate] [endDate]
 * 示例: node scripts/backtest.mjs 2026-05-01 2026-06-06
 *
 * 依赖 history/ 目录下的每日扫描快照（由 history-collect.mjs 产出）
 * 用历史K线验证止损/止盈触发点
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, "..");
const HISTORY = join(PROJECT, "history");
const OUT = join(PROJECT, "outputs");

// ═══════════════════════════════════════
//  配置
// ═══════════════════════════════════════

const CFG = {
  maxPositions: 5,        // 最大持仓数
  stopLoss: -0.05,        // 止损线 -5%
  takeProfit: 0.10,       // 止盈线 +10%
  maxHoldDays: 3,         // 最大持仓天数
  initialCapital: 100000, // 初始资金
  // 仓位系数（和扫描脚本一致）
  positionPct: {
    "main-up": 0.80,
    "trial":   0.50,
    "swing":   0.30,
    "decline": 0.15,
    "offday":  0.40,
  },
  // 买入评级阈值
  buyActions: ["买入"],
  addActions: ["加仓", "买入"],
};

// ═══════════════════════════════════════
//  K线获取（腾讯API，支持历史）
// ═══════════════════════════════════════

async function fetchKLineRange(code, startDate, endDate) {
  const prefix = code.startsWith("6") ? "sh" : "sz";
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${prefix}${code},day,,,120,qfq`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const d = await r.json();
    const key = `${prefix}${code}`;
    const rows = d?.data?.[key]?.qfqday || d?.data?.[key]?.day || [];
    if (!rows.length) return [];
    return rows
      .map(row => ({ date: row[0], open: +row[1], close: +row[2], high: +row[3], low: +row[4] }))
      .filter(row => row.date >= startDate && row.date <= endDate);
  } catch { return []; }
}

// ═══════════════════════════════════════
//  加载历史快照
// ═══════════════════════════════════════

function loadSnapshots(startDate, endDate) {
  if (!existsSync(HISTORY)) {
    console.error("history/ 目录不存在，请先运行 node scripts/history-collect.mjs");
    process.exit(1);
  }

  const files = readdirSync(HISTORY)
    .filter(f => f.endsWith(".json"))
    .map(f => f.replace(".json", ""))
    .filter(d => d >= (startDate || "2000-01-01") && d <= (endDate || "2099-12-31"))
    .sort();

  const snapshots = [];
  for (const date of files) {
    try {
      const data = JSON.parse(readFileSync(join(HISTORY, `${date}.json`), "utf-8"));
      snapshots.push({ date, ...data });
    } catch (e) {
      console.error(`  [!] 跳过损坏快照: ${date}.json`);
    }
  }

  return snapshots;
}

// ═══════════════════════════════════════
//  回测模拟
// ═══════════════════════════════════════

async function runBacktest(snapshots) {
  let cash = CFG.initialCapital;
  const positions = [];  // { code, name, entryDate, entryPrice, shares, cost }
  const trades = [];     // 所有成交记录
  const navHistory = []; // 每日净值

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  回测开始: ${snapshots[0]?.date} ~ ${snapshots[snapshots.length - 1]?.date}`);
  console.log(`  快照天数: ${snapshots.length} | 初始资金: ${CFG.initialCapital.toLocaleString()}`);
  console.log(`${"=".repeat(60)}\n`);

  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    const today = snap.date;
    const phase = snap.emotion?.phase || "swing";
    const positionPct = CFG.positionPct[phase] || 0.30;

    // ── 1. 检查现有持仓：止损/止盈/到期 ──
    for (let p = positions.length - 1; p >= 0; p--) {
      const pos = positions[p];
      const holdDays = daysBetween(pos.entryDate, today);
      let exitPrice = null;
      let exitReason = "";

      // 获取持仓期间的K线数据
      const klines = await fetchKLineRange(pos.code, pos.entryDate, today);
      if (klines.length > 1) {
        const entryDay = klines[0];
        for (let k = 1; k < klines.length; k++) {
          const bar = klines[k];
          const pnl = (bar.close - pos.entryPrice) / pos.entryPrice;

          // 止损检查：日内最低价触发
          if ((bar.low - pos.entryPrice) / pos.entryPrice <= CFG.stopLoss) {
            exitPrice = pos.entryPrice * (1 + CFG.stopLoss);
            exitReason = "止损";
            break;
          }
          // 止盈检查：日内最高价触发
          if ((bar.high - pos.entryPrice) / pos.entryPrice >= CFG.takeProfit) {
            exitPrice = pos.entryPrice * (1 + CFG.takeProfit);
            exitReason = "止盈";
            break;
          }
          // 到期清仓
          if (holdDays >= CFG.maxHoldDays && k === klines.length - 1) {
            exitPrice = bar.close;
            exitReason = `到期(${holdDays}天)`;
          }
        }
      } else if (holdDays >= CFG.maxHoldDays) {
        // 无K线数据且已到期，用当日快照中的价格
        const stockInSnap = snap.results?.find(r => r.code === pos.code);
        exitPrice = stockInSnap?.price || pos.entryPrice;
        exitReason = `到期(${holdDays}天)`;
      }

      if (exitPrice !== null) {
        const pnl = (exitPrice - pos.entryPrice) * pos.shares;
        cash += pos.shares * exitPrice;
        trades.push({
          type: "卖出", code: pos.code, name: pos.name,
          entryDate: pos.entryDate, exitDate: today,
          entryPrice: pos.entryPrice, exitPrice: +exitPrice.toFixed(2),
          shares: pos.shares, pnl: +pnl.toFixed(2),
          pnlPct: +((exitPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(2),
          reason: exitReason,
        });
        positions.splice(p, 1);
      }
    }

    // ── 2. 买入新标的 ──
    const candidates = (snap.results || [])
      .filter(r => CFG.buyActions.includes(r.action))
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
        if (perSlot < c.price * 100) continue; // 至少买一手

        const shares = Math.floor(perSlot / c.price / 100) * 100;
        if (shares < 100) continue;

        const cost = shares * c.price;

        // 检查K线是否可交易（非一字板：开盘价≠收盘价或有一定交易量）
        const klines = await fetchKLineRange(c.code, today, today);
        const canTrade = klines.length === 0 || klines[0].open !== klines[0].close || klines[0].high !== klines[0].low;
        if (!canTrade) continue; // 一字板跳过

        cash -= cost;
        positions.push({
          code: c.code, name: c.name,
          entryDate: today, entryPrice: c.price,
          shares, cost,
        });
        trades.push({
          type: "买入", code: c.code, name: c.name,
          entryDate: today, entryPrice: c.price,
          shares, cost: +cost.toFixed(2),
          score: c.score, action: c.action,
        });
      }
    }

    // ── 3. 记录当日净值 ──
    const posValue = positions.reduce((sum, p) => {
      const s = snap.results?.find(r => r.code === p.code);
      return sum + p.shares * (s?.price || p.entryPrice);
    }, 0);
    navHistory.push({
      date: today, cash: +cash.toFixed(2), posValue: +posValue.toFixed(2),
      nav: +(cash + posValue).toFixed(2), positions: positions.length,
      phase,
    });

    if ((i + 1) % 5 === 0 || i === 0 || i === snapshots.length - 1) {
      const nav = cash + posValue;
      console.log(`  ${today} | 净值: ${nav.toFixed(0)} | 持仓: ${positions.length}只 | 现金: ${cash.toFixed(0)} | 阶段: ${phase}`);
    }
  }

  // 强制清仓：最后一天全部按收盘价卖出
  if (positions.length > 0) {
    const lastSnap = snapshots[snapshots.length - 1];
    for (const pos of positions) {
      const s = lastSnap.results?.find(r => r.code === pos.code);
      const exitPrice = s?.price || pos.entryPrice;
      const pnl = (exitPrice - pos.entryPrice) * pos.shares;
      cash += pos.shares * exitPrice;
      trades.push({
        type: "卖出", code: pos.code, name: pos.name,
        entryDate: pos.entryDate, exitDate: lastSnap.date,
        entryPrice: pos.entryPrice, exitPrice: +exitPrice.toFixed(2),
        shares: pos.shares, pnl: +pnl.toFixed(2),
        pnlPct: +((exitPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(2),
        reason: "清仓",
      });
    }
  }

  return { trades, navHistory, finalCash: cash };
}

// ═══════════════════════════════════════
//  绩效报告
// ═══════════════════════════════════════

function generateReport(trades, navHistory, finalCash) {
  const initialCapital = CFG.initialCapital;
  const totalReturn = (finalCash - initialCapital) / initialCapital;
  const sellTrades = trades.filter(t => t.type === "卖出");
  const buyTrades = trades.filter(t => t.type === "买入");

  const wins = sellTrades.filter(t => t.pnl > 0);
  const losses = sellTrades.filter(t => t.pnl < 0);
  const winRate = sellTrades.length > 0 ? (wins.length / sellTrades.length) * 100 : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;

  // 最大回撤
  let peak = initialCapital;
  let maxDrawdown = 0;
  for (const n of navHistory) {
    if (n.nav > peak) peak = n.nav;
    const dd = (n.nav - peak) / peak;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  // 夏普比率（简化：按日收益率计算）
  const dailyReturns = [];
  for (let i = 1; i < navHistory.length; i++) {
    dailyReturns.push((navHistory[i].nav - navHistory[i - 1].nav) / navHistory[i - 1].nav);
  }
  const avgDaily = dailyReturns.reduce((s, r) => s + r, 0) / (dailyReturns.length || 1);
  const stdDaily = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgDaily) ** 2, 0) / (dailyReturns.length || 1));
  const sharpe = stdDaily > 0 ? (avgDaily / stdDaily) * Math.sqrt(252) : 0;

  // 按阶段统计
  const phaseStats = {};
  for (const n of navHistory) {
    if (!phaseStats[n.phase]) phaseStats[n.phase] = { days: 0, trades: 0, wins: 0 };
    phaseStats[n.phase].days++;
  }
  for (const t of sellTrades) {
    const dayNav = navHistory.find(n => n.date === t.exitDate);
    const ph = dayNav?.phase || "unknown";
    if (phaseStats[ph]) {
      phaseStats[ph].trades++;
      if (t.pnl > 0) phaseStats[ph].wins++;
    }
  }

  const report = { totalReturn, winRate, avgWin, avgLoss, maxDrawdown, sharpe, finalCash, phaseStats };
  printReport(report, trades, navHistory);
  return report;
}

function printReport(report, trades, navHistory) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  绩效报告`);
  console.log(`${"=".repeat(60)}\n`);

  console.log(`  总收益率:    ${(report.totalReturn * 100).toFixed(2)}%`);
  console.log(`  最终资金:    ${report.finalCash.toFixed(0)} (初始 ${CFG.initialCapital.toLocaleString()})`);
  console.log(`  交易次数:    ${trades.filter(t => t.type === "买入").length}买 ${trades.filter(t => t.type === "卖出").length}卖`);
  console.log(`  胜率:        ${report.winRate.toFixed(1)}%`);
  console.log(`  平均盈利:    ${report.avgWin.toFixed(2)}% / 平均亏损: ${report.avgLoss.toFixed(2)}%`);
  console.log(`  盈亏比:      ${report.avgLoss !== 0 ? (Math.abs(report.avgWin / report.avgLoss)).toFixed(2) : "∞"}`);
  console.log(`  最大回撤:    ${(report.maxDrawdown * 100).toFixed(2)}%`);
  console.log(`  夏普比率:    ${report.sharpe.toFixed(2)}`);
  console.log();

  // 阶段胜率
  console.log("  分阶段胜率:");
  for (const [ph, s] of Object.entries(report.phaseStats)) {
    const wr = s.trades > 0 ? (s.wins / s.trades * 100).toFixed(1) : "—";
    console.log(`    ${ph}: ${s.days}天 ${s.trades}笔交易 胜率${wr}%`);
  }

  // 最近10笔交易
  const sellTrades = trades.filter(t => t.type === "卖出").slice(-10);
  if (sellTrades.length > 0) {
    console.log(`\n  最近交易:`);
    for (const t of sellTrades) {
      const emoji = t.pnl > 0 ? "+" : "";
      console.log(`    ${t.exitDate} ${t.code} ${t.name.padEnd(8)} ${emoji}${t.pnlPct.toFixed(2)}% | ${t.reason} | 持${daysBetween(t.entryDate, t.exitDate)}天`);
    }
  }
  console.log(`\n${"=".repeat(60)}\n`);
}

function daysBetween(a, b) {
  const d1 = new Date(a);
  const d2 = new Date(b);
  return Math.round((d2 - d1) / 86400000);
}

// ═══════════════════════════════════════
//  入口
// ═══════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const startDate = args[0] || "2020-01-01";
  const endDate = args[1] || new Date().toISOString().slice(0, 10);

  const snapshots = loadSnapshots(startDate, endDate);
  if (snapshots.length < 2) {
    console.error(`\n回测需要至少2天快照数据，当前只有 ${snapshots.length} 天。`);
    console.error("请先运行 node scripts/history-collect.mjs 积累数据。");
    console.error("或指定日期范围: node scripts/backtest.mjs 2026-05-01 2026-06-06\n");
    process.exit(1);
  }

  const { trades, navHistory, finalCash } = await runBacktest(snapshots);
  const report = generateReport(trades, navHistory, finalCash);

  // 保存报告
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const reportFile = join(OUT, `backtest-${startDate}_${endDate}.json`);
  writeFileSync(reportFile, JSON.stringify({
    config: { ...CFG, startDate, endDate, days: snapshots.length },
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
    phaseStats: report.phaseStats,
    navHistory,
    trades,
  }, null, 2), "utf-8");
  console.log(`[ok] 报告已保存: ${reportFile}`);
}

main().catch(e => { console.error(e); process.exit(1); });
