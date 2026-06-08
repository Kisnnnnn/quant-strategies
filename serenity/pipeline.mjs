/**
 * Serenity 供应链卡点分析主管线
 *
 * 对预定义供应链标的进行分析，自动化9条判据打分+红旗扫描+报告生成。
 * 与 band-dip/dragon-reverse 策略不同 — 本管线聚焦基本面，不依赖K线形态。
 *
 * 使用方式：
 *   node serenity/pipeline.mjs                    # 分析所有跟踪标的
 *   node serenity/pipeline.mjs --scope=ai_infra   # 仅AI基础设施
 *   node serenity/pipeline.mjs --scope=robotics   # 仅机器人
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, "..");
const STOCK_DATA = join(PROJECT, "..", "chaogu", "stock-data.mjs");

import { scoreCriteria } from "./criteria.mjs";
import { scanRedFlags } from "./red-flags.mjs";
import { generateReport } from "./report.mjs";

// ── 配置加载 ──
function loadSerenityConfig() {
  const cfgPath = join(__dirname, "config.json");
  return JSON.parse(readFileSync(cfgPath, "utf-8"));
}

function loadSupplyChainMaps() {
  const mapPath = join(__dirname, "supply-chain-maps.json");
  return JSON.parse(readFileSync(mapPath, "utf-8"));
}

// ── 数据加载 ──
let _mod = null;
async function getMod() {
  if (!_mod) {
    try {
      _mod = await import(STOCK_DATA);
    } catch (_) {
      // stock-data.mjs not available — fallback to Tencent API directly
    }
  }
  return _mod;
}

/**
 * 从腾讯API批量获取行情
 */
async function fetchQuotes(codes) {
  const prefixed = codes.map(c => {
    if (c.startsWith("6") || c.startsWith("9")) return `sh${c}`;
    if (c.startsWith("8")) return `bj${c}`;
    return `sz${c}`;
  });

  try {
    const url = `https://qt.gtimg.cn/q=${prefixed.join(",")}`;
    const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const raw = await resp.arrayBuffer();
    const decoder = new TextDecoder("gbk");
    const data = decoder.decode(raw);

    const result = {};
    for (const line of data.trim().split(";")) {
      if (!line.trim() || !line.includes("=") || !line.includes('"')) continue;
      const key = line.split("=")[0].split("_").pop();
      const vals = line.split('"')[1].split("~");
      if (vals.length < 53) continue;
      const code = key.slice(2);
      result[code] = {
        code,
        name: vals[1],
        price: parseFloat(vals[3]) || 0,
        lastClose: parseFloat(vals[4]) || 0,
        open: parseFloat(vals[5]) || 0,
        changePct: parseFloat(vals[32]) || 0,
        high: parseFloat(vals[33]) || 0,
        low: parseFloat(vals[34]) || 0,
        turnoverPct: parseFloat(vals[38]) || 0,
        peTtm: parseFloat(vals[39]) || 0,
        amplitudePct: parseFloat(vals[43]) || 0,
        mcapYi: parseFloat(vals[44]) || 0,
        floatMcapYi: parseFloat(vals[45]) || 0,
        pb: parseFloat(vals[46]) || 0,
        limitUp: parseFloat(vals[47]) || 0,
        limitDown: parseFloat(vals[48]) || 0,
        volRatio: parseFloat(vals[49]) || 0,
        peStatic: parseFloat(vals[52]) || 0,
      };
    }
    return result;
  } catch (e) {
    console.error("[serenity] 行情拉取失败:", e.message);
    return {};
  }
}

/**
 * 从stock-data.mjs获取增强数据（概念板块、龙虎榜、资金流）
 */
async function fetchEnrichment(code) {
  const enrichment = { conceptTags: [], dragonTiger: null, fundFlow: null };
  try {
    const m = await getMod();
    if (!m) return enrichment;

    // 概念板块
    try {
      const cb = await m.eastmoneyConceptBlocks(code);
      if (cb?.conceptTags) enrichment.conceptTags = cb.conceptTags.slice(0, 10);
    } catch (_) {}

    // 龙虎榜(近30天)
    try {
      const today = new Date().toISOString().slice(0, 10);
      const dt = await m.dragonTigerBoard(code, today, 30);
      if (dt?.records?.length) {
        const inst = dt.institution;
        enrichment.dragonTiger = {
          records: dt.records.length,
          latest: dt.records[0],
          institution: inst ? { buy: inst.buyAmt, sell: inst.sellAmt, net: inst.netAmt } : null,
        };
      }
    } catch (_) {}

    // 120日资金流
    try {
      const flow = await m.stockFundFlow120d(code);
      if (flow?.length) {
        const recent20 = flow.slice(-20);
        const totalMain = recent20.reduce((s, d) => s + (d.mainNet || 0), 0);
        enrichment.fundFlow = {
          days: flow.length,
          recent20MainNet: totalMain,
          signal: totalMain > 0 ? "bullish" : "bearish",
        };
      }
    } catch (_) {}
  } catch (_) {}

  return enrichment;
}

/**
 * 构建模拟财务数据（从有限公开数据推断）
 * 生产使用应接入巨潮财报API获取真实三表数据
 */
function buildFinancialEstimate(code, stock, enrichment) {
  const fin = {
    revenue: null,
    netProfit: null,
    grossMargin: null,
    cash: null,
    totalDebt: null,
    totalAssets: null,
    revenueCagr: null,
    institutionalHolding: null,
    peg: null,
    fwdPE: null,
    customerConcentration: null,
    shareCountCagr: null,
    hasAuditorChange: false,
    netBurn: null,
    orderBacklog: null,
    confidence: "low",
    source: "estimated",
  };

  // 基础推断
  if (stock.peTtm > 0 && stock.mcapYi > 0) {
    fin.netProfit = (stock.mcapYi * 1e8) / stock.peTtm;
  }

  if (stock.pb > 0 && stock.mcapYi > 0) {
    fin.totalAssets = (stock.mcapYi * 1e8) / stock.pb;
  }

  // 从概念标签推断部分特征
  if (enrichment?.conceptTags) {
    const tags = enrichment.conceptTags.join(" ");
    if (/国产替代|自主可控|信创/.test(tags)) fin.fwdPE = stock.peTtm * 0.7; // rough forward PE estimate
  }

  fin.confidence = "low"; // 始终标记为低置信度（非一手财报数据）
  fin.source = "estimated-from-market-data";

  return fin;
}

// ── 收集所有监控标的 ──
function collectTargetStocks(supplyChainMaps, scope = "all") {
  const targets = [];
  const seen = new Set();

  const sections = scope === "all"
    ? Object.keys(supplyChainMaps).filter(k => k !== "_meta")
    : [scope];

  for (const section of sections) {
    const map = supplyChainMaps[section];
    if (!map?.layers) continue;

    for (const layer of map.layers) {
      const players = layer.players || layer.locked_stocks || [];
      for (const player of players) {
        if (typeof player === "string") continue; // skip plain names like "字节跳动"
        if (player.code && !seen.has(player.code)) {
          seen.add(player.code);
          targets.push({
            ...player,
            layer: layer.layer,
            layerPosition: layer.position,
            bottleneck: layer.bottleneck,
            layerDescription: layer.description,
            supplyChain: section,
          });
        }
      }
    }
  }

  return targets;
}

// ── 市场情绪 ──
async function fetchMarketContext() {
  try {
    const m = await getMod();
    if (!m) return null;
    const breadth = await m.getMarketBreadth();
    const north = await m.hsgtRealtime().catch(() => null);

    let northTotal = null;
    if (north) {
      const hgt = north.hgt?.filter(v => v != null).pop();
      const sgt = north.sgt?.filter(v => v != null).pop();
      if (hgt != null && sgt != null) northTotal = (hgt + sgt).toFixed(1);
    }

    return {
      sentiment: breadth?.sentiment || "N/A",
      advDecRatio: breadth?.advDecRatio || 0,
      advancing: breadth?.advancing || 0,
      declining: breadth?.declining || 0,
      northbound: northTotal ? { total: northTotal } : null,
    };
  } catch (_) {
    return null;
  }
}

// ── 主管线 ──
async function run(scope = "all") {
  const cfg = loadSerenityConfig();
  const maps = loadSupplyChainMaps();
  const display = cfg.strategy.display_name;
  const now = () => new Date().toLocaleString("zh-CN", { hour12: false });

  console.log(`${"=".repeat(60)}`);
  console.log(`  ${display} — ${now()}`);
  console.log(`  范围: ${scope}`);
  console.log(`${"=".repeat(60)}\n`);

  // Step 1: 收集标的
  const targets = collectTargetStocks(maps, scope);
  const codes = targets.map(t => t.code);
  console.log(`Step 1/5: 标的收集 — ${targets.length} 只`);
  console.log(`  覆盖环节: ${[...new Set(targets.map(t => t.layer))].join(" → ")}\n`);

  // Step 2: 批量行情
  console.log(`Step 2/5: 行情拉取...`);
  const quotes = await fetchQuotes(codes);
  console.log(`  获取 ${Object.keys(quotes).length} 条行情\n`);

  // Step 3: 逐股分析
  console.log(`Step 3/5: 供应链卡点分析（判据评分 + 红旗扫描）...`);
  const analyzed = [];

  for (const target of targets) {
    const stock = quotes[target.code];
    if (!stock) {
      console.log(`  ${target.code} ${target.name}: 无行情数据，跳过`);
      continue;
    }

    // 增强数据
    const enrichment = await fetchEnrichment(target.code);

    // 财务估计
    const financial = buildFinancialEstimate(target.code, stock, enrichment);

    // 供应链位置
    const supplyChain = {
      layer: target.layer,
      tier: target.tier || "",
      subLayer: target.sub_layer || target.role || "",
      bottleneck: target.bottleneck !== false,
      role: target.role || "",
      description: target.layerDescription || "",
      locked_stocks: target.locked_stocks,
    };

    // 9条判据评分
    const criteriaResult = scoreCriteria(stock, financial, supplyChain, cfg.criteria?.thresholds || {});

    // 红旗扫描
    const redFlagResult = scanRedFlags(stock, financial, supplyChain, cfg.red_flags || {});

    const entry = {
      code: target.code,
      name: target.name || stock.name,
      stock,
      financial,
      supplyChain,
      enrichment,
      criteriaResult,
      redFlagResult,
    };

    analyzed.push(entry);

    const flag = redFlagResult.rejected ? "🚫" : redFlagResult.riskLevel === "high" ? "⚠️" : "  ";
    const score = criteriaResult.totalScore !== null ? `${criteriaResult.totalScore}分` : "N/A";
    console.log(`  ${flag} ${entry.code} ${entry.name}: ${score} | ${criteriaResult.scorableCount}/9可评分 | 置信:${criteriaResult.confidence} | ${redFlagResult.riskLevel}`);
  }

  console.log(`\n  分析: ${analyzed.length} 只\n`);

  // Step 4: 排序 + 市场情绪
  console.log(`Step 4/5: 排序 + 市场情绪...`);
  const marketContext = await fetchMarketContext();

  analyzed.sort((a, b) => (b.criteriaResult?.totalScore || 0) - (a.criteriaResult?.totalScore || 0));

  // 过滤硬否决
  const active = analyzed.filter(a => !a.redFlagResult.rejected);
  console.log(`  有效标的: ${active.length} 只 (排除 ${analyzed.length - active.length} 只硬否决)\n`);

  // Step 5: 报告生成
  console.log(`Step 5/5: 报告生成...`);
  const { json, markdown } = generateReport({
    analyzedStocks: analyzed,
    marketContext,
    supplyChain: scope === "all" ? "全赛道" : scope,
  });

  // 保存
  const outDir = join(PROJECT, "outputs");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().slice(0, 10);

  const jsonPath = join(outDir, `serenity-${scope}-${ts}.json`);
  writeFileSync(jsonPath, JSON.stringify(json, null, 2), "utf-8");

  const mdPath = join(outDir, `serenity-${scope}-${ts}.md`);
  writeFileSync(mdPath, markdown, "utf-8");

  console.log(`${"=".repeat(60)}`);
  console.log(`  ${display} 完成 — ${now()}`);
  console.log(`${"=".repeat(60)}`);
  console.log(`  JSON报告: ${jsonPath}`);
  console.log(`  MD报告:   ${mdPath}`);
  console.log();

  // 简要输出
  console.log("快速排名:");
  console.log("---");
  for (let i = 0; i < Math.min(15, analyzed.length); i++) {
    const a = analyzed[i];
    const s = a.criteriaResult;
    const r = a.redFlagResult;
    const icon = r.rejected ? "🚫" : s.totalScore >= 70 ? "⭐" : s.totalScore >= 50 ? "★" : s.totalScore >= 30 ? "○" : "·";
    console.log(`${String(i + 1).padStart(2)}. ${icon} ${a.code} ${(a.name || "").padEnd(8)} ${s.totalScore || "N/A"}分 | ${a.supplyChain.layer} | ${s.scorableCount}/9可评 | ${r.riskLevel}`);
  }
  console.log();

  return { json, markdown, analyzed, jsonPath, mdPath };
}

// ── CLI入口 ──
const args = process.argv.slice(2);
let scope = "all";
for (const arg of args) {
  if (arg.startsWith("--scope=")) scope = arg.split("=")[1];
}

run(scope).catch(err => {
  console.error("[serenity] 执行失败:", err);
  process.exit(1);
});
