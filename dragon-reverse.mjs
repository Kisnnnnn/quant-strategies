/**
 * 策略二：龙回头（二次启动）选股
 *
 * 逻辑：龙头股首波大涨后缩量回调企稳，等待第二波启动信号
 * 用法: node dragon-reverse.mjs
 */

import("../chaogu/stock-data.mjs").then(async (m) => {

  // ═══════════ CONFIG ═══════════
  const CFG = {
    minFirstWave: 25,
    minRetrace: 8,
    maxRetrace: 35,
    maxRetraceDays: 15,
    maxVolRatio: 0.6,
    minMcap: 30,
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
  console.log(`  龙回头策略 — ${now()}`);
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
              d.turnoverPct >= 1) {
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
  console.log(`\n备选池: ${active.length} 只\n`);

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
        if (!d?.rows || d.rows.length < 60) return;
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
        const highs = rows.map(r => +r.high);
        const vols = rows.map(r => +r.volume);
        const curVol = vols[len - 1];
        const max60d = Math.max(...highs.slice(-61, -1));

        // 找最优波段
        let best = { peak: 0, start: -1, peakIdx: -1, waveHigh: 0 };
        for (let j = len - 15; j < len; j++) {
          for (let k = j - 15; k < j - 5; k++) {
            if (k < 0) continue;
            const waveChg = ((closes[j] - closes[k]) / closes[k]) * 100;
            const waveHigh = Math.max(...highs.slice(k, j + 1));
            const retrace = ((waveHigh - curr) / waveHigh) * 100;
            if (waveChg >= CFG.minFirstWave &&
                retrace >= CFG.minRetrace &&
                retrace <= CFG.maxRetrace &&
                waveHigh >= max60d * 0.85) {
              if (waveChg > best.peak) {
                best = { peak: waveChg, start: k, peakIdx: j, waveHigh };
              }
            }
          }
        }

        if (best.peak < CFG.minFirstWave || best.peakIdx <= 0) return;

        const retracePct = ((best.waveHigh - curr) / best.waveHigh) * 100;
        const retraceDays = len - 1 - best.peakIdx;
        const peakVol = Math.max(...vols.slice(best.start, best.peakIdx + 1));
        const volRatio = peakVol > 0 ? curVol / peakVol : 1;

        if (retracePct < CFG.minRetrace || retracePct > CFG.maxRetrace ||
            retraceDays < 2 || retraceDays > CFG.maxRetraceDays ||
            volRatio >= CFG.maxVolRatio || s.pe <= 0 || s.mcap < CFG.minMcap) return;

        // 龙性打分
        const dailyChgs = rows.slice(best.start, best.peakIdx + 1)
          .map(r => ((+r.close - +r.open) / +r.open) * 100);
        const strongDays = dailyChgs.filter(c => c > 5).length;
        const stabilizing = curr > prev || Math.abs((curr - prev) / prev) < 0.02;

        let score = 0;
        if (best.peak > 40) score += 3;
        else if (best.peak > 30) score += 2;
        else score += 1;
        if (strongDays >= 3) score += 3;
        else if (strongDays >= 2) score += 2;
        else score += 1;
        if (volRatio < 0.35) score += 3;
        else if (volRatio < 0.5) score += 2;
        else score += 1;
        if (retraceDays >= 3 && retraceDays <= 10) score += 2;
        if (retracePct >= 15 && retracePct <= 28) score += 2;
        if (stabilizing && curr > ma20) score += 2;
        if (curr > ma10) score += 1;

        const level = score >= 14 ? "S" : score >= 10 ? "A" : "B";

        results.push({
          code: s.code, name: s.name, price: s.price,
          score, level,
          firstWave: best.peak.toFixed(1) + "%",
          retrace: retracePct.toFixed(1) + "%",
          retraceDays, waveHigh: best.waveHigh.toFixed(2),
          volRatio: (volRatio * 100).toFixed(0) + "%",
          strongDays,
          trend: trendLabel(curr, ma5, ma10, ma20),
          ma5: fmt(ma5), ma10: fmt(ma10), ma20: fmt(ma20),
          stabilizing: stabilizing ? "企稳中" : "待确认",
          wChg: (len >= 6 ? ((curr - closes[len - 6]) / closes[len - 6]) * 100 : 0).toFixed(1) + "%",
          mChg: (len >= 21 ? ((curr - closes[len - 21]) / closes[len - 21]) * 100 : 0).toFixed(1) + "%",
          turn: s.turn, pe: s.pe, mcap: s.mcap,
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
  console.log(`  龙回头 — ${final.length} 只`);
  console.log(`  ⚠️ 量化时代此策略胜率下降，仅供观察验证`);
  console.log(`${"=".repeat(55)}\n`);

  if (final.length === 0) {
    console.log("  无符合条件标的，当前可能无主线龙头或龙头已A杀。\n");
  } else {
    final.slice(0, CFG.maxResults).forEach((r, i) => {
      const icon = r.level === "S" ? "🔥" : r.level === "A" ? "★" : "  ";
      console.log(`${String(i + 1).padStart(2)}. ${icon} ${r.code} ${r.name.padEnd(8)} 龙性${r.score}分 ${r.trend}`);
      console.log(`    现价${r.price} | 首波:${r.firstWave} | 回调:${r.retrace} | ${r.retraceDays}天 | 量${r.volRatio}`);
      console.log(`    强势日:${r.strongDays}天 | 高点:${r.waveHigh} | ${r.stabilizing}`);
      console.log(`    MA5:${r.ma5} MA10:${r.ma10} MA20:${r.ma20}`);
      console.log(`    5d:${r.wChg} 20d:${r.mChg} | PE${r.pe} | 市值${r.mcap}亿`);
      console.log();
    });
  }
  console.log(`扫描完成 — ${now()}\n`);
  process.exit(0);
});
