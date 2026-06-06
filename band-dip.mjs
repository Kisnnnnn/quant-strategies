/**
 * 策略一：波段回调选股
 *
 * 逻辑：趋势偏多的个股缩量回踩20日均线附近，等待企稳信号买入
 * 用法: node band-dip.mjs
 */

import("../chaogu/stock-data.mjs").then(async (m) => {

  // ═══════════ CONFIG ═══════════
  const CFG = {
    minTurnover: 1.5,
    maxDistMA20: 5,
    maxPE: 100,
    minMcap: 20,
    minPrice: 4,
    requireVolShrink: false,
    maxResults: 20,
  };

  // ═══════════ 工具 ═══════════
  const fmt = (n, d = 2) => (typeof n === "number" ? n.toFixed(d) : n);
  const now = () => new Date().toLocaleString("zh-CN", { hour12: false });

  function trendLabel(c, m5, m10, m20) {
    if (c > m5 && m5 > m10 && m10 > m20) return "大多头";
    if (c > m5 && c > m10 && c > m20 && m5 > m10) return "多头排列";
    if (c > m10 && c > m20) return "多头";
    if (c > m20) return "震荡偏多";
    return "弱势";
  }

  // ═══════════ 代码池 ═══════════
  console.log(`\n${"=".repeat(55)}`);
  console.log(`  波段回调策略 — ${now()}`);
  console.log(`${"=".repeat(55)}\n`);

  const codes = [];
  for (let i = 600000; i <= 605999; i++) codes.push(i.toString());
  for (let i = 1; i <= 3999; i++) codes.push(i.toString().padStart(6, "0"));
  for (let i = 300001; i <= 301999; i++) codes.push(i.toString());
  for (let i = 688001; i <= 689999; i++) codes.push(i.toString());

  // 批量行情
  console.log(">>> 批量行情...");
  const active = [];
  const QB = 60;
  for (let i = 0; i < codes.length; i += QB) {
    try {
      const q = await m.tencentQuote(codes.slice(i, i + QB));
      if (q) {
        Object.entries(q).forEach(([code, d]) => {
          if (d && d.name && !d.name.includes("ST") && !d.name.includes("*ST") &&
              d.turnoverPct >= CFG.minTurnover) {
            active.push({
              code, name: d.name,
              price: d.price, chg: d.changePct,
              turn: d.turnoverPct, vr: d.volRatio,
              pe: d.peTtm, pb: d.pb,
              mcap: d.mcapYi, amp: d.amplitudePct,
            });
          }
        });
      }
    } catch (e) { /* skip */ }
    if (i % 2400 === 0) process.stderr.write(".");
  }
  console.log(`\n活跃股: ${active.length} 只\n`);

  // ═══════════ K线扫描 ═══════════
  console.log(">>> K线分析...");
  const results = [];
  const KB = 6;
  let n = 0;
  for (let i = 0; i < active.length; i += KB) {
    const batch = active.slice(i, i + KB);
    const ps = batch.map(async (s) => {
      try {
        const d = await m.baiduKLine(s.code);
        if (!d?.rows || d.rows.length < 40) return;
        const rows = d.rows;
        const len = rows.length;
        const last = rows[len - 1];
        const curr = +last.close;
        const prev = +rows[len - 2].close;

        const ma5 = +last.ma5avgprice;
        const ma10 = +last.ma10avgprice;
        const ma20 = +last.ma20avgprice;
        if (!ma5 || !ma10 || !ma20) return;

        const closes = rows.map(r => +r.close);
        const vols = rows.map(r => +r.volume);
        const curVol = vols[len - 1];
        const avg5Vol = vols.slice(-6, -1).reduce((a, b) => a + b, 0) / 5;

        const distMA20 = ((curr - ma20) / ma20) * 100;
        const distMA5 = ((curr - ma5) / ma5) * 100;
        const trend = trendLabel(curr, ma5, ma10, ma20);
        const volRatioToAvg = avg5Vol > 0 ? curVol / avg5Vol : 1;
        const volShrinking = volRatioToAvg < 0.8;
        const m20Rising = ma20 > (+rows[len - 5]?.ma20avgprice || ma20);

        const nearMA20 = Math.abs(distMA20) <= CFG.maxDistMA20;
        const trendOK = (curr > ma20 || (curr > ma10 && m20Rising));

        if (!trendOK || !nearMA20 || !(s.pe > 0 && s.pe < CFG.maxPE) ||
            s.mcap < CFG.minMcap || s.price < CFG.minPrice) return;
        if (CFG.requireVolShrink && !volShrinking) return;

        // 打分
        let quality = "B";
        if (curr > ma5 && ma5 > ma10 && ma10 > ma20) quality = "S";
        else if (curr > ma10 && curr > ma20 && curr > ma5) quality = "A";

        const signals = [];
        if (volShrinking) signals.push("缩量");
        if (curr > prev) signals.push("收阳");
        if (distMA20 > -2 && distMA20 < 3) signals.push("贴20线");
        if (volRatioToAvg > 1.2) signals.push("放量");
        if (ma5 > ma10 && ma10 > ma20) signals.push("多排");

        const score = (quality === "S" ? 4 : quality === "A" ? 3 : 1) +
          (volShrinking ? 2 : 0) + (Math.abs(distMA20) < 3 ? 2 : 0) +
          (curr > prev ? 1 : 0) + (trend.includes("多头") ? 2 : 0);

        results.push({ code: s.code, name: s.name, price: s.price, quality, score, trend,
          ma5: fmt(ma5), ma10: fmt(ma10), ma20: fmt(ma20),
          distMA20: distMA20.toFixed(1) + "%", distMA5: distMA5.toFixed(1) + "%",
          volShrink: volShrinking ? "是" : "否", volRatio: volRatioToAvg.toFixed(1) + "x",
          signals: signals.join("·"), turn: s.turn, pe: s.pe, mcap: s.mcap,
          wChg: (len >= 6 ? ((curr - closes[len - 6]) / closes[len - 6]) * 100 : 0).toFixed(1) + "%",
          mChg: (len >= 21 ? ((curr - closes[len - 21]) / closes[len - 21]) * 100 : 0).toFixed(1) + "%",
        });
      } catch (e) { /* skip */ }
    });
    await Promise.all(ps);
    n += batch.length;
    if (n % 300 === 0) process.stderr.write(`.${n}`);
  }

  // 去重排序
  const seen = new Set();
  const final = results.filter(r => { if (seen.has(r.code)) return false; seen.add(r.code); return true; })
    .sort((a, b) => b.score - a.score);

  console.log(`\n\n${"=".repeat(55)}`);
  console.log(`  波段回调 — ${final.length} 只`);
  console.log(`${"=".repeat(55)}\n`);

  if (final.length === 0) {
    console.log("  无符合条件标的，弱势市场下正常。\n");
  } else {
    final.slice(0, CFG.maxResults).forEach((r, i) => {
      const icon = r.quality === "S" ? "⭐" : r.quality === "A" ? "★" : "  ";
      console.log(`${String(i + 1).padStart(2)}. ${icon} ${r.code} ${r.name.padEnd(8)} ${r.score}分 ${r.trend}`);
      console.log(`    现价${r.price} | MA5:${r.ma5} MA10:${r.ma10} MA20:${r.ma20}`);
      console.log(`    离20线:${r.distMA20} | 离MA5:${r.distMA5} | 缩量:${r.volShrink} | 量比:${r.volRatio}`);
      console.log(`    信号: ${r.signals} | 5d:${r.wChg} 20d:${r.mChg} | 换手${r.turn}% PE${r.pe} 市值${r.mcap}亿`);
      console.log();
    });
  }
  console.log(`扫描完成 — ${now()}\n`);
  process.exit(0);
});
