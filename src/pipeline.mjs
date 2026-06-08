/**
 * 策略管线编排器 — 对标 xbb1994 项目的 pipelines.py
 *
 * 管线步骤：
 *   1. 加载配置
 *   2. 获取全市场行情（带缓存）
 *   3. 过滤股票池
 *   4. 逐股拉K线计算指标 → 生成信号
 *   5. 信号增强：概念板块 + 龙虎榜 + 近期异动
 *   6. 市场情绪 + 评分排序输出
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { CacheManager } from "./cache.mjs";
import { buildCodePool, fetchBatchQuotes, fetchBatchKLines, fetchMarketBreadth } from "./data-loader.mjs";
import { buildUniverse } from "./universe.mjs";
import { calcIndicators } from "./indicators.mjs";
import { generateBandSignals } from "./signals-band.mjs";
import { generateDragonSignals } from "./signals-dragon.mjs";

function xueqiuUrl(code) {
  const prefix = code.startsWith("6") || code.startsWith("9") ? "SH" : code.startsWith("8") ? "BJ" : "SZ";
  return `https://xueqiu.com/S/${prefix}${code}`;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, "..");
const STOCK_DATA = join(__dirname, "../../chaogu/stock-data.mjs");

let _mod = null;
async function getMod() {
  if (!_mod) _mod = await import(STOCK_DATA);
  return _mod;
}

export function loadConfig(strategyName = null) {
  const def = JSON.parse(readFileSync(join(PROJECT, "config/default.json"), "utf-8"));
  let strat = null;
  if (strategyName) {
    const sp = join(PROJECT, "config/strategies", `${strategyName}.json`);
    if (existsSync(sp)) strat = JSON.parse(readFileSync(sp, "utf-8"));
  }
  return { default: def, strategy: strat };
}

export function ensureOutputDir() {
  const dir = join(PROJECT, "outputs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 对单个信号标的进行信息增强：概念板块 + 龙虎榜 + 近期异动
 */
async function enrichSignal(stockCode) {
  const m = await getMod();
  const today = new Date().toISOString().slice(0, 10);
  const enrichment = { industries: [], conceptTags: [], dragonTiger: null, recentNews: [] };

  // 所属板块 + 概念板块
  try {
    const cb = await m.eastmoneyConceptBlocks(stockCode);
    if (cb) {
      enrichment.industries = (cb.boards || []).slice(0, 3).map(b => `${b.name}(${b.changePct>0?'+':''}${b.changePct}%)`);
      enrichment.conceptTags = (cb.conceptTags || []).slice(0, 8);
    }
  } catch (e) { /* skip */ }

  // 龙虎榜（近30天）
  try {
    const dt = await m.dragonTigerBoard(stockCode, today, 30);
    if (dt?.records?.length) {
      const recent = dt.records.slice(0, 5).map(r => ({
        date: r.date,
        reason: r.reason,
        netBuy: r.netBuy + "万",
        turnover: r.turnover + "%",
      }));
      enrichment.dragonTiger = {
        totalRecords: dt.records.length,
        recent,
        seats: dt.seats || { buy: [], sell: [] },
        institution: dt.institution || null,
      };
    }
  } catch (e) { /* skip */ }

  // 近期异动：个股新闻（近10条取前3）
  try {
    const news = await m.eastmoneyStockNews(stockCode, 10);
    if (news?.length) {
      enrichment.recentNews = news.slice(0, 3).map(n => ({
        title: n.title || "",
        date: (n.time || "").toString(),
        source: n.source || "",
      }));
    }
  } catch (e) { /* skip */ }

  return enrichment;
}

export async function runStrategy(strategyName, cfg) {
  const defCfg = cfg.default;
  const stratCfg = cfg.strategy;
  const cache = new CacheManager();

  const display = stratCfg?.strategy?.display_name || strategyName;
  const now = () => new Date().toLocaleString("zh-CN", { hour12: false });
  const fmt = (n, d) => (typeof n === "number" ? n.toFixed(d) : n);
  const log = (...args) => console.log(...args);

  log(`\n${"=".repeat(60)}`);
  log(`  ${display} — ${now()}`);
  log(`${"=".repeat(60)}\n`);

  // Step 1: 代码池
  log("Step 1/6: 生成代码池...");
  let codes = buildCodePool({ boards: defCfg.universe?.boards });
  codes = codes.filter(c => !c.startsWith("688") && !c.startsWith("920"));
  log(`  全市场代码: ${codes.length} 只 (排除688科创板+920北交所)`);

  // Step 2: 批量行情（带缓存）
  log("Step 2/6: 获取行情数据...");
  const quotes = await fetchBatchQuotes(codes);
  const quoteTime = new Date().toLocaleString("zh-CN", { hour12: false });

  // Step 3: 股票池过滤
  log("Step 3/6: 过滤股票池...");
  const uCfg = {
    ...defCfg.universe,
    minTurnover: strategyName === "dragon-reverse" ? 1 : (stratCfg?.pullback?.min_turnover_pct || 1.5),
    minPrice: stratCfg?.filters?.min_price || 4,
    minMcap: stratCfg?.filters?.min_mcap_yi || 20,
    maxPE: stratCfg?.filters?.max_pe ?? 0,
    excludeLoss: stratCfg?.filters?.exclude_loss ?? false,
  };
  const pool = buildUniverse(quotes, uCfg);
  log(`  股票池: ${pool.length} 只\n`);

  // Step 4: 批量拉K线（腾讯K线）
  log("Step 4/6: 批量拉K线（腾讯K线·20ms限流+4h缓存）...");
  const allCodes = pool.map(s => s.code);
  const allKLines = await fetchBatchKLines(allCodes);

  // Step 3.5: 预获取市场宽度（用于信号评分的动态权重）
  let marketCtx = { advDecRatio: 1 };
  try {
    const breadth = await fetchMarketBreadth();
    marketCtx.advDecRatio = breadth?.advDecRatio ?? 1;
    marketCtx.marketLabel = breadth?.sentiment ?? "";
  } catch (e) { /* use defaults */ }

  // 在内存中计算指标 + 生成信号
  log("  K线分析 & 信号生成...");
  const results = [];
  let scanned = 0;
  for (const stock of pool) {
    const entry = allKLines[stock.code];
    if (!entry?.rows || entry.rows.length < 40) { scanned++; continue; }
    const ind = calcIndicators(entry.rows, stratCfg);
    if (!ind) { scanned++; continue; }

    let signal = null;
    if (strategyName === "band-dip") {
      signal = generateBandSignals(stock, ind, stratCfg, marketCtx);
    } else if (strategyName === "dragon-reverse") {
      signal = generateDragonSignals(stock, ind, stratCfg, marketCtx);
    }
    if (signal) { signal.quoteTime = quoteTime; results.push(signal); }
    scanned++;
    if (scanned % 300 === 0) process.stderr.write(`.${scanned}`);
  }
  process.stderr.write("\n");

  // 去重排序
  const seen = new Set();
  const final = results
    .filter(r => { if (seen.has(r.code)) return false; seen.add(r.code); return true; })
    .sort((a, b) => b.score - a.score);

  log(`\n  扫描: ${scanned} 只 | 信号: ${final.length} 只\n`);

  // Step 5: 信息增强 — 概念板块 + 龙虎榜
  const maxR = defCfg.outputs?.max_results || 20;
  const top = final.slice(0, maxR);

  log("Step 5/6: 信息增强（概念板块+龙虎榜）...");
  const enriched = [];
  for (const r of top) {
    process.stderr.write(".");
    const info = await enrichSignal(r.code);

    // ── 龙回头：催化剂分数调整 ──────────────────────────
    if (strategyName === "dragon-reverse" && info.dragonTiger) {
      let instNetBuy = 0, instNetSell = 0;
      if (info.dragonTiger.institution) {
        instNetBuy = info.dragonTiger.institution.buyAmt || 0;
        instNetSell = info.dragonTiger.institution.sellAmt || 0;
      }
      // 重新计算催化剂调整
      let adj = 0;
      if (instNetBuy > 3000) adj += 8;
      else if (instNetBuy > 1000) adj += 4;
      if (instNetSell > 5000) adj -= 12;
      if (info.dragonTiger.recent?.length) adj += 3;

      const newScore = Math.min(100, Math.max(0, r.score + adj));
      enriched.push({ ...r, ...info, score: newScore, scoreAdj: adj, xueqiuUrl: xueqiuUrl(r.code) });
    } else {
      enriched.push({ ...r, ...info, xueqiuUrl: xueqiuUrl(r.code) });
    }
  }

  // 重新排序（龙回头催化剂可能改变了分数）
  if (strategyName === "dragon-reverse") {
    enriched.sort((a, b) => b.score - a.score);
  }

  log(`  已增强 ${enriched.length} 只\n`);

  // Step 6: 市场情绪
  log("Step 6/6: 市场情绪...");
  let sentiment = null;
  try {
    const m = await getMod();
    const [breadth, limitUp, limitDown, north] = await Promise.all([
      fetchMarketBreadth(),
      m.getLimitUpBoard(5).catch(() => null),
      m.getLimitDownBoard(5).catch(() => null),
      m.hsgtRealtime().catch(() => null),
    ]);

    sentiment = {
      advDecRatio: breadth?.advDecRatio ?? "-",
      sentiment: breadth?.sentiment ?? "-",
      advancing: breadth?.advancing ?? 0,
      declining: breadth?.declining ?? 0,
      flat: breadth?.flat ?? 0,
      limitUpCount: limitUp?.total ?? null,
      limitDownCount: limitDown?.total ?? null,
      topLimitUps: limitUp?.stocks?.slice(0, 5).map(s => `${s.code} ${s.name} ${s.changePct}%`) ?? [],
      topLimitDowns: limitDown?.stocks?.slice(0, 5).map(s => `${s.code} ${s.name} ${s.changePct}%`) ?? [],
      northbound: north ? {
        hgt: north.hgt?.filter(v => v != null).pop() ?? null,
        sgt: north.sgt?.filter(v => v != null).pop() ?? null,
        total: null,
      } : null,
    };
    if (sentiment.northbound?.hgt != null && sentiment.northbound?.sgt != null) {
      sentiment.northbound.total = (sentiment.northbound.hgt + sentiment.northbound.sgt).toFixed(1);
    }

    log(`  涨跌比: ${sentiment.advDecRatio} | 情绪: ${sentiment.sentiment}`);
    log(`  上涨 ${sentiment.advancing} / 下跌 ${sentiment.declining} / 平 ${sentiment.flat}`);
    log(`  涨停 ${sentiment.limitUpCount ?? "?"} 家 | 跌停 ${sentiment.limitDownCount ?? "?"} 家`);
    if (sentiment.northbound?.total != null) {
      log(`  北向资金: ${sentiment.northbound.total} 亿 (沪 ${sentiment.northbound.hgt} / 深 ${sentiment.northbound.sgt})`);
    }
    log();
  } catch (e) { /* skip */ }

  // ── 输出 ──
  log(`${"=".repeat(60)}`);
  log(`  ${display} 结果 (${final.length}只, 显示前${top.length}只)`);
  log(`${"=".repeat(60)}\n`);

  if (enriched.length === 0) {
    log("  无符合条件标的。弱势市场下正常，不要强行交易。\n");
  } else {
    for (let i = 0; i < enriched.length; i++) {
      const r = enriched[i];

      // 标题行
      if (strategyName === "band-dip") {
        const icon = r.quality === "S" ? "⭐" : r.quality === "A" ? "★" : "  ";
        log(`${String(i + 1).padStart(2)}. ${icon} ${r.code} ${(r.name||"").padEnd(8)} ${r.score}分 ${r.trend}`);
      } else {
        const icon = r.level === "S" ? "🔥" : r.level === "A" ? "★" : "  ";
        log(`${String(i + 1).padStart(2)}. ${icon} ${r.code} ${(r.name||"").padEnd(8)} 龙性${r.score}分 ${r.trend}`);
      }

      // 选中原因
      log(`    选中原因 | ${r.reason || "技术形态符合策略条件"}`);

      // 技术面
      if (strategyName === "band-dip") {
        log(`    技术面 | MA5:${r.ma5} MA10:${r.ma10} MA20:${r.ma20} | 离20线:${r.distMA20} | 量比:${r.volRatio} | ${r.signals}`);
      } else {
        log(`    技术面 | 首波:${r.firstWave} 回调:${r.retrace} ${r.retraceDays}天 | 量${r.volRatio} | 强势日:${r.strongDays}天`);
        log(`    均线 | MA5:${r.ma5} MA10:${r.ma10} MA20:${r.ma20} | ${r.stabilizing}`);
      }

      // 基本面
      log(`    基本面 | 换手${r.turn}% PE${r.pe} 市值${r.mcap}亿 | 5d:${r.wChg} 20d:${r.mChg}`);

      // 所属板块
      if (r.industries?.length) {
        log(`    所属板块 | ${r.industries.join(" · ")}`);
      } else {
        log(`    所属板块 | (未获取到)`);
      }
      // 概念板块
      if (r.conceptTags?.length) {
        log(`    概念板块 | ${r.conceptTags.join(" · ")}`);
      } else {
        log(`    概念板块 | (未获取到)`);
      }

      // 近期异动（新闻）
      if (r.recentNews?.length) {
        log(`    近期异动 |`);
        r.recentNews.forEach(n => {
          const d = (n.date || "").slice(0, 10);
          log(`      ${d} | ${n.title}${n.source ? ` (${n.source})` : ""}`);
        });
      }

      // 龙虎榜
      if (r.dragonTiger?.recent?.length) {
        log(`    龙虎榜 | 近30天上榜${r.dragonTiger.totalRecords}次`);
        r.dragonTiger.recent.forEach(dt => {
          log(`      ${dt.date} | ${dt.reason}`);
          log(`      净买${dt.netBuy} | 换手率${dt.turnover}`);
        });
        // 买卖席位
        const seats = r.dragonTiger.seats;
        if (seats) {
          const allSeats = [
            ...(seats.buy || []).slice(0, 3).map(s => ({ ...s, side: "买入" })),
            ...(seats.sell || []).slice(0, 3).map(s => ({ ...s, side: "卖出" })),
          ];
          if (allSeats.length) {
            log(`      席位TOP:`);
            allSeats.forEach(s => {
              log(`        ${s.side} ${(s.name||"").padEnd(16)} 买${s.buyAmt}万 卖${s.sellAmt}万 净${s.net}万`);
            });
          }
        }
        // 机构动向
        if (r.dragonTiger.institution) {
          const inst = r.dragonTiger.institution;
          log(`      机构动向 | 买${inst.buyAmt}万 卖${inst.sellAmt}万 净${inst.netAmt}万`);
        }
      } else {
        log(`    龙虎榜 | 近30天未上榜`);
      }

      log();
    }
  }

  // 板块分类汇总
  const sectorMap = new Map();
  for (const r of enriched) {
    if (r.industries?.length) {
      const mainSector = r.industries[0].replace(/\([^)]*\)/g, "");
      if (!sectorMap.has(mainSector)) sectorMap.set(mainSector, []);
      sectorMap.get(mainSector).push(r);
    }
  }
  if (sectorMap.size > 0) {
    log(`\n${"=".repeat(60)}`);
    log(`  板块分布汇总`);
    log(`${"=".repeat(60)}`);
    const sorted = [...sectorMap.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [sector, stocks] of sorted) {
      const names = stocks.map(s => `${s.code} ${(s.name||"").trim()}`).join(" · ");
      log(`  ${sector} (${stocks.length}只): ${names}`);
    }
  }
  log();

  // 保存结果
  const outDir = ensureOutputDir();
  const ts = new Date().toISOString().slice(0, 10);
  const outFile = join(outDir, `${strategyName}-${ts}.json`);
  writeFileSync(outFile, JSON.stringify({ generatedAt: now(), total: final.length, results: enriched, sentiment }, null, 2), "utf-8");
  log(`结果已保存: ${outFile}`);

  log(`${"=".repeat(60)}`);
  log(`  完成 — ${now()}`);
  log(`${"=".repeat(60)}\n`);

  return { strategyName, total: final.length, results: enriched, outFile };
}

export async function runAll() {
  const cfg = loadConfig();
  const strategies = cfg.default.project?.active_strategies || ["band-dip", "dragon-reverse"];

  const results = {};
  for (const name of strategies) {
    const scfg = loadConfig(name);
    results[name] = await runStrategy(name, scfg);
  }

  console.log(`${"=".repeat(60)}`);
  console.log(`  全策略扫描汇总`);
  console.log(`${"=".repeat(60)}`);
  for (const [name, r] of Object.entries(results)) {
    console.log(`  ${name}: ${r.total} 条信号 → ${r.outFile}`);
  }
  console.log();

  return results;
}
