/**
 * 短线信号扫描 — 基于20条策略规则打分
 * 用法: node scripts/short-term-scan.mjs
 */
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { CacheManager } from "../src/cache.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, "..");
const STOCK_DATA = join(PROJECT, "../chaogu/stock-data.mjs");
const OUT = join(PROJECT, "outputs");
const CACHE_DIR = join(PROJECT, "data/cache");

const cache = new CacheManager(CACHE_DIR);

let _m = null;
async function getMod() {
  if (!_m) _m = await import(STOCK_DATA);
  return _m;
}

// 当日缓存键前缀，每天自动隔离
let _today = null;
function todayStr() {
  if (!_today) _today = new Date().toISOString().slice(0, 10);
  return _today;
}

// 缓存封装：命中返回缓存，未命中执行 fetcher 并写入
async function cached(key, fetcher, maxAgeHours) {
  const hit = cache.get(key, maxAgeHours);
  if (hit !== null) return hit;
  try {
    const data = await fetcher();
    if (data !== null && data !== undefined) cache.set(key, data);
    return data;
  } catch {
    return null;
  }
}

// ── 情绪周期检测（六位游资共性） ──────────────────────
function isWeekend(date) {
  const d = date ? new Date(date) : new Date();
  return d.getDay() === 0 || d.getDay() === 6;
}

// A股交易时段：上午 9:30-11:30，下午 13:00-15:00
function isMarketOpen() {
  if (isWeekend()) return false;
  const now = new Date();
  const t = now.getHours() * 60 + now.getMinutes();
  return (t >= 570 && t < 690) || (t >= 780 && t <= 900); // 9:30-11:30, 13:00-15:00
}

// 缓存TTL策略：开盘实时(不缓存行情)，休市快照(缓存到下次开盘)
function cacheTTL() {
  if (isMarketOpen()) return { mkt: 0, stock: 0.5 };   // 开盘：行情不缓存，基本面30min
  if (isWeekend())     return { mkt: 48, stock: 48 };   // 周末：长缓存
  return { mkt: 12, stock: 12 };                         // 工作日盘后：缓存到次日开盘
}

async function detectEmotionCycle(m) {
  const t = todayStr();
  const ttl = cacheTTL();

  let limitUpCount = 0, maxConsecutive = 1, totalAmount = 0;
  let limitStocks = [];

  try {
    const lu = await cached(`limitup_${t}`, () => m.getLimitUpBoard(200), ttl.mkt);
    limitUpCount = lu?.total || 0;
    limitStocks = (lu?.stocks || []).slice(0, 30);
    totalAmount = limitStocks.reduce((s, st) => s + (st.amount || 0), 0);

    if (limitStocks.length) {
      const top5 = limitStocks.slice(0, 5);
      const analyzed = await m.analyzeConsecutiveLimitUp(top5, 10);
      maxConsecutive = Math.max(...analyzed.map(s => s.consecutiveDays || 1), 1);
    }
  } catch { /* keep defaults */ }

  // 市场宽度
  let advancing = 0, declining = 0, advDecRatio = "1:1", mktSentiment = "中性";
  try {
    const breadth = await cached(`breadth_${t}`, () => m.getMarketBreadth(), ttl.mkt);
    advancing = breadth?.advancing ?? 0;
    declining = breadth?.declining ?? 0;
    advDecRatio = breadth?.advDecRatio ?? "1:1";
    mktSentiment = breadth?.sentiment ?? "中性";
  } catch { /* keep defaults */ }

  // 非交易日判断：周末或涨跌家数为0
  const isOffDay = isWeekend() || (advancing === 0 && declining === 0);
  const dataIsStale = limitUpCount === 0 && isOffDay;

  // 题材热度
  let hotTopicCount = 0;
  let hotReasonList = [];
  const reasonMap = new Map();
  try {
    hotReasonList = await cached(`hotreason_${t}`, () => m.thsHotReason(), ttl.mkt) || [];
    for (const r of hotReasonList.slice(0, 50)) {
      const tags = (r.reason || "").split(/[,，、]/).map(t => t.trim()).filter(Boolean);
      for (const t of tags) reasonMap.set(t, (reasonMap.get(t) || 0) + 1);
    }
    hotTopicCount = [...reasonMap.entries()].filter(([, n]) => n >= 3).length;
  } catch { /* keep defaults */ }

  // ── 情绪阶段判定（养家+赵老哥+科比 合并标准） ──
  const upRatio = declining > 0 ? (advancing / declining) : (advancing > 0 ? 99 : 1);
  let phase, phaseLabel, positionPct, phaseColor;
  const hasLeader = maxConsecutive >= 4;

  // 非交易日：强制中性模式，不判主跌（数据来自上一交易日）
  if (dataIsStale) {
    phase = "offday"; phaseLabel = "休市日"; positionPct = 40; phaseColor = "#64748b";
  } else if (limitUpCount >= 50 && hasLeader && upRatio >= 1.5) {
    phase = "main-up"; phaseLabel = "主升期"; positionPct = 80; phaseColor = "#dc2626";
  } else if (limitUpCount >= 30 && upRatio >= 1.2 && (hasLeader || hotTopicCount >= 3)) {
    phase = "trial"; phaseLabel = "试错期"; positionPct = 50; phaseColor = "#f59e0b";
  } else if (limitUpCount >= 15 && advancing >= declining * 0.7) {
    phase = "swing"; phaseLabel = "震荡期"; positionPct = 30; phaseColor = "#64748b";
  } else {
    phase = "decline"; phaseLabel = "主跌期"; positionPct = 15; phaseColor = "#16a34a";
    // 主跌期仍有15%仓位，用于轻仓试错（退学炒股：冰点试错布局下一周期）
  }

  // 龙头识别（连板TOP3 + 题材有梯队）
  const leaders = [];
  if (limitStocks.length) {
    try {
      const topN = limitStocks.slice(0, 10);
      const analyzed = await m.analyzeConsecutiveLimitUp(topN, 10);
      const sorted = analyzed.sort((a, b) => (b.consecutiveDays || 0) - (a.consecutiveDays || 0));
      for (const s of sorted.slice(0, 5)) {
        if ((s.consecutiveDays || 1) >= 2) {
          leaders.push({
            code: s.code, name: s.name,
            boards: s.consecutiveDays || 1,
            turnoverPct: s.turnoverPct || 0,
            amount: s.amount || 0,
          });
        }
      }
    } catch { /* skip */ }
  }

  // 兜底：非交易日涨停板为空时，从同花顺强势股中推估龙头
  if (leaders.length === 0 && hotReasonList.length > 0) {
    // 按 涨幅×换手率 复合分排序（换手率高说明市场共识强）
    const nearLimit = hotReasonList
      .filter(s => s.changePct >= 5)
      .sort((a, b) => {
        const sa = (a.changePct || 0) * Math.min(a.turnoverPct || 0, 50);
        const sb = (b.changePct || 0) * Math.min(b.turnoverPct || 0, 50);
        return sb - sa;
      })
      .slice(0, 5);
    for (const s of nearLimit) {
      leaders.push({
        code: s.code, name: s.name,
        boards: 1,
        turnoverPct: s.turnoverPct || 0,
        amount: s.amount || 0,
        _estimated: true,
      });
    }
    if (leaders.length) maxConsecutive = Math.max(maxConsecutive, 1);
  }

  return {
    phase, phaseLabel, positionPct, phaseColor,
    limitUpCount, maxConsecutive, hotTopicCount,
    advancing, declining, advDecRatio, mktSentiment,
    totalAmount, leaders, dataIsStale,
  };
}

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

function analyzeKLine(rows, price) {
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
  const trend = ma5 > ma10 && ma10 > ma20 ? "多头排列" : curr > ma20 ? "偏多" : curr > ma10 ? "震荡" : "偏弱";
  const vols = rows.slice(-5).map(r => r.volume);
  const volTrend = vols[4] < vols[0] * 0.7 ? "缩量" : vols[4] > vols[0] * 1.5 ? "放量" : "平量";
  return {
    ma5: +ma5.toFixed(2), ma10: +ma10.toFixed(2), ma20: +ma20.toFixed(2),
    distMA5: +((price - ma5) / ma5 * 100).toFixed(1),
    distMA10: +((price - ma10) / ma10 * 100).toFixed(1),
    trend, dayChg: +dayChg.toFixed(2), wChg: +wChg.toFixed(2), volTrend,
  };
}

// ── 智能板块筛选 ──
// 从 eastmoneyConceptBlocks 返回的 boards 中优选有辨识度的概念板块，
// 过滤宽泛的行业分类/地区标签/交易属性标签，优先保留：
//   1. 该股是板块龙头
//   2. 板块名匹配该股上涨原因关键词
//   3. 板块涨跌幅高（板块效应强）
function pickConceptBoards(cb, stockName, reason) {
  if (!cb?.boards?.length) return (cb?.conceptTags || []).slice(0, 5);

  const generic = new Set([
    "融资融券", "深股通", "沪股通", "富时罗素", "标准普尔", "MSCI中国",
    "中证500", "沪深300", "上证180", "上证50", "深证100", "创业板指",
    "转融券标的", "AB股", "QFII重仓", "机构重仓", "基金重仓", "券商重仓",
    "信托重仓", "保险重仓", "社保重仓", "养老金", "证金持股", "汇金持股",
  ]);
  const isProvince = /(?:广东|北京|上海|浙江|江苏|山东|安徽|湖北|湖南|四川|福建|河南|河北|辽宁|天津|重庆|陕西|江西|云南|广西|山西|贵州|黑龙江|吉林|内蒙古|新疆|甘肃|海南|宁夏|青海|西藏)板块$/;
  const isAdmin = /^(?:昨日|最近|近[日周月]|持续|微盘|小盘|中盘|大盘|亏损|预[增减亏]|送转|除[权息]|高[频连]|破[发净增]|题材|趋势|反转|昨日)/;

  const kw = (reason || "").split(/[+,，、\s]+/).map(t => t.trim()).filter(Boolean);

  const scored = cb.boards
    .filter(b => {
      if (generic.has(b.name)) return false;
      if (isProvince.test(b.name)) return false;
      if (isAdmin.test(b.name)) return false;
      return true;
    })
    .map(b => {
      let score = 0;
      if (b.leadStock === stockName) score += 100;
      for (const w of kw) {
        if (w.length >= 2 && (b.name.includes(w) || w.includes(b.name))) score += 50;
      }
      score += Math.min(99, Math.max(0, (b.changePct || 0) * 20));
      return { name: b.name, score };
    })
    .sort((a, b) => b.score - a.score);

  const top = scored.slice(0, 5).map(b => b.name);
  // 兜底：如果过滤后不足3个，从原始 conceptTags 中补
  if (top.length < 3 && cb.conceptTags?.length) {
    for (const t of cb.conceptTags) {
      if (!top.includes(t) && !generic.has(t) && !isProvince.test(t) && !isAdmin.test(t)) {
        top.push(t);
        if (top.length >= 5) break;
      }
    }
  }
  return top;
}

// ── 策略评分（六位游资共性量化版） ──
function scoreSignal(stock, emotion) {
  const k = stock.kline;
  const ff = stock.fundFlow;
  if (!k) return null;

  const turn = stock.turnover || 0;
  const chg = stock.changePct || 0;
  const phase = emotion?.phase || "swing";

  // 情绪周期加权基准分（养家：不同周期不同期待值）
  const baseByPhase = { "main-up": 54, "trial": 50, "swing": 46, "decline": 42, "offday": 48 };
  let score = baseByPhase[phase] || 44;
  const reasons = [];

  // 趋势
  const trendStrong = k.trend === "多头排列";
  const trendWeak = k.trend === "偏弱";
  const aboveMA5 = k.ma5 > k.ma10;
  const belowMA10 = stock.price < k.ma10 * 0.97;
  const nearMA5 = Math.abs(k.distMA5) < 3;
  const nearMA10 = Math.abs(k.distMA10) < 3;

  // 量价
  const volShrink = k.volTrend === "缩量";
  const volExpand = k.volTrend === "放量";
  const dayUp = chg > 2;
  const dayDown = chg < -2;
  const wUp = k.wChg > 5;
  const wDown = k.wChg < -5;

  // 资金
  let mainIn3 = false, mainOut3 = false, strongIn5 = false, strongOut5 = false;
  let consIn5 = false, consOut5 = false;
  if (ff) {
    mainIn3 = ff.main3d > 0;
    mainOut3 = ff.main3d < 0;
    strongIn5 = ff.main5d > 5000;
    strongOut5 = ff.main5d < -5000;
    consIn5 = ff.consDays >= 5 && ff.consDir === "流入";
    consOut5 = ff.consDays >= 5 && ff.consDir === "流出";
  }

  // ── 龙头识别（赵老哥+92科比+养家 合并） ──
  const isLeader = emotion?.leaders?.some(l => l.code === stock.code);
  const isMidPosition = stock.consecutiveDays >= 4 && stock.consecutiveDays <= 6
    && !emotion?.leaders?.some(l => l.code === stock.code && l.boards >= 7);
  const turnDeath = turn > 70;

  // ── 加分项 ──
  if (isLeader) {
    score += 20; reasons.push("🏆市场龙头");
    if (turn >= 10 && turn <= 40) { score += 5; reasons.push("换手健康"); }
    if (turnDeath) { score -= 8; reasons.push("⚠死亡换手"); }
  }

  // 题材有梯队（养家：板块联动≥3只才可靠）
  if (stock.sectorSupport >= 3) {
    score += 6; reasons.push("题材有梯队");
  }

  // 金叉启动：MA5>MA10 + 放量涨 + 主力流入
  if (aboveMA5 && volExpand && dayUp && mainIn3) {
    score += 22; reasons.push("金叉启动");
  }
  // 主力吸筹：连续5日流入 + 回踩均线（养家：主力拿货信号）
  if (consIn5 && (nearMA5 || nearMA10) && !trendWeak) {
    score += 18; reasons.push("主力吸筹");
  }
  // 缩量企稳：缩量回踩5日线（退学炒股：弱转强前兆）
  if (volShrink && nearMA5 && !mainOut3 && !trendWeak && !dayDown) {
    score += 14; reasons.push("缩量企稳");
  }
  // 趋势多头
  if (trendStrong) { score += 10; reasons.push("多头排列"); }
  // 均线偏多
  if (aboveMA5) { score += 6; reasons.push("MA5>MA10"); }
  // 回踩均线
  if (nearMA5) { score += 5; reasons.push("近5日线"); }
  else if (nearMA10) { score += 3; reasons.push("近10日线"); }
  // 主力流入
  if (strongIn5) { score += 8; reasons.push("主力5日净流入"); }
  else if (mainIn3) { score += 4; reasons.push("主力3日净流入"); }
  // 连续流入
  if (consIn5) { score += 5; reasons.push(`连续${ff.consDays}日流入`); }
  // 量能健康
  if (volShrink && !dayDown) { score += 3; reasons.push("缩量健康"); }
  // 放量突破（赵老哥：突破压力位+放量）
  if (volExpand && dayUp && aboveMA5) { score += 5; reasons.push("放量突破"); }
  // 热门题材
  if (stock.inHotTopic) { score += 5; reasons.push("热门题材"); }
  // 龙虎榜偏多
  if (stock.dtBull) { score += 8; reasons.push("龙虎榜偏多"); }
  // 涨停时间早（北京炒家：早盘板确定性高）
  if (stock.limitTime === "early") { score += 4; reasons.push("早盘封板"); }

  // ── 减分项 ──
  if (isMidPosition) {
    score -= 12; reasons.push("⚠中位股风险");
  }
  if (trendWeak) { score -= 12; reasons.push("趋势偏弱"); }
  if (belowMA10) { score -= 10; reasons.push("跌破10日线"); }
  if (strongOut5) { score -= 12; reasons.push("主力5日净流出"); }
  else if (mainOut3) { score -= 6; reasons.push("主力3日净流出"); }
  if (consOut5) { score -= 8; reasons.push(`连续${ff?.consDays||0}日流出`); }
  if (wDown) { score -= 7; reasons.push("5日跌幅大"); }
  if (wUp && consOut5) { score -= 10; reasons.push("高位背离"); }
  if (dayDown && volExpand) { score -= 5; reasons.push("放量下跌"); }
  if (turnDeath) { score -= 8; reasons.push("死亡换手>70%"); }

  // 市场情绪修正（养家：极端情况降预期，但不重复惩罚）
  if (!emotion?.dataIsStale && emotion?.limitUpCount < 10) { score -= 5; reasons.push("涨停稀少"); }
  if (phase === "decline" && !emotion?.dataIsStale) { score -= 5; reasons.push("主跌期谨慎"); }

  // 做T信号
  let tFlag = false;
  if (turn > 5 && Math.abs(chg) < 5 && !trendWeak) { tFlag = true; reasons.push("高换手可做T"); }
  if (Math.abs(chg) > 3 && turn > 3 && !trendWeak) { tFlag = true; reasons.push("波动大可做T"); }

  score = Math.max(10, Math.min(98, score));

  const buyTh = phase === "main-up" ? 75 : phase === "trial" ? 78 : phase === "decline" ? 82 : 80;
  const addTh = phase === "main-up" ? 60 : phase === "trial" ? 62 : phase === "decline" ? 68 : 64;

  let action;
  if (score >= buyTh) action = "买入";
  else if (score >= addTh) action = "加仓";
  else if (score >= 55) action = tFlag ? "做T" : "关注";
  else if (score >= 40) action = "观望";
  else action = "回避";

  return { score, action, reasons: reasons.slice(0, 8), tFlag, isLeader };
}

async function main() {
  const m = await getMod();
  const now = new Date().toLocaleString("zh-CN", { hour12: false });
  const today = new Date().toISOString().slice(0, 10);
  const log = console.log;

  log(`\n${"=".repeat(60)}`);
  log(`  短线信号扫描（六位游资量化版）— ${now}`);
  log(`${"=".repeat(60)}\n`);

  // ── 1. 情绪周期检测 ──
  log("1/5 情绪周期检测...");
  const emotion = await detectEmotionCycle(m);
  log(`  阶段: ${emotion.phaseLabel} | 涨停${emotion.limitUpCount}只 | 最高${emotion.maxConsecutive}板 | 建议仓位${emotion.positionPct}%`);
  if (emotion.leaders.length) {
    log(`  龙头: ${emotion.leaders.slice(0, 3).map(l => `${l.name}(${l.boards}板)`).join(" · ")}`);
  }

  const t = todayStr();
  const ttl = cacheTTL();

  // ── 2. 获取强势股 + 热门题材（一次调用复用两份逻辑）──
  log("2/5 获取强势股池...");
  let hotStocks = [];
  let hotTopics = [];
  try {
    hotStocks = await cached(`hotreason_${t}`, () => m.thsHotReason(), ttl.mkt) || [];
    log(`  强势股: ${hotStocks.length}只`);

    if (hotStocks.length) {
      const reasonMap = new Map();
      for (const r of hotStocks.slice(0, 50)) {
        const tags = (r.reason || "").split(/[,，、]/).map(t => t.trim()).filter(Boolean);
        for (const t of tags) reasonMap.set(t, (reasonMap.get(t) || 0) + 1);
      }
      hotTopics = [...reasonMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t]) => t);
      log(`  热门题材: ${hotTopics.length}个`);
    }
  } catch (e) { log("  强势股获取失败:", e.message); }

  // 题材强度（涨停≥3只同板块才叫有梯队——养家标准）
  const sectorCounts = new Map();
  if (emotion.leaders.length) {
    for (const l of emotion.leaders.slice(0, 5)) {
      try {
        const cb = await cached(`concept_${l.code}_${t}`, () => m.eastmoneyConceptBlocks(l.code), ttl.stock);
        const tags = pickConceptBoards(cb, l.name, l.reason || "");
        for (const t of tags) {
          sectorCounts.set(t, (sectorCounts.get(t) || 0) + 1);
        }
      } catch { /* skip */ }
    }
  }

  // ── 3. 筛选候选 ──
  const poolSize = emotion.phase === "main-up" ? 50 : emotion.phase === "offday" ? 50 : emotion.phase === "trial" ? 40 : 30;
  // 按 涨幅×换手率 复合分排序（兼顾价格强度与市场参与度）
  hotStocks.sort((a, b) => {
    const sa = (a.changePct || 0) * Math.min(a.turnoverPct || 0, 50);
    const sb = (b.changePct || 0) * Math.min(b.turnoverPct || 0, 50);
    return sb - sa;
  });
  const candidates = hotStocks.slice(0, poolSize);
  log(`3/5 逐只分析(${candidates.length}只, ${emotion.phaseLabel}模式)...`);

  // 批量获取行情（缓存 + 一次HTTP调用）
  let quotes = {};
  try {
    const codes = candidates.map(s => s.code);
    quotes = await cached(`quotes_${t}`, () => m.tencentQuote(codes).then(r => r || {}), ttl.mkt);
  } catch { /* skip */ }

  // 并行分批处理（每批6只，减少串行等待）
  const BATCH = 6;
  const results = [];
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(async (s) => {
        const code = s.code;
        const quote = quotes[code];
        if (!quote) return null;
        if (/^(\*?ST|N|退|C)/.test(quote.name)) return null;

        const stock = {
          code, name: quote.name, price: quote.price,
          changePct: quote.changePct, pe: quote.peTtm, pb: quote.pb,
          mcap: quote.mcapYi, turnover: quote.turnoverPct,
          reason: s.reason || "",
          inHotTopic: hotTopics.some(t => (s.reason || "").includes(t)),
          sectorSupport: 0,
          consecutiveDays: 0,
          quoteTime: new Date().toLocaleString("zh-CN", { hour12: false }),
        };

        // 连板天数
        const luMatch = emotion.leaders.find(l => l.code === code);
        if (luMatch) stock.consecutiveDays = luMatch.boards;

        // 并行拉取：K线 + 概念板块 + 资金流（均缓存）
        const [klineRows, cb, flows] = await Promise.all([
          cached(`kline_${code}_${t}`, () => fetchKLine(code).catch(() => null), ttl.stock),
          cached(`concept_${code}_${t}`, () => m.eastmoneyConceptBlocks(code).catch(() => null), ttl.stock),
          cached(`flow_${code}_${t}`, () => m.stockFundFlow120d(code).catch(() => []), ttl.stock),
        ]);

        // K线
        stock.kline = analyzeKLine(klineRows, stock.price);

        // 概念板块（智能筛选，同时用于 sectorSupport + conceptTags）
        stock.conceptTags = pickConceptBoards(cb, stock.name, stock.reason);
        stock.industry = stock.conceptTags[0] || (cb?.boards || [])[0]?.name || "";
        for (const t of stock.conceptTags) {
          if ((sectorCounts.get(t) || 0) >= 2) stock.sectorSupport++;
        }

        // 资金流
        if (flows?.length) {
          const sum = (arr, key, n) => arr.slice(-n).reduce((s, f) => s + (f[key] || 0), 0);
          stock.fundFlow = {
            today: flows[flows.length - 1],
            main3d: sum(flows, "mainNet", 3),
            main5d: sum(flows, "mainNet", 5),
            main10d: sum(flows, "mainNet", 10),
          };
          let consDays = 0;
          for (let i = flows.length - 1; i >= 0; i--) {
            if ((flows[i].mainNet > 0) === (flows[flows.length - 1].mainNet > 0)) consDays++;
            else break;
          }
          stock.fundFlow.consDays = consDays;
          stock.fundFlow.consDir = flows[flows.length - 1].mainNet > 0 ? "流入" : "流出";
        }

        // 评分
        const signal = scoreSignal(stock, emotion);
        if (signal && signal.score >= 40) {
          stock.score = signal.score;
          stock.action = signal.action;
          stock.signals = signal.reasons;
          stock.tFlag = signal.tFlag;
          stock.isLeader = signal.isLeader;
          return stock;
        }
        return null;
      })
    );

    for (const r of batchResults) {
      if (r) results.push(r);
    }
    process.stderr.write(".");
  }
  process.stderr.write("\n");

  // ── 4. 排序 ──
  results.sort((a, b) => b.score - a.score);
  log(`4/5 有效信号: ${results.length}只`);
  log(`  买入(${results.filter(r => r.action === "买入").length}) 加仓(${results.filter(r => r.action === "加仓").length}) 做T(${results.filter(r => r.action === "做T").length}) 关注(${results.filter(r => r.action === "关注").length})`);

  // ── 5. 市场情绪 + 输出 ──
  let market = {};
  try {
    const north = await m.hsgtRealtime().catch(() => null);
    const hgt = north?.hgt?.filter(v => v != null).pop() ?? null;
    const sgt = north?.sgt?.filter(v => v != null).pop() ?? null;
    market = {
      advDecRatio: emotion.advDecRatio,
      sentiment: emotion.mktSentiment,
      advancing: emotion.advancing,
      declining: emotion.declining,
      flat: 0,
      northbound: { hgt, sgt, total: (hgt != null && sgt != null) ? +(hgt + sgt).toFixed(1) : null },
      hotTopics,
    };
  } catch { /* skip */ }

  const emotionOutput = {
    phase: emotion.phase,
    phaseLabel: emotion.phaseLabel,
    positionPct: emotion.positionPct,
    phaseColor: emotion.phaseColor,
    limitUpCount: emotion.limitUpCount,
    maxConsecutive: emotion.maxConsecutive,
    hotTopicCount: emotion.hotTopicCount,
    leaders: emotion.leaders.map(l => ({
      code: l.code, name: l.name,
      boards: l.boards,
      turnoverPct: l.turnoverPct,
      amount: l.amount,
    })),
    positionAdvice: emotion.positionPct >= 80 ? "市场情绪高涨，可重仓出击龙头"
      : emotion.positionPct >= 50 ? "情绪尚可，中等仓位参与"
      : emotion.positionPct >= 30 ? "情绪偏弱，轻仓试错或观望"
      : emotion.phase === "offday" ? "非交易日，数据为上一交易日快照"
      : "主跌期，轻仓试错布局下一周期",
  };

  const report = {
    date: today, generatedAt: now,
    total: results.length,
    emotion: emotionOutput,
    sentiment: market,
    results: results.map(r => ({
      code: r.code, name: r.name, price: r.price,
      quoteTime: r.quoteTime,
      changePct: r.changePct, pe: r.pe, mcap: r.mcap,
      turnover: r.turnover, reason: r.reason,
      score: r.score, action: r.action, signals: r.signals,
      tFlag: r.tFlag || false, isLeader: r.isLeader || false,
      trend: r.kline?.trend || "",
      ma5: r.kline?.ma5, ma10: r.kline?.ma10,
      distMA5: r.kline?.distMA5, distMA10: r.kline?.distMA10,
      volTrend: r.kline?.volTrend,
      wChg: r.kline?.wChg,
      fundFlow: r.fundFlow ? {
        today: r.fundFlow.today,
        main3d: r.fundFlow.main3d, main5d: r.fundFlow.main5d,
        consDays: r.fundFlow.consDays, consDir: r.fundFlow.consDir,
      } : null,
      industry: r.industry || "",
      conceptTags: r.conceptTags || [],
      dragonTiger: r.dragonTiger || null,
      dtBull: r.dtBull || false, dtBear: r.dtBear || false,
    })),
  };

  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const outFile = join(OUT, `short-term-${today}.json`);
  writeFileSync(outFile, JSON.stringify(report, null, 2), "utf-8");
  log(`\n5/5 短线信号报告: ${outFile}`);

  // 自动归档到 history/（供回测使用）
  const histDir = join(PROJECT, "history");
  if (!existsSync(histDir)) mkdirSync(histDir, { recursive: true });
  writeFileSync(join(histDir, `${today}.json`), JSON.stringify(report, null, 2), "utf-8");
  log(`  历史快照已归档: history/${today}.json`);

  log(`${"=".repeat(60)}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
