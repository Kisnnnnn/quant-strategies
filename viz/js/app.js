/**
 * A股短线策略可视化 — 主应用逻辑
 */

// ── State ──────────────────────────────────────────────
let DATA = {};
let STRATEGIES = [];
let activeStrategy = "";
let sortCol = "score";
let sortDir = -1;
let charts = {};
let klineCharts = {};

const HOT_SECTORS = [
  "机器人", "人形机器人", "CPO", "光通信", "光模块", "AI", "人工智能", "大模型",
  "半导体", "芯片", "存储芯片", "算力", "数据中心", "液冷",
  "新能源车", "自动驾驶", "智能驾驶", "固态电池", "低空经济", "飞行汽车",
  "商业航天", "量子", "光伏", "逆变器", "新质生产力", "工业母机",
];

function isHot(r) {
  const tags = [...(r.conceptTags || []), ...(r.industries || [])];
  return tags.some(t => HOT_SECTORS.some(h => t.includes(h)));
}

const NAME_MAP = {
  "band-dip": "波段回调",
  "dragon-reverse": "龙回头",
  "short-term": "短线信号",
};

function cnName(key) {
  return NAME_MAP[key] || key;
}

function isShortTerm() { return activeStrategy === "short-term"; }
function isBand() { return activeStrategy === "band-dip"; }

// ── 操作建议（统一版，与复盘分析格式一致）────────────────
function candidateAdvice(r) {
  const st = isShortTerm();
  const sc = r.confidence ?? r.score ?? 50;
  const pe = r.pe || 0;
  const turn = st ? (r.turnover || 0) : (r.turn || 0);
  const trend = r.trend || "";
  const aboveMA5 = r.ma5 && r.ma10 && +r.ma5 > +r.ma10;
  const nearMA5 = r.ma5 && r.price && Math.abs((r.price - +r.ma5) / +r.ma5 * 100) < 3;
  const volShrink = st ? (r.volTrend === "缩量") : !!r.volShrink;
  const volExpand = st ? (r.volTrend === "放量") : (+r.volRatio > 1.5);
  const wChg = +r.wChg || 0;
  const dayChg = st ? (r.changePct || 0) : 0;

  // 资金面
  const ff = r.fundFlow;
  const mainIn3 = ff && ff.main3d > 0;
  const mainOut3 = ff && ff.main3d < 0;
  const strongIn5 = ff && ff.main5d > 5000;

  // ── 短线分析 ──
  const shortLines = [];
  if (trend) {
    shortLines.push(`趋势<span style="color:${trend.includes('多头')?'#16a34a':trend.includes('弱')?'#dc2626':'#d97706'}">${trend}</span>，MA5/10: ${r.ma5||'-'}/${r.ma10||'-'}`);
    if (aboveMA5) shortLines.push(`<span style="color:#16a34a">✓ MA5>MA10 短线偏多</span>`);
    else shortLines.push(`<span style="color:#dc2626">⚠ MA5<MA10 短线偏空，${r.price < +r.ma10 ? '股价跌破10日线' : '关注10日线支撑'}</span>`);
  }

  // 量价
  if (st) {
    if (r.volTrend) shortLines.push(`量能<span style="color:${volExpand?'#dc2626':volShrink?'#16a34a':'#64748b'}">${r.volTrend}</span>，5日涨<span style="color:${wChg>=0?'#dc2626':'#16a34a'}">${wChg}%</span>，换手${turn}%`);
  } else {
    if (r.volRatio) shortLines.push(`量比${r.volRatio}，5日涨<span style="color:${wChg>=0?'#dc2626':'#16a34a'}">${wChg}%</span>，换手${turn}%`);
  }
  if (nearMA5) shortLines.push(`<span style="color:#16a34a">✓ 贴近5日线，支撑附近</span>`);

  // 量价关系
  if (volExpand && wChg > 5) shortLines.push(`<span style="color:#d97706">⚡ 放量拉升，短线加速但有追高风险</span>`);
  if (volShrink && wChg > 0) shortLines.push(`<span style="color:#f59e0b">缩量上涨，动能减弱</span>`);
  if (volShrink && wChg < 0) shortLines.push(`<span style="color:#16a34a">✓ 缩量下跌，抛压衰减</span>`);

  // 资金面
  if (ff) {
    const todayMain = ff.today?.mainNet || 0;
    const dir = todayMain >= 0 ? '流入' : '流出';
    const clr = todayMain >= 0 ? '#dc2626' : '#16a34a';
    shortLines.push(`主力: 今日<span style="color:${clr}">${dir}${(Math.abs(todayMain)/1e4).toFixed(0)}万</span>，3日${(ff.main3d/1e4).toFixed(0)}万，5日${(ff.main5d/1e4).toFixed(0)}万`);
    if (ff.consDays >= 3) shortLines.push(`<span style="color:${ff.consDir==='流入'?'#dc2626':'#16a34a'}">主力连续${ff.consDays}日${ff.consDir}</span>`);
  }

  if (turn > 10) shortLines.push(`换手${turn}% 交投活跃，波动大`);
  else if (turn < 2 && turn > 0) shortLines.push(`换手${turn}% 交投清淡`);

  // 龙虎榜
  if (st) {
    if (r.dragonTiger?.count) {
      const dtBull = r.dtBull ? ' · 偏多' : r.dtBear ? ' · 偏空' : '';
      shortLines.push(`龙虎榜: 近30天上榜${r.dragonTiger.count}次${dtBull}`);
    }
  } else if (r.dragonTiger?.recent?.length) {
    shortLines.push(`近期上榜${r.dragonTiger.recent.length}次，短线资金关注`);
  }

  // 操作建议
  let shortAction, shortColor, shortReason;
  if (st) {
    shortAction = r.action || '观望';
    shortColor = r.action === '买入' ? '#16a34a' : r.action === '加仓' ? '#16a34a' : r.action === '做T' ? '#f59e0b' : r.action === '关注' ? '#2563eb' : '#64748b';
    shortReason = (r.signals || []).slice(0, 3).join('+');
    shortLines.push(`<b style="color:${shortColor}">→ 短线: ${shortAction}</b> · 评分${r.score} · ${shortReason}`);
  } else {
    if (sc >= 85) { shortAction = "强烈关注"; shortColor = "#16a34a"; shortReason = "综合评分优秀，短线信号明确"; }
    else if (sc >= 70) { shortAction = "可关注"; shortColor = "#16a34a"; shortReason = "评分较高，关注入场时机"; }
    else if (sc >= 55) { shortAction = "观察"; shortColor = "#d97706"; shortReason = "信号尚可，等进一步确认"; }
    else { shortAction = "待观察"; shortColor = "#64748b"; shortReason = "信号偏弱，耐心等待"; }
    let hint = '';
    if (sc >= 70 && aboveMA5 && nearMA5) hint = ' · 回踩均线可入场';
    if (turn > 5 && Math.abs(wChg) < 3) hint = ' · 高换手适合做T';
    shortLines.push(`<b style="color:${shortColor}">→ 短线: ${shortAction}</b> · ${shortReason}${hint} · 评分${sc}${r.level ? '/'+r.level : ''}`);
  }

  // ── 长线分析 ──
  const longLines = [];
  if (pe > 0) {
    if (pe > 100) longLines.push(`PE ${pe.toFixed(0)}x，估值偏高，需业绩高速增长消化`);
    else if (pe > 50) longLines.push(`PE ${pe.toFixed(0)}x，中等偏高，关注增速能否匹配`);
    else if (pe > 20) longLines.push(`PE ${pe.toFixed(0)}x，估值合理`);
    else longLines.push(`PE ${pe.toFixed(0)}x，估值偏低，具有安全边际`);
  } else {
    longLines.push(`PE亏损，需关注扭亏时间点和业绩拐点`);
  }
  if (r.mcap) longLines.push(`市值${r.mcap}亿`);

  // DT机构动向
  if (r.dragonTiger?.institution) {
    const inst = r.dragonTiger.institution;
    if (inst.netAmt > 5000) longLines.push(`<span style="color:#16a34a">机构席位净买${inst.netAmt}万，中线资金认可</span>`);
    else if (inst.netAmt < -5000) longLines.push(`<span style="color:#dc2626">机构席位净卖${Math.abs(inst.netAmt)}万，中线资金撤离</span>`);
  }

  if (st && r.industry) {
    longLines.push(`行业: ${r.industry}`);
  } else if (r.industries?.length) {
    longLines.push(`板块: ${r.industries.slice(0, 3).join('、')}`);
  }
  if (r.conceptTags?.length) longLines.push(`概念: ${r.conceptTags.slice(0, 4).join('、')}`);

  let longAction, longColor;
  if (pe > 0 && pe < 30 && sc >= 70) { longAction = "具备长线价值"; longColor = "#16a34a"; }
  else if (pe > 100) { longAction = "估值偏高，短线为主"; longColor = "#d97706"; }
  else if (pe <= 0) { longAction = "等业绩拐点"; longColor = "#64748b"; }
  else { longAction = "可跟踪观察"; longColor = "#64748b"; }
  longLines.push(`<b style="color:${longColor}">→ 长线: ${longAction}</b>`);

  return {
    action: shortAction,
    actionColor: shortColor,
    shortHtml: shortLines.map(l => `<div style="margin-bottom:3px;font-size:11px;line-height:1.6">${l}</div>`).join(""),
    longHtml: longLines.map(l => `<div style="margin-bottom:3px;font-size:11px;line-height:1.6">${l}</div>`).join(""),
  };
}

// ── Init ───────────────────────────────────────────────
async function init() {
  try {
    const r = await fetch("/api/data");
    DATA = await r.json();
  } catch {
    document.getElementById("metaInfo").textContent = "无法加载数据，请确保 server.mjs 已启动";
    return;
  }

  STRATEGIES = Object.keys(DATA).filter(k => k !== "review");
  if (!STRATEGIES.length) {
    document.getElementById("metaInfo").textContent = "outputs/ 下暂无数据文件";
    return;
  }
  activeStrategy = STRATEGIES[0];

  const metas = STRATEGIES.map(s => `${cnName(s)}: ${DATA[s].total}条信号`).join(" · ");
  document.getElementById("metaInfo").textContent =
    `${metas} · ${Object.values(DATA)[0]?.generatedAt || "-"}`;

  renderSentiment();
  renderTabs();
  renderCards();
  renderCharts();
  renderFilters();
  renderTable();
}

// ── Sentiment ──────────────────────────────────────────
function renderSentiment() {
  const d = cur();
  const s = d.sentiment;
  const em = d.emotion; // 短线信号的情绪周期数据
  if (!s && !em) {
    document.getElementById("sentiment").innerHTML = "";
    return;
  }

  const ratio = (s?.advancing || 0) + (s?.declining || 0) + (s?.flat || 0);
  const sentimentCls = s?.sentiment === "强势" ? "sent-bull" : s?.sentiment === "偏强" ? "sent-bull" : s?.sentiment === "弱势" ? "sent-bear" : "sent-neutral";

  const nb = s?.northbound;
  const nbTotal = nb?.total != null ? nb.total : null;
  const nbCls = nbTotal != null ? (nbTotal > 0 ? "sent-bull" : nbTotal < 0 ? "sent-bear" : "sent-neutral") : "";

  // 情绪周期卡片（短线信号独有）
  const emotionCard = em ? `
    <div class="sent-card" style="border-left:4px solid ${em.phaseColor || '#64748b'}">
      <h3>情绪周期</h3>
      <div class="sent-row"><span>当前阶段</span><span class="val" style="color:${em.phaseColor};font-size:18px">${em.phaseLabel}</span></div>
      <div class="sent-row"><span>涨停家数</span><span class="val">${em.limitUpCount}只</span></div>
      <div class="sent-row"><span>最高连板</span><span class="val">${em.maxConsecutive}板</span></div>
      <div class="sent-row"><span>热门题材</span><span class="val">${em.hotTopicCount}个</span></div>
      <div class="sent-row"><span>建议仓位</span><span class="val" style="color:${em.phaseColor}">${em.positionPct}%</span></div>
      <div style="margin-top:8px;font-size:11px;color:var(--muted);line-height:1.5">${em.positionAdvice}</div>
      ${em.leaders?.length ? `
        <div style="margin-top:6px;font-size:11px;color:var(--muted)">龙头:</div>
        ${em.leaders.slice(0, 3).map(l => `<div style="font-size:11px;color:var(--accent);font-weight:500">${l.name} <span style="color:${em.phaseColor}">${l.boards}板</span></div>`).join("")}
      ` : ""}
    </div>
  ` : "";

  document.getElementById("sentiment").innerHTML = `
    ${emotionCard}

    <!-- 涨跌分布 -->
    <div class="sent-card">
      <h3>市场宽度</h3>
      <div class="sent-row"><span>情绪判断</span><span class="val ${sentimentCls}">${s?.sentiment || "-"}</span></div>
      <div class="sent-row"><span>涨跌比</span><span class="val">${s?.advDecRatio || "-"}</span></div>
      ${ratio > 0 ? `
      <div class="breadth-bar-wrap">
        <div class="breadth-bar">
          <div class="up" style="flex:${s.advancing}"></div>
          <div class="down" style="flex:${s.declining}"></div>
          <div class="flat" style="flex:${s.flat}"></div>
        </div>
        <div class="breadth-legend">
          <span><span class="dot" style="background:#22c55e"></span>上涨 ${s.advancing}</span>
          <span><span class="dot" style="background:#ef4444"></span>下跌 ${s.declining}</span>
          <span><span class="dot" style="background:#e2e8f0;border:1px solid #ccc"></span>平 ${s.flat}</span>
        </div>
      </div>
      ` : ""}
    </div>

    <!-- 涨跌停 -->
    <div class="sent-card">
      <h3>涨跌停</h3>
      <div class="sent-row"><span>涨停家数</span><span class="val sent-bull">${s?.limitUpCount ?? em?.limitUpCount ?? "-"}</span></div>
      <div class="sent-row"><span>跌停家数</span><span class="val sent-bear">${s?.limitDownCount ?? "-"}</span></div>
      ${s?.topLimitUps?.length ? `<div style="margin-top:6px;font-size:11px;color:var(--muted)">涨停TOP:</div>${s.topLimitUps.map(u => `<div style="font-size:11px;color:#16a34a">${u}</div>`).join("")}` : ""}
      ${s?.topLimitDowns?.length ? `<div style="margin-top:4px;font-size:11px;color:var(--muted)">跌停:</div>${s.topLimitDowns.map(d => `<div style="font-size:11px;color:#dc2626">${d}</div>`).join("")}` : ""}
    </div>

    <!-- 北向资金 -->
    <div class="sent-card">
      <h3>北向资金</h3>
      ${nbTotal != null ? `
        <div class="sent-row"><span>净流入</span><span class="val ${nbCls}">${nbTotal} 亿</span></div>
        <div class="sent-row"><span>沪股通</span><span class="val">${nb.hgt ?? "-"} 亿</span></div>
        <div class="sent-row"><span>深股通</span><span class="val">${nb.sgt ?? "-"} 亿</span></div>
      ` : `<div style="color:var(--muted);font-size:13px">数据获取中...</div>`}
    </div>
  `;
}

// ── Tabs ───────────────────────────────────────────────
function renderTabs() {
  document.getElementById("tabs").innerHTML = STRATEGIES.map((s, i) =>
    `<div class="tab${i === 0 ? " active" : ""}" onclick="switchTab('${s}')">${cnName(s)}</div>`
  ).join("");
}

window.switchTab = function (s) {
  activeStrategy = s;
  document.querySelectorAll(".tab").forEach((t, i) =>
    t.classList.toggle("active", STRATEGIES[i] === s)
  );
  renderSentiment();
  renderCards();
  renderCharts();
  renderFilters();
  renderTable();
};

// ── Helpers ────────────────────────────────────────────
function cur() { return DATA[activeStrategy] || { total: 0, results: [] }; }
function results() { return cur().results; }

// ── Cards ──────────────────────────────────────────────
function renderCards() {
  const d = cur();
  const res = d.results;
  const avg = res.length ? (res.reduce((s, r) => s + r.score, 0) / res.length).toFixed(1) : 0;
  const st = isShortTerm();
  const sN = st ? res.filter(r => r.action === '买入').length : res.filter(r => (r.quality || r.level) === "S").length;
  const aN = st ? res.filter(r => r.action === '加仓').length : res.filter(r => (r.quality || r.level) === "A").length;
  const sectors = new Set(res.map(r => cleanSector(st ? r.industry : r.industries?.[0])).filter(Boolean));
  const dragon = res.filter(r => r.dragonTiger?.latest || r.dragonTiger?.recent?.length).length;

  const leaderCount = st ? res.filter(r => r.isLeader).length : 0;
  const items = st ? [
    { l: "信号总数", v: d.total, sub: `买入${sN}·加仓${aN}·做T${res.filter(r=>r.action==='做T').length}` },
    { l: "平均评分", v: avg, sub: "满分100" },
    { l: "市场龙头", v: `${leaderCount}只`, sub: leaderCount ? "连板辨识度股" : "暂无龙头标的" },
    { l: "建议仓位", v: `${d.emotion?.positionPct || "-"}%`, sub: d.emotion?.phaseLabel || "-" },
    { l: "有龙虎榜", v: `${dragon}只`, sub: "近30天上榜" },
  ] : [
    { l: "信号总数", v: d.total, sub: `显示前${res.length}只` },
    { l: "平均评分", v: avg, sub: "满分100" },
    { l: "S/A级", v: `${sN}/${aN}`, sub: "高质量信号" },
    { l: "涉及板块", v: sectors.size, sub: "行业板块数" },
    { l: "有龙虎榜", v: `${dragon}只`, sub: "近30天上榜" },
  ];

  document.getElementById("cards").innerHTML = items.map(c =>
    `<div class="card"><div class="label">${c.l}</div><div class="value">${c.v}</div><div class="sub">${c.sub}</div></div>`
  ).join("");
}

function cleanSector(s) {
  return (s || "").replace(/\([^)]*\)/g, "");
}

// ── Charts ─────────────────────────────────────────────
function renderCharts() {
  Object.values(charts).forEach(c => c.destroy?.());
  charts = {};

  const res = results();
  const gridColor = "#e2e8f0";
  const tickColor = "#64748b";

  // 行业板块
  const sectorMap = new Map();
  for (const r of res) {
    const sec = cleanSector(isShortTerm() ? r.industry : r.industries?.[0]) || "其他";
    sectorMap.set(sec, (sectorMap.get(sec) || 0) + 1);
  }
  const sectorData = [...sectorMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);

  const sCtx = document.getElementById("sectorChart")?.getContext("2d");
  if (sCtx) {
    charts.sector = new Chart(sCtx, {
      type: "bar",
      data: {
        labels: sectorData.map(e => e[0]),
        datasets: [{
          label: "信号数", data: sectorData.map(e => e[1]),
          backgroundColor: sectorData.map((_, i) => i < 3 ? "#2563eb" : "#93c5fd"),
          borderRadius: 4,
        }]
      },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: gridColor }, ticks: { color: tickColor, stepSize: 1 } },
          y: { ticks: { color: tickColor, font: { size: 11 } } },
        },
      },
    });
  }

  // 概念板块热度
  const conceptMap = new Map();
  for (const r of res) {
    for (const tag of (r.conceptTags || [])) {
      conceptMap.set(tag, (conceptMap.get(tag) || 0) + 1);
    }
  }
  const conceptData = [...conceptMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  const cCtx = document.getElementById("conceptChart")?.getContext("2d");
  if (cCtx) {
    charts.concept = new Chart(cCtx, {
      type: "bar",
      data: {
        labels: conceptData.map(e => e[0]),
        datasets: [{
          label: "出现次数", data: conceptData.map(e => e[1]),
          backgroundColor: conceptData.map((_, i) => i < 3 ? "#7c3aed" : "#c4b5fd"),
          borderRadius: 4,
        }]
      },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: gridColor }, ticks: { color: tickColor, stepSize: 1 } },
          y: { ticks: { color: tickColor, font: { size: 11 } } },
        },
      },
    });
  }

  // 评分分布
  const bins = { "90-100": 0, "80-89": 0, "70-79": 0, "60-69": 0, "50-59": 0, "<50": 0 };
  for (const r of res) {
    const s = r.score;
    if (s >= 90) bins["90-100"]++;
    else if (s >= 80) bins["80-89"]++;
    else if (s >= 70) bins["70-79"]++;
    else if (s >= 60) bins["60-69"]++;
    else if (s >= 50) bins["50-59"]++;
    else bins["<50"]++;
  }

  const bCtx = document.getElementById("scoreChart")?.getContext("2d");
  if (bCtx) {
    const entries = Object.entries(bins);
    charts.score = new Chart(bCtx, {
      type: "bar",
      data: {
        labels: entries.map(e => e[0]),
        datasets: [{
          label: "数量", data: entries.map(e => e[1]),
          backgroundColor: ["#f59e0b", "#3b82f6", "#22c55e", "#94a3b8", "#cbd5e1", "#e2e8f0"],
          borderRadius: 4,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: gridColor }, ticks: { color: tickColor } },
          y: { ticks: { color: tickColor, stepSize: 1 } },
        },
      },
    });
  }
}

// ── Filters ────────────────────────────────────────────
let _savedFilters = {};  // { [strategy]: { search, sector, concept, quality } }

function renderFilters() {
  const res = results();
  const st = isShortTerm();

  // Load saved state for current strategy (or init empty)
  const filt = _savedFilters[activeStrategy] || (_savedFilters[activeStrategy] = { search: "", sector: "", concept: "", quality: "" });

  // Apply saved search
  const searchEl = document.getElementById("search");
  if (searchEl && searchEl.value !== filt.search) searchEl.value = filt.search;

  // 行业板块
  const secEl = document.getElementById("sectorFilter");
  const sectors = [...new Set(res.map(r => cleanSector(st ? r.industry : r.industries?.[0])).filter(Boolean))].sort();
  secEl.innerHTML = '<option value="">全部行业</option>' +
    sectors.map(s => `<option value="${s}"${filt.sector === s ? " selected" : ""}>${s}</option>`).join("");

  // 概念板块
  const conceptSet = new Set();
  for (const r of res) {
    for (const t of (r.conceptTags || [])) conceptSet.add(t);
  }
  const concepts = [...conceptSet].sort();
  const conEl = document.getElementById("conceptFilter");
  conEl.innerHTML = '<option value="">全部概念</option>' +
    concepts.map(c => `<option value="${c}"${filt.concept === c ? " selected" : ""}>${c}</option>`).join("");

  // 等级/操作筛选
  const qualEl = document.getElementById("qualityFilter");
  if (st) {
    const actions = ['买入','加仓','做T','关注','观望'];
    qualEl.innerHTML = '<option value="">全部操作</option>' +
      actions.map(a => `<option value="${a}"${filt.quality === a ? " selected" : ""}>${a}</option>`).join("");
  } else {
    const levels = ['S','A','B'];
    qualEl.innerHTML = '<option value="">全部等级</option>' +
      levels.map(l => `<option value="${l}"${filt.quality === l ? " selected" : ""}>${l}级</option>`).join("");
  }
}

// Save filter state on table render (called whenever filters change)
function saveFilters() {
  if (!activeStrategy) return;
  const filt = _savedFilters[activeStrategy] || (_savedFilters[activeStrategy] = { search: "", sector: "", concept: "", quality: "" });
  filt.search = document.getElementById("search")?.value || "";
  filt.sector = document.getElementById("sectorFilter")?.value || "";
  filt.concept = document.getElementById("conceptFilter")?.value || "";
  filt.quality = document.getElementById("qualityFilter")?.value || "";
}

// ── Table ──────────────────────────────────────────────
function renderTable() {
  saveFilters();
  const res = results();
  const search = document.getElementById("search").value.toLowerCase();
  const secF = document.getElementById("sectorFilter").value;
  const conF = document.getElementById("conceptFilter").value;
  const qualF = document.getElementById("qualityFilter").value;
  const st = isShortTerm();

  let filtered = [...res];
  if (search) filtered = filtered.filter(r => r.code.includes(search) || (r.name || "").includes(search));
  if (secF) filtered = filtered.filter(r => (st ? cleanSector(r.industry) === secF : (r.industries || []).some(i => cleanSector(i) === secF)));
  if (conF) filtered = filtered.filter(r => (r.conceptTags || []).includes(conF));
  if (qualF) filtered = st ? filtered.filter(r => r.action === qualF) : filtered.filter(r => (r.quality || r.level) === qualF);

  filtered.sort((a, b) => {
    let va, vb;
    if (sortCol === "score") { va = a.confidence ?? a.score; vb = b.confidence ?? b.score; }
    else if (sortCol === "code") { va = a.code; vb = b.code; }
    else if (sortCol === "trend") { va = a.trend || ""; vb = b.trend || ""; }
    else if (sortCol === "turn") { va = a.turn || 0; vb = b.turn || 0; }
    else if (sortCol === "mcap") { va = a.mcap || 0; vb = b.mcap || 0; }
    return (va > vb ? 1 : va < vb ? -1 : 0) * sortDir;
  });

  const hot = filtered.filter(isHot);
  const cold = filtered.filter(r => !isHot(r));

  document.getElementById("filterCount").textContent = `显示 ${filtered.length}/${res.length} 条 | 热门 ${hot.length} · 其他 ${cold.length}`;

  const band = isBand();
  const headers = st ? [
    { k: "score", l: "评分" },
    { k: "code", l: "代码" },
    { k: "", l: "名称" },
    { k: "trend", l: "趋势" },
    { k: "", l: "信号理由" },
    { k: "turn", l: "换手%" },
    { k: "", l: "PE" },
    { k: "", l: "操作" },
    { k: "mcap", l: "市值亿" },
    { k: "", l: "板块" },
  ] : [
    { k: "score", l: band ? "评分" : "龙性" },
    { k: "code", l: "代码" },
    { k: "", l: "名称" },
    { k: "trend", l: "趋势" },
    ...(band ? [
      { k: "", l: "信号" },
      { k: "", l: "离20线" },
    ] : [
      { k: "", l: "首波/回调" },
      { k: "", l: "天数" },
    ]),
    { k: "turn", l: "换手%" },
    { k: "", l: "PE" },
    { k: "score", l: "成功几率" },
    { k: "mcap", l: "市值亿" },
    { k: "", l: "板块" },
  ];

  const thead = headers.map(h => {
    const arrow = h.k === sortCol ? `<span class="sort-icon">${sortDir === 1 ? "▲" : "▼"}</span>` : "";
    const cls = h.k ? "sortable" : "";
    return `<th class="${cls}" ${h.k ? `onclick="window.sortBy('${h.k}')"` : ""}>${h.l}${arrow}</th>`;
  }).join("");

  function rowHTML(r) {
    const lvl = r.quality || r.level || "";
    const lvlCls = lvl === "S" ? "badge-S" : lvl === "A" ? "badge-A" : "";
    const mainSec = cleanSector((st ? r.industry : r.industries?.[0]) || "") || "-";
    const scCls = r.score >= 80 ? "score-high" : r.score >= 60 ? "score-mid" : "score-low";
    const adv = candidateAdvice(r);

    const actionBadge = st
      ? `<span style="background:${r.action==='买入'?'#16a34a':r.action==='加仓'?'#16a34a':r.action==='做T'?'#f59e0b':r.action==='关注'?'#2563eb':'#64748b'};color:#fff;padding:3px 10px;border-radius:10px;font-size:12px;font-weight:700;white-space:nowrap">${r.action||'-'}</span>`
      : `<span style="background:${adv.actionColor};color:#fff;padding:3px 10px;border-radius:10px;font-size:12px;font-weight:700;white-space:nowrap">${adv.action}</span>`;

    // Short-term: show signal reasons in the signal column
    const signalCell = st
      ? `<td style="font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(r.signals||[]).join('，')}">${(r.signals||[]).slice(0,2).join(' ')}</td>`
      : (band
        ? `<td style="font-size:11px;color:var(--muted)">${r.signals || "-"}</td><td>${r.distMA20 || "-"}</td>`
        : `<td style="font-size:11px">首波${r.firstWave || "-"} 回调${r.retrace || "-"}</td><td>${r.retraceDays || "-"}天</td>`);

    const colSpan = st ? 10 : 12;

    return `
    <tr onclick="window.toggleDetail('${r.code}', this)" style="border-left:4px solid ${st ? (r.action==='买入'?'#16a34a':r.action==='加仓'?'#16a34a':r.action==='做T'?'#f59e0b':'#64748b') : adv.actionColor}">
      <td><span class="${scCls}">${r.score}</span> ${lvlCls ? `<span class="${lvlCls}">${lvl}</span>` : ""}</td>
      <td style="font-family:monospace">${r.code}</td>
      <td>${r.name || ""} ${st && r.isLeader ? '<span style="background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700;margin-left:4px">龙头</span>' : ""} ${r.xueqiuUrl ? `<a class="xueqiu-link" href="${r.xueqiuUrl}" target="_blank" onclick="event.stopPropagation()">雪球</a>` : ""}</td>
      <td>${r.trend || "-"}</td>
      ${signalCell}
      <td>${r.turnover != null ? r.turnover : r.turn != null ? r.turn : "-"}</td>
      <td>${r.pe != null ? r.pe : "-"}</td>
      <td>${actionBadge}</td>
      <td>${r.mcap || "-"}</td>
      <td style="font-size:11px;color:var(--muted)">${mainSec}<br><span style="font-size:10px;color:#94a3b8">${(r.conceptTags||[]).slice(0,2).join("·")||""}</span></td>
    </tr>
    <tr class="detail-row" id="detail-${r.code}">
      <td colspan="${colSpan}">
        <div class="detail-top">
          <div id="chart-${r.code}" class="kline-chart">
            <div class="loading">加载K线数据...</div>
            <div class="chart-legend">
              <span class="cl-item"><span class="cl-dot" style="background:#dc2626"></span>K线</span>
              <span class="cl-item"><span class="cl-dot" style="background:#f59e0b"></span>MA5</span>
              <span class="cl-item"><span class="cl-dot" style="background:#3b82f6"></span>MA10</span>
            </div>
          </div>
          <div class="advice-panel">
            <div class="ap-section">
              <div class="ap-title" style="color:#dc2626">短线分析</div>
              ${adv.shortHtml}
            </div>
            <div class="ap-section">
              <div class="ap-title" style="color:#2563eb">长线分析</div>
              ${adv.longHtml}
            </div>
          </div>
        </div>
        <div class="detail-grid" style="margin-top:12px">
          ${(r.trend || r.ma5 || r.ma10) ? `
          <div class="sec">
            <h4>技术面</h4>
            <p>
              趋势: <b>${r.trend || '-'}</b><br>
              MA5:${r.ma5 || '-'} MA10:${r.ma10 || '-'}<br>
              量能: ${st ? (r.volTrend||'-') : (r.volShrink ? '缩量' : (r.volRatio ? '量比'+r.volRatio : '-'))}<br>
              5日涨: <span class="${(r.wChg||0)>=0?'bull':'bear'}">${r.wChg||'-'}%</span> 换手: ${st ? (r.turnover||'-') : (r.turn||'-')}%
            </p>
          </div>
          ` : ''}
          ${r.fundFlow ? `
          <div class="sec">
            <h4>资金面</h4>
            <p>
              主力今日: <span style="color:${(r.fundFlow.today?.mainNet||0)>=0?'#dc2626':'#16a34a'}">${(r.fundFlow.today?.mainNet||0)>=0?'流入':'流出'}${(Math.abs(r.fundFlow.today?.mainNet||0)/1e4).toFixed(1)}万</span><br>
              3日主力: ${(r.fundFlow.main3d/1e4).toFixed(1)}万<br>
              5日主力: ${(r.fundFlow.main5d/1e4).toFixed(1)}万<br>
              连续${r.fundFlow.consDays}日${r.fundFlow.consDir}
            </p>
          </div>
          ` : ''}
          <div class="sec">
            <h4>基本面</h4>
            <p>
              现价: ${r.price || '-'} | PE: ${r.pe > 0 ? r.pe.toFixed(1) : '亏损'} | PB: ${r.pb?.toFixed(2) || '-'}<br>
              市值: ${r.mcap || '-'}亿 | 换手: ${st ? (r.turnover || '-') : (r.turn || '-')}%
            </p>
          </div>
          ${(st ? r.industry : r.industries?.length) || r.conceptTags?.length ? `
          <div class="sec">
            <h4>板块/概念</h4>
            ${st && r.industry ? `<p>行业: ${r.industry}</p>` : r.industries?.length ? `<p>${r.industries.map(t => `<span class="tag">${t}</span>`).join(" ")}</p>` : ''}
            ${r.conceptTags?.length ? `<p style="margin-top:4px">${r.conceptTags.slice(0, 8).map(t => `<span class="tag">${t}</span>`).join(" ")}</p>` : ''}
          </div>
          ` : ''}
          ${r.signals ? `
          <div class="sec">
            <h4>策略信号</h4>
            <p>${Array.isArray(r.signals) ? r.signals.map(s => `<span class="tag">${s}</span>`).join(" ") : r.signals}</p>
            ${r.reason ? `<p style="margin-top:4px;font-size:12px;color:var(--muted)">${r.reason}</p>` : ''}
          </div>
          ` : r.reason ? `
          <div class="sec">
            <h4>选中原因</h4>
            <p style="font-size:14px;color:#0f172a;font-weight:500;margin-bottom:8px">${r.simpleReason || r.reason}</p>
            <details style="margin-top:4px"><summary style="font-size:11px;color:var(--muted);cursor:pointer">技术详情</summary><p style="font-size:12px;color:var(--muted);margin-top:4px">${r.reason}</p></details>
          </div>
          ` : ''}
          ${r.dragonTiger?.latest ? `
          <div class="sec">
            <h4>龙虎榜（近30天上榜${r.dragonTiger.count}次）</h4>
            <div class="dt-entry"><span style="color:var(--muted);font-size:11px">${r.dragonTiger.latest.date}</span> ${r.dragonTiger.latest.reason}<br>净买${r.dragonTiger.latest.netBuy} 换手${r.dragonTiger.latest.turnover}</div>
          </div>
          ` : r.dragonTiger?.recent?.length ? `
          <div class="sec">
            <h4>龙虎榜（近30天上榜${r.dragonTiger.totalRecords}次）</h4>
            ${r.dragonTiger.recent.map(dt => `<div class="dt-entry"><span style="color:var(--muted);font-size:11px">${dt.date}</span> ${dt.reason}<br>净买${dt.netBuy} 换手${dt.turnover}</div>`).join("")}
          </div>
          ` : ""}
        </div>
      </td>
    </tr>`;
  }

  const hotRows = hot.map(rowHTML).join("");
  const coldRows = cold.map(rowHTML).join("");
  const sectionRow = (label, count, cls) => `<tr class="section-divider"><td colspan="${headers.length}"><span class="${cls}">${label}</span> (${count}只)</td></tr>`;

  document.getElementById("signalTable").innerHTML =
    `<thead><tr>${thead}</tr></thead><tbody>
      ${hot.length ? sectionRow("热门赛道", hot.length, "hot-label") + hotRows : ""}
      ${cold.length ? sectionRow("其他板块", cold.length, "cold-label") + coldRows : ""}
      ${filtered.length === 0 ? `<tr><td colspan="${headers.length}" class="empty-state">无匹配结果</td></tr>` : ""}
    </tbody>`;
}

window.renderTable = renderTable;

window.sortBy = function (col) {
  if (sortCol === col) sortDir *= -1;
  else { sortCol = col; sortDir = -1; }
  renderTable();
};

window.toggleDetail = async function (code, row) {
  const dr = document.getElementById("detail-" + code);
  if (!dr) return;
  const open = dr.classList.contains("show");

  // Close all other details and destroy their charts
  document.querySelectorAll(".detail-row.show").forEach(r => {
    const otherCode = r.id.replace("detail-", "");
    if (otherCode !== code && klineCharts[otherCode]) {
      klineCharts[otherCode].remove();
      delete klineCharts[otherCode];
    }
    r.classList.remove("show");
  });
  document.querySelectorAll("tr.expanded").forEach(r => r.classList.remove("expanded"));

  if (!open) {
    dr.classList.add("show");
    row.classList.add("expanded");

    // Render K-line chart
    const container = document.getElementById("chart-" + code);
    if (container && !klineCharts[code]) {
      try {
        const r = await fetch(`/api/kline/${code}`);
        const j = await r.json();
        if (j.data && j.data.length > 0) {
          renderKLineChart(code, container, j.data);
        } else {
          container.innerHTML = '<div class="loading">暂无K线数据</div>';
        }
      } catch {
        container.innerHTML = '<div class="loading">K线数据加载失败</div>';
      }
    }
  } else {
    // Close: destroy chart
    if (klineCharts[code]) {
      klineCharts[code].remove();
      delete klineCharts[code];
    }
  }
};

function renderKLineChart(code, container, data) {
  const loadingEl = container.querySelector(".loading");
  if (loadingEl) loadingEl.remove();
  if (typeof LightweightCharts === "undefined") {
    container.innerHTML = '<div class="loading">图表库加载失败</div>';
    return;
  }

  const chart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: 320,
    layout: {
      background: { color: "#ffffff" },
      textColor: "#64748b",
    },
    grid: {
      vertLines: { color: "#f1f5f9" },
      horzLines: { color: "#f1f5f9" },
    },
    crosshair: { mode: 0 },
    rightPriceScale: {
      borderColor: "#e2e8f0",
      scaleMargins: { top: 0.1, bottom: 0.3 },
    },
    timeScale: {
      borderColor: "#e2e8f0",
      timeVisible: true,
      secondsVisible: false,
    },
  });

  // Candlestick (A-share colors: red up / green down)
  const candleSeries = chart.addCandlestickSeries({
    upColor: "#dc2626",
    downColor: "#16a34a",
    borderUpColor: "#dc2626",
    borderDownColor: "#16a34a",
    wickUpColor: "#dc2626",
    wickDownColor: "#16a34a",
  });
  candleSeries.setData(data.map(d => ({
    time: d.date,
    open: d.open,
    high: d.high,
    low: d.low,
    close: d.close,
  })));

  // MA5 / MA10 / MA20
  const maColors = { ma5: "#f59e0b", ma10: "#3b82f6", ma20: "#8b5cf6" };
  for (const [key, color] of Object.entries(maColors)) {
    const lineData = data.filter(d => d[key] != null).map(d => ({ time: d.date, value: d[key] }));
    if (lineData.length) {
      const series = chart.addLineSeries({
        color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      series.setData(lineData);
    }
  }

  // Volume
  const volSeries = chart.addHistogramSeries({
    priceScaleId: "volume",
    priceFormat: { type: "volume" },
  });
  chart.priceScale("volume").applyOptions({
    scaleMargins: { top: 0.85, bottom: 0 },
    visible: false,
  });
  volSeries.setData(data.map(d => ({
    time: d.date,
    value: d.volume,
    color: d.close >= d.open ? "rgba(220,38,38,0.3)" : "rgba(22,163,74,0.3)",
  })));

  chart.timeScale().fitContent();

  // Responsive resize
  const ro = new ResizeObserver(() => {
    chart.applyOptions({ width: container.clientWidth });
  });
  ro.observe(container);

  // Store chart instance + observer for cleanup
  klineCharts[code] = {
    remove() {
      ro.disconnect();
      chart.remove();
    },
  };
}

window.showConfirm = function (icon, msg) {
  return new Promise(resolve => {
    document.getElementById("confirmIcon").textContent = icon;
    document.getElementById("confirmMsg").innerHTML = msg;
    document.getElementById("confirmModal").classList.add("show");
    const ok = document.getElementById("confirmOk");
    const cancel = document.getElementById("confirmCancel");
    const cleanup = () => {
      document.getElementById("confirmModal").classList.remove("show");
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
  });
};

window.runReview = async function () {
  const ok = await window.showConfirm("⚙️", "确定要<strong>生成复盘分析</strong>？<br><span style='font-size:13px;color:var(--muted)'>大约需要20秒，分析你的持仓数据</span>");
  if (!ok) return;
  const btn = document.getElementById("btnReview");
  btn.disabled = true;
  btn.textContent = "生成中...";
  try {
    await fetch("/api/run-review");
    btn.textContent = "分析中(约20秒)...";
    setTimeout(() => {
      window.open("/review", "_blank");
      btn.disabled = false;
      btn.textContent = "生成复盘分析";
    }, 15000);
  } catch (e) {
    alert("请求失败: " + e.message);
    btn.disabled = false;
    btn.textContent = "生成复盘分析";
  }
};

window.runShortScan = async function () {
  const ok = await window.showConfirm("🔍", "确定要<strong>生成短线扫描信号</strong>？<br><span style='font-size:13px;color:var(--muted)'>大约需要60秒，全市场强势股扫描</span>");
  if (!ok) return;
  const btn = document.getElementById("btnShortScan");
  btn.disabled = true;
  btn.textContent = "扫描中...";
  try {
    await fetch("/api/run-short-scan");
    btn.textContent = "扫描中(约60秒)...";
    setTimeout(() => {
      location.reload();
      btn.disabled = false;
      btn.textContent = "生成短线信号";
    }, 60000);
  } catch (e) {
    alert("请求失败: " + e.message);
    btn.disabled = false;
    btn.textContent = "生成短线信号";
  }
};

// ── Portfolio CRUD ──────────────────────────────────────
let _pfResults = [];
let _pfIndex = -1;
let _pfTimer = 0;

window.openPortfolio = async function () {
  document.getElementById("portfolioModal").classList.add("show");
  document.getElementById("pfSearch").value = "";
  document.getElementById("pfDropdown").classList.remove("show");
  await window.loadPortfolio();
};

window.closePortfolio = function (e) {
  if (!e || e.target === document.getElementById("portfolioModal")) {
    document.getElementById("portfolioModal").classList.remove("show");
  }
};

window.searchStockDebounced = function () {
  clearTimeout(_pfTimer);
  _pfTimer = setTimeout(window.searchStock, 200);
};

window.searchStock = async function () {
  const q = document.getElementById("pfSearch").value.trim();
  const dd = document.getElementById("pfDropdown");
  if (!q || q.length < 1) {
    dd.classList.remove("show");
    _pfResults = [];
    _pfIndex = -1;
    return;
  }
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    _pfResults = await r.json();
    _pfIndex = -1;
    if (!_pfResults.length) {
      dd.innerHTML = '<div class="pf-dropdown-empty">无匹配结果</div>';
      dd.classList.add("show");
      return;
    }
    dd.innerHTML = _pfResults.map((s, i) => `
      <div class="pf-dropdown-item" data-i="${i}" onmousedown="event.preventDefault();window.selectStock(${i})">
        <span class="pfd-name">${s.name}</span>
        <span><span class="pfd-code">${s.code}</span><span class="pfd-market">${s.market}</span></span>
      </div>
    `).join("");
    dd.classList.add("show");
  } catch {
    dd.innerHTML = '<div class="pf-dropdown-empty">搜索失败</div>';
    dd.classList.add("show");
  }
};

window.pfSearchKeydown = function (e) {
  const dd = document.getElementById("pfDropdown");
  if (!dd.classList.contains("show")) { if (e.key === "ArrowDown") window.searchStock(); return; }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    _pfIndex = Math.min(_pfIndex + 1, _pfResults.length - 1);
    window._updatePfActive();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    _pfIndex = Math.max(_pfIndex - 1, 0);
    window._updatePfActive();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (_pfIndex >= 0) window.selectStock(_pfIndex);
  } else if (e.key === "Escape") {
    dd.classList.remove("show");
    _pfIndex = -1;
  }
};

window._updatePfActive = function () {
  document.querySelectorAll(".pf-dropdown-item").forEach((el, i) => {
    el.classList.toggle("active", i === _pfIndex);
    if (i === _pfIndex) el.scrollIntoView({ block: "nearest" });
  });
};

window.selectStock = async function (i) {
  const s = _pfResults[i];
  if (!s) return;
  const r = await fetch("/api/portfolio", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "add", code: s.code, name: s.name }),
  });
  if (r.ok) {
    document.getElementById("pfSearch").value = "";
    document.getElementById("pfDropdown").classList.remove("show");
    _pfResults = [];
    _pfIndex = -1;
    await window.loadPortfolio();
  }
};

window.loadPortfolio = async function () {
  const list = document.getElementById("pfList");
  try {
    const r = await fetch("/api/portfolio");
    const data = await r.json();
    if (!data.length) {
      list.innerHTML = '<div class="pf-empty">暂无持仓，请搜索添加股票</div>';
      return;
    }
    list.innerHTML = data.map(h => `
      <div class="pf-list-item">
        <div class="pf-info">
          <span class="pf-code">${h.code}</span>
          <span class="pf-name" id="pfName-${h.code}">${h.name || h.code}</span>
        </div>
        <div class="pf-actions">
          <button class="pf-edit" onclick="window.editHolding('${h.code}')">编辑</button>
          <button class="pf-del" onclick="window.removeHolding('${h.code}')">删除</button>
        </div>
      </div>
    `).join("");
  } catch {
    list.innerHTML = '<div class="pf-empty">加载失败</div>';
  }
};

window.removeHolding = async function (code) {
  if (!confirm(`确定删除 ${code}？`)) return;
  const r = await fetch("/api/portfolio", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "remove", code }),
  });
  if (r.ok) await window.loadPortfolio();
};

window.editHolding = async function (code) {
  const span = document.getElementById("pfName-" + code);
  const oldName = span.textContent;
  const newName = prompt("修改名称：", oldName);
  if (!newName || newName === oldName) return;
  const r = await fetch("/api/portfolio", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "update", code, name: newName }),
  });
  if (r.ok) await window.loadPortfolio();
};

// ── Start ──────────────────────────────────────────────
init();
