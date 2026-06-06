/**
 * 短线信号扫描 — 基于20条策略规则打分
 * 用法: node scripts/short-term-scan.mjs
 */
import { writeFileSync, existsSync, mkdirSync } from "fs";
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

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 情绪周期检测（六位游资共性） ──────────────────────
function isWeekend(date) {
  const d = date ? new Date(date) : new Date();
  return d.getDay() === 0 || d.getDay() === 6;
}

async function detectEmotionCycle(m) {
  let limitUpCount = 0, maxConsecutive = 1, totalAmount = 0;
  let limitStocks = [];

  try {
    const lu = await m.getLimitUpBoard(200);
    limitUpCount = lu.total || 0;
    limitStocks = (lu.stocks || []).slice(0, 30);
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
    const breadth = await m.getMarketBreadth();
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
    hotReasonList = await m.thsHotReason() || [];
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
    const nearLimit = hotReasonList
      .filter(s => s.changePct >= 9.5)
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, 5);
    for (const s of nearLimit) {
      leaders.push({
        code: s.code, name: s.name,
        boards: 1, // 无法确定连板数，标记为1
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
  const turnDeath = turn > 70; // 死亡换手（92科比）

  // ── 加分项 ──
  // 🏆 龙头辨识度（赵老哥+92科比：龙头溢价是最确定的利润）
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
  // ⚠️ 中位股回避（92科比+养家：4进5/5进6亏钱效率最高）
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

  // 情绪阶段影响操作阈值（主升期更积极，主跌期更严格）
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

  // ── 2. 获取强势股 + 热门题材 ──
  log("2/5 获取强势股池...");
  let hotStocks = [];
  let hotTopics = [];
  try {
    hotStocks = await m.thsHotReason() || [];
    log(`  强势股: ${hotStocks.length}只`);
  } catch (e) { log("  强势股获取失败:", e.message); }

  try {
    const hr = await m.thsHotReason();
    if (hr?.length) {
      const reasonMap = new Map();
      for (const r of hr.slice(0, 50)) {
        const tags = (r.reason || "").split(/[,，、]/).map(t => t.trim()).filter(Boolean);
        for (const t of tags) reasonMap.set(t, (reasonMap.get(t) || 0) + 1);
      }
      hotTopics = [...reasonMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t]) => t);
      log(`  热门题材: ${hotTopics.length}个`);
    }
  } catch { /* skip */ }

  // 题材强度（涨停≥3只同板块才叫有梯队——养家标准）
  const sectorCounts = new Map();
  if (emotion.leaders.length) {
    for (const l of emotion.leaders.slice(0, 5)) {
      try {
        const cb = await m.eastmoneyConceptBlocks(l.code);
        for (const t of (cb?.conceptTags || []).slice(0, 5)) {
          sectorCounts.set(t, (sectorCounts.get(t) || 0) + 1);
        }
      } catch { /* skip */ }
    }
  }

  // ── 3. 筛选候选 ──
  // 主升期扩大候选池（赵老哥：主升要敢上仓位），震荡期缩小
  const poolSize = emotion.phase === "main-up" ? 40 : emotion.phase === "offday" ? 30 : emotion.phase === "trial" ? 30 : 20;
  const candidates = hotStocks.slice(0, poolSize);
  log(`3/5 逐只分析(${candidates.length}只, ${emotion.phaseLabel}模式)...`);

  const results = [];
  for (const s of candidates) {
    process.stderr.write(".");
    const code = s.code;

    let quote = null;
    try {
      const qs = await m.tencentQuote([code]);
      quote = qs[code];
    } catch { /* skip */ }
    if (!quote) continue;

    // 过滤ST/退市/新股（名称含ST/*ST/N/退）
    if (/^(\*?ST|N|退|C)/.test(quote.name)) continue;

    // 题材梯队支持度
    let sectorSupport = 0;
    try {
      const cb = await m.eastmoneyConceptBlocks(code);
      for (const t of (cb?.conceptTags || [])) {
        if ((sectorCounts.get(t) || 0) >= 2) sectorSupport++;
      }
    } catch { /* skip */ }

    const stock = {
      code, name: quote.name, price: quote.price,
      changePct: quote.changePct, pe: quote.peTtm, pb: quote.pb,
      mcap: quote.mcapYi, turnover: quote.turnoverPct,
      reason: s.reason || "",
      inHotTopic: hotTopics.some(t => (s.reason || "").includes(t)),
      sectorSupport,
      consecutiveDays: 0,
    };

    // 连板天数（匹配龙头列表）
    const luMatch = emotion.leaders.find(l => l.code === code);
    if (luMatch) stock.consecutiveDays = luMatch.boards;

    // K线
    try {
      const rows = await fetchKLine(code);
      stock.kline = analyzeKLine(rows, stock.price);
    } catch { /* skip */ }

    // 资金流
    try {
      const flows = await m.stockFundFlow120d(code);
      if (flows?.length) {
        const sum = (arr, key, n) => arr.slice(-n).reduce((s, f) => s + (f[key] || 0), 0);
        stock.fundFlow = {
          today: flows[flows.length - 1],
          main3d: sum(flows, 'mainNet', 3),
          main5d: sum(flows, 'mainNet', 5),
          main10d: sum(flows, 'mainNet', 10),
        };
        let consDays = 0;
        for (let i = flows.length - 1; i >= 0; i--) {
          if ((flows[i].mainNet > 0) === (flows[flows.length - 1].mainNet > 0)) consDays++;
          else break;
        }
        stock.fundFlow.consDays = consDays;
        stock.fundFlow.consDir = flows[flows.length - 1].mainNet > 0 ? '流入' : '流出';
      }
    } catch { /* skip */ }

    // 概念板块
    try {
      const cb = await m.eastmoneyConceptBlocks(code);
      if (cb?.conceptTags?.length) {
        stock.conceptTags = cb.conceptTags.slice(0, 5);
        stock.industry = (cb.boards || [])[0]?.name || "";
      }
    } catch { /* skip */ }

    // 龙虎榜
    try {
      const dt = await m.dragonTigerBoard(code, today, 30);
      if (dt?.records?.length) {
        stock.dragonTiger = { count: dt.records.length, latest: dt.records[0] };
        const allSeats = [
          ...(dt.seats?.buy || []).map(s => ({ ...s, side: "buy" })),
          ...(dt.seats?.sell || []).map(s => ({ ...s, side: "sell" })),
        ];
        const netSum = allSeats.reduce((s, seat) => s + (seat.net || 0), 0);
        stock.dtBull = netSum > 3000;
        stock.dtBear = netSum < -3000;
      }
    } catch { /* skip */ }

    // 评分（传入情绪数据）
    const signal = scoreSignal(stock, emotion);
    if (signal && signal.score >= 40) {
      stock.score = signal.score;
      stock.action = signal.action;
      stock.signals = signal.reasons;
      stock.tFlag = signal.tFlag;
      stock.isLeader = signal.isLeader;
      results.push(stock);
    }

    await delay(600);
  }
  process.stderr.write("\n");

  // ── 4. 排序 ──
  results.sort((a, b) => b.score - a.score);
  log(`4/5 有效信号: ${results.length}只`);
  log(`  买入(${results.filter(r => r.action === '买入').length}) 加仓(${results.filter(r => r.action === '加仓').length}) 做T(${results.filter(r => r.action === '做T').length}) 关注(${results.filter(r => r.action === '关注').length})`);

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
  log(`${"=".repeat(60)}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
