#!/usr/bin/env node
/**
 * 生成可视化报告 — 读取 outputs/ 下最新JSON，产出独立HTML
 * 用法: node scripts/generate-viz.mjs
 */
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, "..");
const OUT = join(PROJECT, "outputs");

const files = readdirSync(OUT).filter(f => f.endsWith(".json"));
const latest = {};
for (const f of files) {
  const name = f.replace(/-\d{4}-\d{2}-\d{2}\.json$/, "");
  if (!latest[name] || f > latest[name].file) {
    latest[name] = { file: f, path: join(OUT, f) };
  }
}

const data = {};
for (const [name, { path }] of Object.entries(latest)) {
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  data[name] = raw;
}

// Build sector map for all strategies
function sectorStats(results) {
  const map = new Map();
  for (const r of results) {
    const sector = r.industries?.[0]?.replace(/\([^)]*\)/g, "") || "其他";
    map.set(sector, (map.get(sector) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
}

function scoreDist(results) {
  const bins = { "90-100": 0, "80-89": 0, "70-79": 0, "60-69": 0, "50-59": 0, "<50": 0 };
  for (const r of results) {
    const s = r.score;
    if (s >= 90) bins["90-100"]++;
    else if (s >= 80) bins["80-89"]++;
    else if (s >= 70) bins["70-79"]++;
    else if (s >= 60) bins["60-69"]++;
    else if (s >= 50) bins["50-59"]++;
    else bins["<50"]++;
  }
  return bins;
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>A股短线策略扫描报告</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background:#0f172a; color:#e2e8f0; min-height:100vh; }
.header { background:linear-gradient(135deg,#1e293b,#0f172a); border-bottom:1px solid #334155; padding:24px 32px; }
.header h1 { font-size:24px; font-weight:700; }
.header .meta { color:#94a3b8; margin-top:4px; font-size:14px; }
.cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:16px; padding:24px 32px; }
.card { background:#1e293b; border-radius:12px; padding:20px; border:1px solid #334155; }
.card .label { color:#94a3b8; font-size:12px; text-transform:uppercase; letter-spacing:0.5px; }
.card .value { font-size:28px; font-weight:700; margin-top:4px; }
.card .sub { color:#94a3b8; font-size:12px; margin-top:2px; }
.charts { display:grid; grid-template-columns:1fr 1fr; gap:16px; padding:0 32px 24px; }
.chart-box { background:#1e293b; border-radius:12px; padding:20px; border:1px solid #334155; }
.chart-box h3 { font-size:14px; color:#94a3b8; margin-bottom:16px; text-transform:uppercase; letter-spacing:0.5px; }
.chart-box canvas { max-height:350px; }
.tabs { display:flex; gap:4px; padding:0 32px; margin-bottom:16px; }
.tab { padding:8px 20px; border-radius:8px 8px 0 0; cursor:pointer; background:#1e293b; color:#94a3b8; border:1px solid #334155; border-bottom:none; font-size:14px; transition:all .2s; }
.tab.active { background:#334155; color:#e2e8f0; }
.table-wrap { padding:0 32px 32px; }
table { width:100%; border-collapse:collapse; font-size:13px; }
th { text-align:left; padding:10px 12px; background:#1e293b; color:#94a3b8; font-weight:600; border-bottom:2px solid #334155; cursor:pointer; white-space:nowrap; user-select:none; position:sticky; top:0; z-index:1; }
th:hover { color:#e2e8f0; }
th .sort-icon { margin-left:4px; font-size:10px; }
td { padding:10px 12px; border-bottom:1px solid #1e293b; }
tr:hover td { background:#1e293b; }
tr.expanded td { background:#0f2942; }
.detail-row { display:none; }
.detail-row.show { display:table-row; }
.detail-row td { padding:20px 24px; background:#0a1929; border-bottom:2px solid #2563eb; }
.detail-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:16px; font-size:13px; }
.detail-grid .sec { }
.detail-grid .sec h4 { color:#60a5fa; font-size:13px; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px; }
.detail-grid .sec p { color:#cbd5e1; line-height:1.8; }
.detail-grid .sec .tag { display:inline-block; background:#1e3a5f; color:#93c5fd; padding:2px 8px; border-radius:4px; margin:2px 3px 2px 0; font-size:11px; }
.detail-grid .dt-entry { margin-bottom:8px; padding-bottom:8px; border-bottom:1px solid #1e293b; }
.detail-grid .dt-entry:last-child { border-bottom:none; }
.score-high { color:#f59e0b; font-weight:700; }
.score-mid { color:#e2e8f0; }
.score-low { color:#94a3b8; }
.quality-S, .level-S { background:#f59e0b; color:#000; padding:1px 6px; border-radius:4px; font-weight:700; font-size:11px; }
.quality-A, .level-A { background:#3b82f6; color:#fff; padding:1px 6px; border-radius:4px; font-weight:700; font-size:11px; }
.sector-bar { display:inline-block; height:6px; background:#2563eb; border-radius:3px; vertical-align:middle; margin-right:6px; }
.filter-row { padding:0 32px 16px; display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
.filter-row input { background:#1e293b; border:1px solid #334155; border-radius:6px; padding:6px 12px; color:#e2e8f0; font-size:13px; width:200px; }
.filter-row select { background:#1e293b; border:1px solid #334155; border-radius:6px; padding:6px 12px; color:#e2e8f0; font-size:13px; }
.breadth-bar { display:flex; height:8px; border-radius:4px; overflow:hidden; margin-top:6px; }
.breadth-bar .up { background:#22c55e; }
.breadth-bar .down { background:#ef4444; }
.breadth-bar .flat { background:#64748b; }
.empty-state { text-align:center; padding:60px; color:#64748b; }
@media (max-width:768px) { .charts { grid-template-columns:1fr; } .cards { grid-template-columns:repeat(2,1fr); } }
</style>
</head>
<body>

<div class="header">
  <h1>A股短线策略扫描报告</h1>
  <div class="meta">${Object.entries(data).map(([n,d]) => `${n}: ${d.total}条信号`).join(" · ")} · 生成时间: ${Object.values(data)[0]?.generatedAt || "-"}</div>
</div>

<div class="cards" id="cards"></div>

<div class="charts" id="charts"></div>

<div class="tabs" id="tabs"></div>
<div class="filter-row">
  <input type="text" id="search" placeholder="搜索代码/名称..." oninput="renderTable()">
  <select id="sectorFilter" onchange="renderTable()"><option value="">全部板块</option></select>
  <select id="qualityFilter" onchange="renderTable()"><option value="">全部等级</option><option value="S">S级</option><option value="A">A级</option><option value="B">B级</option></select>
  <span style="color:#94a3b8;font-size:12px;" id="filterCount"></span>
</div>
<div class="table-wrap"><table id="signalTable"></table></div>

<script>
const DATA = ${JSON.stringify(data)};
const STRATEGIES = Object.keys(DATA);
let activeStrategy = STRATEGIES[0];
let sortCol = "score", sortDir = -1;
let expandedRow = null;

function init() {
  renderTabs();
  renderCards();
  renderCharts();
  renderSectorFilter();
  renderTable();
}

function renderTabs() {
  document.getElementById("tabs").innerHTML = STRATEGIES.map((s, i) =>
    \`<div class="tab \${i===0?'active':''}" onclick="switchTab('\${s}')">\${s}</div>\`
  ).join("");
}

function switchTab(s) {
  activeStrategy = s;
  document.querySelectorAll(".tab").forEach((t, i) => t.classList.toggle("active", STRATEGIES[i]===s));
  renderCards();
  renderCharts();
  renderSectorFilter();
  renderTable();
}

function getData() { return DATA[activeStrategy] || { total:0, results:[] }; }

function renderCards() {
  const d = getData();
  const results = d.results;
  const avgScore = results.length ? (results.reduce((s,r)=>s+r.score,0)/results.length).toFixed(1) : 0;
  const sCount = results.filter(r => (r.quality||r.level)==="S").length;
  const aCount = results.filter(r => (r.quality||r.level)==="A").length;
  const sectors = new Set(results.map(r => r.industries?.[0]?.replace(/\\([^)]*\\)/g,"")).filter(Boolean));
  const dragonCount = results.filter(r => r.dragonTiger?.recent?.length).length;

  document.getElementById("cards").innerHTML = [
    { label:"信号总数", value:d.total, sub:\`显示前\${results.length}只\` },
    { label:"平均评分", value:avgScore, sub:"满分100" },
    { label:"S/A级", value:\`\${sCount}/\${aCount}\`, sub:"高质量信号" },
    { label:"涉及板块", value:sectors.size, sub:"行业板块数" },
    { label:"有龙虎榜", value:\`\${dragonCount}只\`, sub:"近30天上榜" },
  ].map(c => \`<div class="card"><div class="label">\${c.label}</div><div class="value">\${c.value}</div><div class="sub">\${c.sub}</div></div>\`).join("");
}

let charts = {};
function renderCharts() {
  const d = getData();
  const results = d.results;
  const sectorData = sectorStats(results);
  const scoreData = scoreDist(results);

  // Destroy old charts
  Object.values(charts).forEach(c => c.destroy());
  charts = {};

  // Sector chart
  const sCtx = document.getElementById("sectorChart")?.getContext("2d");
  if (sCtx) {
    charts.sector = new Chart(sCtx, {
      type:"bar",
      data:{
        labels:sectorData.map(e=>e[0]),
        datasets:[{
          label:"信号数", data:sectorData.map(e=>e[1]),
          backgroundColor:"#2563eb", borderRadius:4,
        }]
      },
      options:{
        indexAxis:"y", responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ display:false } },
        scales:{ x:{ grid:{ color:"#334155" }, ticks:{ color:"#94a3b8" } }, y:{ ticks:{ color:"#94a3b8", font:{ size:11 } } } }
      }
    });
  }

  // Score dist chart
  const bCtx = document.getElementById("scoreChart")?.getContext("2d");
  if (bCtx) {
    const bins = Object.entries(scoreData);
    charts.score = new Chart(bCtx, {
      type:"bar",
      data:{
        labels:bins.map(e=>e[0]),
        datasets:[{
          label:"数量", data:bins.map(e=>e[1]),
          backgroundColor:["#f59e0b","#3b82f6","#22c55e","#64748b","#475569","#1e293b"],
          borderRadius:4,
        }]
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ display:false } },
        scales:{ x:{ grid:{ color:"#334155" }, ticks:{ color:"#94a3b8" } }, y:{ ticks:{ color:"#94a3b8" } } }
      }
    });
  }

  document.getElementById("charts").innerHTML = \`
    <div class="chart-box"><h3>板块分布</h3><div style="height:350px"><canvas id="sectorChart"></canvas></div></div>
    <div class="chart-box"><h3>评分分布</h3><div style="height:350px"><canvas id="scoreChart"></canvas></div></div>
  \`;
  // Re-render charts after DOM update
  setTimeout(() => renderCharts(), 50);
}

function sectorStats(results) {
  const map = new Map();
  for (const r of results) {
    const sector = r.industries?.[0]?.replace(/\\([^)]*\\)/g, "") || "其他";
    map.set(sector, (map.get(sector) || 0) + 1);
  }
  return [...map.entries()].sort((a,b) => b[1]-a[1]).slice(0,15);
}

function scoreDist(results) {
  const bins = {"90-100":0,"80-89":0,"70-79":0,"60-69":0,"50-59":0,"<50":0};
  for (const r of results) {
    const s = r.score;
    if(s>=90)bins["90-100"]++; else if(s>=80)bins["80-89"]++; else if(s>=70)bins["70-79"]++; else if(s>=60)bins["60-69"]++; else if(s>=50)bins["50-59"]++; else bins["<50"]++;
  }
  return bins;
}

function renderSectorFilter() {
  const d = getData();
  const sectors = [...new Set(d.results.map(r => r.industries?.[0]?.replace(/\\([^)]*\\)/g,"")).filter(Boolean))].sort();
  document.getElementById("sectorFilter").innerHTML = '<option value="">全部板块</option>' + sectors.map(s => \`<option value="\${s}">\${s}</option>\`).join("");
}

function renderTable() {
  const d = getData();
  const search = document.getElementById("search").value.toLowerCase();
  const sectorF = document.getElementById("sectorFilter").value;
  const qualityF = document.getElementById("qualityFilter").value;

  let filtered = d.results;
  if (search) filtered = filtered.filter(r => r.code.includes(search) || (r.name||"").includes(search));
  if (sectorF) filtered = filtered.filter(r => (r.industries||[]).some(i => i.replace(/\\([^)]*\\)/g,"") === sectorF));
  if (qualityF) filtered = filtered.filter(r => (r.quality||r.level) === qualityF);

  // Sort
  filtered.sort((a,b) => {
    let va, vb;
    if (sortCol === "score") { va = a.score; vb = b.score; }
    else if (sortCol === "code") { va = a.code; vb = b.code; }
    else if (sortCol === "trend") { va = a.trend||""; vb = b.trend||""; }
    else if (sortCol === "turn") { va = a.turn||0; vb = b.turn||0; }
    else if (sortCol === "mcap") { va = a.mcap||0; vb = b.mcap||0; }
    return (va>vb?1:va<vb?-1:0) * sortDir;
  });

  document.getElementById("filterCount").textContent = \`显示 \${filtered.length}/\${d.results.length} 条\`;

  const isBand = activeStrategy === "band-dip";
  const headers = [
    { key:"score", label:isBand?"评分":"龙性" },
    { key:"code", label:"代码" },
    { key:"", label:"名称" },
    { key:"trend", label:"趋势" },
    ...(isBand ? [
      { key:"", label:"均线信号" },
      { key:"", label:"离20线" },
    ] : [
      { key:"", label:"首波/回调" },
      { key:"", label:"回调天数" },
    ]),
    { key:"turn", label:"换手%" },
    { key:"mcap", label:"市值(亿)" },
    { key:"", label:"板块" },
  ];

  const thHtml = headers.map(h => {
    const arrow = h.key === sortCol ? (sortDir===1?'▲':'▼') : '';
    const clickable = h.key ? 'cursor:pointer' : '';
    return \`<th style="\${clickable}" onclick="\${h.key?\`sortBy('\${h.key}')\`:''}">\${h.label}\${arrow?'<span class=sort-icon>'+arrow+'</span>':''}</th>\`;
  }).join("");

  const rows = filtered.map((r,i) => {
    const lvl = r.quality || r.level || "";
    const lvlClass = "quality-" + lvl + (lvl==="S"?" level-S":" level-A":"");
    const mainSector = r.industries?.[0]?.replace(/\\([^)]*\\)/g,"") || "-";
    const scoreClass = r.score >= 80 ? "score-high" : r.score >= 60 ? "score-mid" : "score-low";

    return \`
    <tr onclick="toggleDetail('\${r.code}', this)" style="cursor:pointer">
      <td><span class="\${scoreClass}">\${r.score}</span> \${lvl?\`<span class="\${lvlClass}">\${lvl}</span>\`:''}</td>
      <td style="font-family:monospace">\${r.code}</td>
      <td>\${r.name||""}</td>
      <td>\${r.trend||"-"}</td>
      \${isBand ? \`
        <td style="font-size:11px;color:#94a3b8">\${r.signals||"-"}</td>
        <td>\${r.distMA20||"-"}</td>
      \` : \`
        <td style="font-size:11px">首波\${r.firstWave||"-"} 回调\${r.retrace||"-"}</td>
        <td>\${r.retraceDays||"-"}天</td>
      \`}
      <td>\${r.turn||"-"}</td>
      <td>\${r.mcap||"-"}</td>
      <td style="font-size:11px;color:#94a3b8">\${mainSector}</td>
    </tr>
    <tr class="detail-row" id="detail-\${r.code}">
      <td colspan="\${headers.length}">
        <div class="detail-grid">
          <div class="sec">
            <h4>选中原因</h4>
            <p>\${r.reason||"-"}</p>
          </div>
          <div class="sec">
            <h4>技术面</h4>
            <p>
              \${isBand ? \`
                MA5:\${r.ma5} MA10:\${r.ma10} MA20:\${r.ma20}<br>
                离20线:\${r.distMA20} 量比:\${r.volRatio} 缩量:\${r.volShrink||"-"}
              \` : \`
                首波:\${r.firstWave} 高点:\${r.waveHigh||"-"}<br>
                回调:\${r.retrace} \${r.retraceDays}天 量比:\${r.volRatio}<br>
                强势日:\${r.strongDays}天 \${r.stabilizing||""}
              \`}
            </p>
          </div>
          <div class="sec">
            <h4>基本面</h4>
            <p>换手\${r.turn}% PE\${r.pe} 市值\${r.mcap}亿<br>5日:\${r.wChg} 20日:\${r.mChg}</p>
          </div>
          <div class="sec">
            <h4>所属板块</h4>
            <p>\${(r.industries||[]).map(t => \`<span class="tag">\${t}</span>\`).join(" ")||"-"}</p>
          </div>
          <div class="sec">
            <h4>概念板块</h4>
            <p>\${(r.conceptTags||[]).slice(0,10).map(t => \`<span class="tag">\${t}</span>\`).join(" ")||"-"}</p>
          </div>
          \${r.recentNews?.length ? \`
          <div class="sec">
            <h4>近期异动</h4>
            \${r.recentNews.map(n => \`<div class="dt-entry"><span style="color:#94a3b8;font-size:11px">\${(n.date||"").slice(0,10)}</span> \${n.title} \${n.source?\`<span style="color:#64748b">(\${n.source})</span>\`:''}</div>\`).join("")}
          </div>
          \` : ''}
          \${r.dragonTiger?.recent?.length ? \`
          <div class="sec">
            <h4>龙虎榜（近30天上榜\${r.dragonTiger.totalRecords}次）</h4>
            \${r.dragonTiger.recent.map(dt => \`<div class="dt-entry"><span style="color:#94a3b8;font-size:11px">\${dt.date}</span> \${dt.reason}<br>净买\${dt.netBuy} 换手\${dt.turnover}</div>\`).join("")}
            \${r.dragonTiger.seats ? \`
              <p style="margin-top:6px;font-size:11px;color:#94a3b8">席位TOP:</p>
              \${[...(r.dragonTiger.seats.buy||[]).slice(0,3).map(s=>({...s,side:"买"})), ...(r.dragonTiger.seats.sell||[]).slice(0,3).map(s=>({...s,side:"卖"}))]
                .map(s => \`<div style="font-size:11px;margin:2px 0"><span style="color:\${s.side==='买'?'#ef4444':'#22c55e'}">\${s.side}</span> \${(s.name||"").slice(0,20)} 额\${s.buyAmt||0}万</div>\`).join("")}
            \` : ''}
            \${r.dragonTiger.institution?.buyAmt!=null ? \`<p style="margin-top:4px;font-size:11px">机构动向: 买\${r.dragonTiger.institution.buyAmt||0}万 卖\${r.dragonTiger.institution.sellAmt||0}万 净\${r.dragonTiger.institution.netAmt||0}万</p>\` : ''}
          </div>
          \` : ''}
        </div>
      </td>
    </tr>\`;
  }).join("");

  document.getElementById("signalTable").innerHTML = \`
    <thead><tr>\${thHtml}</tr></thead>
    <tbody>\${rows || '<tr><td colspan="\${headers.length}" class="empty-state">无匹配结果</td></tr>'}</tbody>
  \`;
}

function sortBy(col) {
  if (sortCol === col) sortDir *= -1;
  else { sortCol = col; sortDir = -1; }
  renderTable();
}

function toggleDetail(code, row) {
  const detailRow = document.getElementById("detail-" + code);
  if (!detailRow) return;
  const isOpen = detailRow.classList.contains("show");
  // Close all
  document.querySelectorAll(".detail-row.show").forEach(r => r.classList.remove("show"));
  if (!isOpen) detailRow.classList.add("show");
}

// Init
document.getElementById("charts").innerHTML = \`
  <div class="chart-box"><h3>板块分布</h3><div style="height:350px"><canvas id="sectorChart"></canvas></div></div>
  <div class="chart-box"><h3>评分分布</h3><div style="height:350px"><canvas id="scoreChart"></canvas></div></div>
\`;
init();
</script>
</body>
</html>`;

const outFile = join(OUT, "report.html");
writeFileSync(outFile, html, "utf-8");
console.log(`可视化报告已生成: ${outFile}`);
