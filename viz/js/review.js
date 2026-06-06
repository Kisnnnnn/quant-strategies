/**
 * 持仓复盘分析 — 渲染逻辑
 */

// 席位分类
function classifySeat(name) {
  if (!name) return { type: "other", label: "其他", color: "#94a3b8" };
  if (name.includes("深股通") || name.includes("沪股通")) return { type: "north", label: "北向资金", color: "#2563eb" };
  if (name.includes("机构专用")) return { type: "inst", label: "机构", color: "#d97706" };
  if (name.includes("拉萨")) return { type: "retail", label: "散户", color: "#f59e0b" };
  const hotMoney = ["知春路", "荣超", "牡丹江路", "太华路", "三元桥", "建国路", "北京朝阳门", "南京王府大街", "广州东风中路"];
  if (hotMoney.some(k => name.includes(k))) return { type: "hot", label: "游资", color: "#dc2626" };
  if (name.includes("总部") || name.includes("分公司")) return { type: "broker", label: "券商", color: "#8b5cf6" };
  return { type: "other", label: "其他", color: "#94a3b8" };
}

function analyzeSeats(seats) {
  if (!seats?.length) return null;
  // 合并同名席位，区分买卖
  const map = new Map();
  for (const s of seats) {
    const key = s.name;
    if (!map.has(key)) map.set(key, { name: s.name, buyAmt: 0, sellAmt: 0, net: 0 });
    const entry = map.get(key);
    entry.buyAmt += s.buyAmt || 0;
    entry.sellAmt += s.sellAmt || 0;
    entry.net += (s.net || 0) || ((s.buyAmt || 0) - (s.sellAmt || 0));
  }
  const merged = [...map.values()];
  // 按净买卖分组
  const topBuy = merged.filter(s => s.net > 0).sort((a, b) => b.net - a.net).slice(0, 5);
  const topSell = merged.filter(s => s.net < 0).sort((a, b) => a.net - b.net).slice(0, 5);
  // 分类汇总
  const typeSum = {};
  for (const s of merged) {
    const cls = classifySeat(s.name);
    if (!typeSum[cls.type]) typeSum[cls.type] = { ...cls, buyAmt: 0, sellAmt: 0, net: 0, count: 0 };
    typeSum[cls.type].buyAmt += s.buyAmt;
    typeSum[cls.type].sellAmt += s.sellAmt;
    typeSum[cls.type].net += s.net;
    typeSum[cls.type].count++;
  }
  return { topBuy, topSell, typeSummary: Object.values(typeSum).sort((a, b) => b.net - a.net) };
}

function analyzeOutlook(analysis) {
  if (!analysis) return null;
  const ts = {};
  for (const t of analysis.typeSummary) ts[t.type] = t;

  const instNet = ts.inst?.net || 0;
  const northNet = ts.north?.net || 0;
  const hotNet = ts.hot?.net || 0;
  const retailNet = ts.retail?.net || 0;
  const brokerNet = ts.broker?.net || 0;
  const otherNet = ts.other?.net || 0;

  const totalSmart = instNet + northNet;  // 聪明钱
  const totalSpec = hotNet;                // 游资
  const totalRetail = retailNet;           // 散户

  let verdict = "";
  let outlook = "";
  let color = "";

  // ── 核心判断逻辑 ──
  if (totalSmart > 0 && totalSpec > 0 && totalRetail <= 0) {
    // 机构+北向+游资共振买入，散户未接盘 → 最强信号
    verdict = "资金共振，强烈看多";
    outlook = "机构+北向+游资三方合力买入，且散户未大规模接盘，筹码锁定好。次日大概率高开，短线可持有，但需关注游资是否次日获利了结——若开盘30分钟内北向/机构继续买入则可加仓。";
    color = "#16a34a";
  } else if (totalSmart > 0 && totalSpec < 0 && totalRetail <= 0) {
    // 机构买入，游资卖出 → 机构接盘游资，中线看好
    verdict = "机构接筹，中线偏多";
    outlook = "游资在出货但机构/北向在接盘，说明聪明钱认可当前价位。短线可能因游资抛压震荡，但中线筹码在向机构集中，调整后有望走趋势。关注次日机构是否继续买入确认信号。";
    color = "#16a34a";
  } else if (totalSmart > 0 && totalRetail > 0) {
    // 机构+散户都在买 → 偏多但警惕
    verdict = "偏多，但散户参与度高";
    outlook = "机构和北向在买是好事，但拉萨席位也在买入，说明散户跟风情绪较重。次日若机构/北向撤退而散户继续接盘，容易高开低走。建议次日关注北向流向，若北向转为卖出应果断减仓。";
    color = "#d97706";
  } else if (totalSmart < 0 && totalRetail > 0) {
    // 散户接盘，机构/北向卖出 → 最危险信号
    verdict = "散户接盘，强烈看空";
    outlook = "这是典型的「散户接盘」格局——机构/北向在卖，拉萨席位在买。聪明钱在撤退而散户在冲，次日大概率低开或冲高回落。持仓者应趁早盘流动性最好时减仓，不宜恋战。";
    color = "#dc2626";
  } else if (totalSpec > 0 && totalSmart <= 0 && totalRetail <= 0) {
    // 纯游资博弈，无机构参与
    verdict = "游资主导，短线博弈";
    outlook = "席位全是游资，没有机构/北向背书，属于纯情绪博弈。游资通常T+1出货，次日高开即是卖点。追高风险极大，已持仓者建议次日冲高减仓，未持仓者不宜追涨。";
    color = "#f59e0b";
  } else if (totalSmart < 0 && totalSpec < 0 && totalRetail <= 0) {
    // 全线卖出
    verdict = "主力出逃，偏空";
    outlook = "机构、北向、游资全线净卖出，资金一致性看空。次日大概率继续承压，持仓者应设好止损，不宜补仓。等待缩量止跌信号再考虑接回。";
    color = "#dc2626";
  } else if (totalSmart > 0 && totalSpec > 0 && totalRetail > 0) {
    // 所有人都在买 → 过热信号
    verdict = "过热，警惕反转";
    outlook = "四方资金（机构/北向/游资/散户）都在买入，短期情绪过于一致。A股历史上「全民买入」往往是短期顶部信号，次日冲高回落的概率较大。建议冲高减仓锁定利润。";
    color = "#dc2626";
  } else {
    verdict = "分歧较大，方向不明";
    outlook = "各路资金方向不一致，没有形成合力。次日走势取决于盘中资金博弈，建议观望为主，等方向明确再操作。";
    color = "#94a3b8";
  }

  return { verdict, outlook, color };
}

function actionAdvice(h, outlook, market) {
  const k = h.kline;
  const chg = h.changePct || 0;
  const turn = h.turnover || 0;

  // ── DT信号 ──
  const dtBull = outlook && (outlook.verdict.includes("强烈看多") || outlook.verdict.includes("偏多"));
  const dtBear = outlook && (outlook.verdict.includes("看空") || outlook.verdict.includes("出逃") || outlook.verdict.includes("过热"));

  // ── 趋势信号 ──
  const trendStrong = k && (k.trend === "多头排列");
  const trendWeak = k && (k.trend === "偏弱");
  const aboveMA5 = k && +k.ma5 && +k.ma10 && (+k.ma5 > +k.ma10);
  const belowMA10 = k && +k.ma10 && h.price < +k.ma10 * 0.97;
  const nearMA5 = k && Math.abs((h.price - +k.ma5) / +k.ma5 * 100) < 3;
  const nearMA10 = k && Math.abs((h.price - +k.ma10) / +k.ma10 * 100) < 3;

  // ── 量价信号 ──
  const volShrink = k && k.volTrend === "缩量";
  const volExpand = k && k.volTrend === "放量";
  const dayUp = chg > 2;
  const dayDown = chg < -2;
  const wUp = k && +k.wChg > 5;
  const wDown = k && +k.wChg < -5;

  // ── 资金信号 ──
  const ff = h.fundFlow;
  const mainIn3 = ff && ff.main3d > 0;
  const mainOut3 = ff && ff.main3d < 0;
  const strongIn5 = ff && ff.main5d > 5000;
  const strongOut5 = ff && ff.main5d < -5000;
  const consIn5 = ff && ff.consDays >= 5 && ff.consDir === "流入";
  const consOut5 = ff && ff.consDays >= 5 && ff.consDir === "流出";

  // ── 情绪信号 ──
  const mkt = market || {};
  const ratio = +mkt.advDecRatio || 1;
  const mktWeak = mkt.sentiment?.includes("弱") || ratio < 0.5;      // 市场偏弱
  const mktStrong = mkt.sentiment?.includes("强") || ratio > 2.5;    // 市场偏强
  const mktPanic = ratio < 0.3;    // 极端恐慌：涨跌比<0.3
  const mktGreedy = ratio > 4;     // 极端贪婪：涨跌比>4
  const northIn = (mkt.northbound?.total || 0) > 30;    // 北向大幅流入>30亿
  const northOut = (mkt.northbound?.total || 0) < -30;  // 北向大幅流出>30亿
  // 个股是否在热门题材中
  const hotTopics = mkt.hotTopics || [];
  const inHotTopic = h.conceptTags?.some(tag =>
    hotTopics.some(t => t.topic === tag)
  );

  // ═══════════════════════════════════════════════════
  // 做多信号
  // ═══════════════════════════════════════════════════

  // 🅐 买入：DT强烈看多 + 趋势多头 + 资金流入
  if (dtBull && outlook.verdict.includes("强烈看多") && trendStrong && mainIn3) {
    return { action: "买入", color: "#16a34a", reason: "席位共振+均线多头+主力流入，买点确认" };
  }

  // 🅑 金叉启动（无DT）：MA5>MA10 + 放量涨 + 主力流入
  if (!dtBear && aboveMA5 && volExpand && dayUp && mainIn3) {
    return { action: "买入", color: "#16a34a", reason: "MA5>MA10+放量上涨+主力流入，金叉启动信号" };
  }

  // 🅒 主力吸筹（无DT）：连续5日流入 + 回踩均线 + 趋势不弱
  if (!dtBear && consIn5 && (nearMA5 || nearMA10) && !trendWeak) {
    return { action: "加仓", color: "#16a34a", reason: `主力连续${ff.consDays}日流入，回踩均线，吸筹迹象明显` };
  }

  // 🅓 缩量回调企稳（无DT）：缩量回踩5日线 + 主力未出 + 趋势不弱
  if (!dtBear && volShrink && nearMA5 && !mainOut3 && !trendWeak && !dayDown) {
    return { action: "加仓", color: "#16a34a", reason: "缩量回踩5日线，抛压衰竭，企稳加仓点" };
  }

  // 🅔 DT加仓：龙虎榜偏多 + 回踩均线
  if (dtBull && (nearMA5 || nearMA10) && !trendWeak) {
    return { action: "加仓", color: "#16a34a", reason: `龙虎榜看多，回踩${nearMA5?'5':''}${nearMA5&&nearMA10?'/':''}${nearMA10?'10':''}日线` };
  }

  // ═══════════════════════════════════════════════════
  // 做T信号
  // ═══════════════════════════════════════════════════

  // 🅕 高换手做T
  if (turn > 5 && Math.abs(chg) < 5 && !dtBear && !trendWeak) {
    return { action: "做T", color: "#f59e0b", reason: "高换手日内波动大，适合做T降成本" };
  }
  // 🅖 大幅波动做T
  if (Math.abs(chg) > 3 && turn > 3 && !trendWeak) {
    return { action: "做T", color: "#f59e0b", reason: "当日波动较大，日内做T机会" };
  }
  // 🅗 高位放量做T（无DT）：5日涨超5% + 放量 + 主力流入放缓
  if (wUp && volExpand && ff && ff.main3d < ff.main5d * 0.3) {
    return { action: "做T", color: "#f59e0b", reason: "短线涨幅较大+主力流入放缓，日内高抛低吸" };
  }

  // ═══════════════════════════════════════════════════
  // 做空/防御信号
  // ═══════════════════════════════════════════════════

  // 🅘 卖出：DT看空 + 趋势弱 + 主力出
  if (dtBear && trendWeak && mainOut3) {
    return { action: "卖出", color: "#dc2626", reason: "龙虎榜看空+趋势走弱+主力流出，三重卖出信号" };
  }

  // 🅙 破位止损（无DT）：跌破10日线3%+ + 主力流出
  if (belowMA10 && mainOut3 && !dtBull) {
    return { action: "卖出", color: "#dc2626", reason: `跌破10日线+主力流出，破位止损信号` };
  }

  // 🅚 高位背离（无DT）：5日涨超5% + 主力连续流出
  if (wUp && consOut5 && !dtBull) {
    return { action: "减仓", color: "#d97706", reason: `股价上涨但主力连续${ff.consDays}日流出，量价背离，减仓避险` };
  }

  // 🅛 减仓：DT偏空 或 主力大幅流出+缩量
  if (dtBear || (strongOut5 && volShrink)) {
    const r = dtBear ? "龙虎榜资金偏空" : `主力连续${ff?.consDays||''}日流出+缩量，短期承压`;
    return { action: "减仓", color: "#d97706", reason: r };
  }

  // 🅜 弱趋势 + 主力大幅流出
  if (trendWeak && strongOut5) {
    return { action: "减仓", color: "#d97706", reason: "趋势偏弱+主力大幅流出，适当减仓" };
  }

  // 🅝 5日连跌 + 主力流出
  if (wDown && mainOut3) {
    return { action: "减仓", color: "#d97706", reason: "5日跌幅较大+主力流出，短线仍有下行压力" };
  }

  // ═══════════════════════════════════════════════════
  // 情绪策略
  // ═══════════════════════════════════════════════════

  // 🅞 冰点反转（极端恐慌+个股在热门题材+主力流入）
  if (mktPanic && inHotTopic && mainIn3 && !trendWeak) {
    return { action: "买入", color: "#16a34a", reason: `市场冰点(涨跌比${ratio.toFixed(2)})+热门题材+主力逆势流入，恐慌抄底` };
  }

  // 🅟 极端恐慌防御（市场恐慌但个股偏弱）
  if (mktPanic && (trendWeak || mainOut3)) {
    return { action: "减仓", color: "#d97706", reason: `市场极端恐慌(涨跌比${ratio.toFixed(2)})，个股偏弱，先避险` };
  }

  // 🅠 过热减仓（极端贪婪）
  if (mktGreedy && wUp) {
    return { action: "减仓", color: "#d97706", reason: `市场过热(涨跌比${ratio.toFixed(2)})+个股短线涨幅大，分批止盈` };
  }

  // 🅡 北向背离（北向大幅流出但个股主力流入）
  if (northOut && mainIn3 && aboveMA5 && inHotTopic) {
    return { action: "观望", color: "#f59e0b", reason: "北向大幅流出但个股主力逆势流入+题材加持，独立行情，等待确认" };
  }

  // 🅢 北向共振（北向大幅流入+个股主力流入+趋势强）
  if (northIn && mainIn3 && trendStrong) {
    return { action: "加仓", color: "#16a34a", reason: `北向流入${mkt.northbound?.total}亿+主力共振+多头排列，顺势加仓` };
  }

  // 🅣 弱市逆势（市场弱但个股主力大幅流入+MA5>MA10）
  if (mktWeak && strongIn5 && aboveMA5 && !dayDown) {
    return { action: "持有", color: "#2563eb", reason: "市场偏弱但个股主力逆势大幅流入+均线偏多，抗跌信号，持股观察" };
  }

  // 🅤 题材降温（偏离热门题材+趋势弱+主力流出）
  if (!inHotTopic && h.conceptTags?.length && trendWeak && mainOut3) {
    return { action: "减仓", color: "#d97706", reason: "不在热门题材+趋势偏弱+主力流出，短线缺乏催化" };
  }

  return { action: "观望", color: "#64748b", reason: "信号不明确，建议观望等待方向" };
}

function advicePanel(h, outlook, market) {
  const k = h.kline;
  const chg = h.changePct || 0;
  const pe = h.pe || 0;
  const turn = h.turnover || 0;
  const ff = h.fundFlow;
  const inHotTopic = h.conceptTags?.some(tag =>
    (market?.hotTopics || []).some(t => t.topic === tag)
  );

  // ── 短线分析 ──
  const shortLines = [];
  if (k) {
    // 趋势 + 均线
    shortLines.push(`趋势<span style="color:${k.trend==='多头排列'?'#16a34a':k.trend==='偏弱'?'#dc2626':'#d97706'}">${k.trend}</span>，MA5/10: ${k.ma5}/${k.ma10}`);
    if (+k.ma5 > +k.ma10) shortLines.push(`<span style="color:#16a34a">✓ MA5>MA10 短线偏多</span>`);
    else shortLines.push(`<span style="color:#dc2626">⚠ MA5<MA10 短线偏空，${h.price < +k.ma10 ? '股价跌破10日线' : '关注10日线支撑'}</span>`);
    // 量价
    shortLines.push(`量能<span style="color:${k.volTrend==='放量'?'#dc2626':k.volTrend==='缩量'?'#16a34a':'#64748b'}">${k.volTrend}</span>，5日涨<span class="${+k.wChg>=0?'bull':'bear'}">${k.wChg}%</span>，换手${turn}%`);
    // 量价关系提示
    if (k.volTrend === '放量' && +k.wChg > 5) shortLines.push(`<span style="color:#d97706">⚡ 放量拉升，短线加速但有追高风险</span>`);
    if (k.volTrend === '缩量' && +k.wChg > 0) shortLines.push(`<span style="color:#f59e0b">缩量上涨，上涨动能减弱</span>`);
    if (k.volTrend === '缩量' && +k.wChg < 0) shortLines.push(`<span style="color:#16a34a">✓ 缩量下跌，抛压衰减</span>`);
  }
  // 资金面
  if (ff) {
    const todayMain = ff.today?.mainNet || 0;
    const dir = todayMain >= 0 ? '流入' : '流出';
    const clr = todayMain >= 0 ? '#dc2626' : '#16a34a';
    shortLines.push(`主力: 今日<span style="color:${clr}">${dir}${(Math.abs(todayMain)/1e4).toFixed(0)}万</span>，3日${(ff.main3d/1e4).toFixed(0)}万，5日${(ff.main5d/1e4).toFixed(0)}万`);
    if (ff.consDays >= 3) shortLines.push(`<span style="color:${ff.consDir==='流入'?'#dc2626':'#16a34a'}">主力连续${ff.consDays}日${ff.consDir}</span>`);
    if (!ff.today?.mainNet && ff.main3d === 0) shortLines.push(`<span style="color:#94a3b8">主力近期无方向，等待资金选择</span>`);
  }
  // 龙虎榜
  if (outlook) {
    shortLines.push(`龙虎榜: <span style="color:${outlook.color}">${outlook.verdict}</span>`);
  } else if (h.dragonTiger?.count) {
    shortLines.push(`近期上榜${h.dragonTiger.count}次，席位资金关注`);
  }
  // 市场情绪
  const mktNote = market?.sentiment || '';
  if (mktNote.includes("弱")) shortLines.push(`<span style="color:#dc2626">市场情绪偏弱，追高需谨慎</span>`);
  else if (mktNote.includes("强")) shortLines.push(`<span style="color:#16a34a">市场情绪偏强，短线容错率高</span>`);

  // 情绪面
  const ratio = +market?.advDecRatio || 1;
  if (ratio < 0.3) shortLines.push(`<span style="color:#dc2626">⚠ 市场冰点！涨跌比${ratio.toFixed(2)}，恐慌情绪极重</span>`);
  else if (ratio < 0.5) shortLines.push(`<span style="color:#d97706">市场偏弱，涨跌比${ratio.toFixed(2)}</span>`);
  else if (ratio > 4) shortLines.push(`<span style="color:#dc2626">⚠ 市场过热！涨跌比${ratio.toFixed(2)}，追高风险大</span>`);
  else if (ratio > 2.5) shortLines.push(`<span style="color:#f59e0b">市场偏强，涨跌比${ratio.toFixed(2)}</span>`);
  if (market?.northbound?.total) {
    const nb = market.northbound.total;
    if (nb > 30) shortLines.push(`北向大幅流入<span style="color:#dc2626">${nb}亿</span>`);
    else if (nb < -30) shortLines.push(`北向大幅流出<span style="color:#16a34a">${nb}亿</span>`);
  }
  if (inHotTopic) shortLines.push(`<span style="color:#d97706">🔥 持仓在今日热门题材中</span>`);

  const advice = actionAdvice(h, outlook, market);
  shortLines.push(`<b style="color:${advice.color}">→ 短线: ${advice.action}</b> · ${advice.reason}`);

  // ── 长线分析 ──
  const longLines = [];
  const rp = h.reports;

  // 研报目标价
  if (rp?.items?.length) {
    longLines.push(`<b>最新${rp.items.length}份研报</b> — 一致评级: <span style="color:#d97706">${rp.consensusRating || '-'}</span>`);
    if (rp.avgTarget) {
      const upside = ((rp.avgTarget - h.price) / h.price * 100).toFixed(1);
      const upClr = +upside >= 20 ? '#16a34a' : +upside >= 0 ? '#d97706' : '#dc2626';
      longLines.push(`目标均价<span style="color:${upClr};font-weight:600">${rp.avgTarget.toFixed(2)}</span> (高${rp.highTarget?.toFixed(2)} / 低${rp.lowTarget?.toFixed(2)})，上涨空间<span style="color:${upClr}">${upside}%</span>`);
    }
    if (rp.avgEps1) {
      const fwdPE = h.price / rp.avgEps1;
      longLines.push(`一致预期EPS: 今年${rp.avgEps1} / 明年${rp.avgEps2 || '-'}，前向PE ${fwdPE.toFixed(1)}x`);
    }
    // 列出各机构观点
    rp.items.slice(0, 3).forEach(r => {
      const parts = [];
      if (r.rating) parts.push(`<span style="color:${r.rating.includes('买入')?'#16a34a':r.rating.includes('增持')?'#2563eb':'#64748b'}">${r.rating}</span>`);
      if (r.eps2) parts.push(`EPS${r.eps2}`);
      if (r.targetPrice) parts.push(`目标${r.targetPrice}`);
      longLines.push(`<span style="font-size:10px;color:#94a3b8">${r.date?.slice(0,7)||''} ${r.org}</span> ${parts.join(' · ')}`);
    });
  } else {
    if (pe > 0) {
      if (pe > 100) longLines.push(`PE ${pe.toFixed(0)}x，估值偏高，需业绩高速增长消化`);
      else if (pe > 50) longLines.push(`PE ${pe.toFixed(0)}x，中等偏高，关注增速能否匹配`);
      else if (pe > 20) longLines.push(`PE ${pe.toFixed(0)}x，估值合理`);
      else longLines.push(`PE ${pe.toFixed(0)}x，估值偏低，具有安全边际`);
    } else {
      longLines.push(`PE亏损，需关注扭亏时间点和业绩拐点`);
    }
  }
  if (h.pb) longLines.push(`PB ${h.pb.toFixed(2)}x，市值${h.mcap?.toFixed(0) || '?'}亿`);

  if (h.dragonTiger?.institution) {
    const inst = h.dragonTiger.institution;
    if (inst.netAmt > 5000) longLines.push(`<span style="color:#16a34a">机构席位净买${inst.netAmt}万，中线资金认可</span>`);
    else if (inst.netAmt < -5000) longLines.push(`<span style="color:#dc2626">机构席位净卖${Math.abs(inst.netAmt)}万，中线资金撤离</span>`);
  }

  if (h.mainSector) {
    const sec = h.mainSector;
    const secChg = sec.changePct != null ? +sec.changePct : 0;
    longLines.push(`板块<span class="${secChg>=0?'bull':'bear'}">${sec.name||sec} ${secChg>0?'+':''}${secChg}%</span>`);
  }

  if (h.conceptTags?.length) {
    longLines.push(`概念: ${h.conceptTags.slice(0,4).join('、')}`);
  }

  // 长线建议
  let longAction = "持有观察";
  let longColor = "#64748b";
  let longReason = "";
  if (rp?.avgTarget) {
    const upside = ((rp.avgTarget - h.price) / h.price * 100);
    if (upside >= 30 && rp.consensusRating?.includes("买入")) {
      longAction = "可长期配置"; longColor = "#16a34a";
      longReason = `机构一致看多，目标价上涨空间${upside.toFixed(0)}%，估值有支撑`;
    } else if (upside >= 10) {
      longAction = "逢低布局"; longColor = "#2563eb";
      longReason = `目标价空间${upside.toFixed(0)}%，回调时分批建仓`;
    } else if (upside >= -10) {
      longAction = "持有观察"; longColor = "#64748b";
      longReason = `目标价接近现价，空间有限，等待催化剂`;
    } else {
      longAction = "警惕高估"; longColor = "#dc2626";
      longReason = `机构目标价低于现价，长线需谨慎`;
    }
  } else if (pe > 0 && pe < 30 && h.dragonTiger?.institution?.netAmt > 0) {
    longAction = "可长期配置"; longColor = "#16a34a";
    longReason = "估值合理且机构认可，适合作为底仓";
  } else if (pe > 100) {
    longAction = "不宜重仓"; longColor = "#d97706";
    longReason = "估值偏高，长线需等待业绩兑现或回调至合理区间";
  } else if (pe <= 0) {
    longAction = "观望为主"; longColor = "#64748b";
    longReason = "公司处于亏损状态，等业绩拐点明确后再考虑长线布局";
  }
  longLines.push(`<b style="color:${longColor}">→ 长线建议: ${longAction}</b> · ${longReason}`);

  return { shortHtml: shortLines.map(l => `<div style="margin-bottom:3px;font-size:11px;line-height:1.6">${l}</div>`).join(""), longHtml: longLines.map(l => `<div style="margin-bottom:3px;font-size:11px;line-height:1.6">${l}</div>`).join("") };
}

async function init() {
  try {
    const r = await fetch("/api/review");
    const d = await r.json();
    if (d.error) { document.getElementById("metaInfo").textContent = d.error; return; }

    document.getElementById("metaInfo").textContent = `${d.date} · ${d.generatedAt}`;

    renderSentiment(d.market);
    renderSummary(d.summary);
    if (d.market?.hotTopics?.length) renderThemes(d.market.hotTopics);
    renderHoldings(d.holdings, d.market);
    window._holdingsData = d.holdings;
    if (d.dragonAlert?.length) renderDragonAlert(d.dragonAlert);
  } catch (e) {
    document.getElementById("metaInfo").textContent = "加载失败: " + e.message;
  }
}

function renderSentiment(m) {
  if (!m) return;
  const cls = (m.sentiment || "").includes("强") ? "bull" : (m.sentiment || "").includes("弱") ? "bear" : "neutral";
  const nbCls = (m.northbound?.total || 0) >= 0 ? "bull" : "bear";

  document.getElementById("sentiment").innerHTML = `
    <div class="s-card">
      <h3>市场情绪</h3>
      <div class="big ${cls}">${m.sentiment || "-"}</div>
      <div class="sub">涨跌比 ${m.advDecRatio || "-"}</div>
      <div class="breadth-bar-wrap">
        <div class="breadth-bar">
          <div class="up" style="flex:${m.advancing || 1}"></div>
          <div class="down" style="flex:${m.declining || 1}"></div>
          <div class="flat" style="flex:${m.flat || 1}"></div>
        </div>
        <div class="breadth-leg">
          <span><span class="dot" style="background:#16a34a"></span>上涨${m.advancing}</span>
          <span><span class="dot" style="background:#dc2626"></span>下跌${m.declining}</span>
          <span><span class="dot" style="background:#e2e8f0;border:1px solid #ccc"></span>平${m.flat}</span>
        </div>
      </div>
    </div>
    <div class="s-card">
      <h3>北向资金</h3>
      <div class="big ${nbCls}">${m.northbound?.total ?? "-"}<span style="font-size:14px;font-weight:400"> 亿</span></div>
      <div class="sub">沪 ${m.northbound?.hgt ?? "-"} 亿 · 深 ${m.northbound?.sgt ?? "-"} 亿</div>
    </div>
    <div class="s-card">
      <h3>上涨家数</h3>
      <div class="big bull">${m.advancing ?? "-"}</div>
      <div class="sub">全市场</div>
    </div>
    <div class="s-card">
      <h3>下跌家数</h3>
      <div class="big bear">${m.declining ?? "-"}</div>
      <div class="sub">全市场</div>
    </div>
  `;
}

function renderSummary(s) {
  if (!s) return;
  document.getElementById("summaryCards").innerHTML = `
    <div class="card"><div class="val">${s.up}<span style="font-size:14px">涨</span> / ${s.down}<span style="font-size:14px">跌</span></div><div class="lbl">持仓涨跌</div></div>
    <div class="card"><div class="val ${+s.avgChg >= 0 ? 'bull' : 'bear'}">${+s.avgChg >= 0 ? '+' : ''}${s.avgChg}%</div><div class="lbl">平均涨跌</div></div>
    <div class="card"><div class="val" style="color:var(--red)">${s.topGainer || '-'}</div><div class="lbl">最强持仓</div></div>
    <div class="card"><div class="val" style="color:var(--green)">${s.topLoser || '-'}</div><div class="lbl">最弱持仓</div></div>
    <div class="card"><div class="val">${s.totalMcap}亿</div><div class="lbl">持仓总市值</div></div>
  `;
}

function renderThemes(topics) {
  document.getElementById("themesSection").style.display = "block";
  document.getElementById("themes").innerHTML = topics.map(t =>
    `<span class="theme-tag">${t.topic} (${t.count}股)</span>`
  ).join("");
}

function renderHoldings(holdings, market) {
  if (!holdings?.length) {
    document.getElementById("holdings").innerHTML = '<div class="empty">暂无数据</div>';
    return;
  }

  document.getElementById("holdings").innerHTML = holdings.map((h, i) => {
    const up = h.changePct > 0;
    const flat = h.changePct === 0;
    const seatAnalysis = analyzeSeats(h.dragonTiger?.seats);
    const outlook = analyzeOutlook(seatAnalysis);
    const advice = actionAdvice(h, outlook, market);
    const panel = advicePanel(h, outlook, market);

    return `
    <div class="holding-card" style="border-left:4px solid ${advice.color}">
      <div class="hc-header" onclick="this.nextElementSibling.classList.toggle('show'); this.querySelector('.arrow').classList.toggle('open'); if(!this.parentElement.dataset.charted){ window.initOneChart('${h.code}'); this.parentElement.dataset.charted='1'; }">
        <span class="advice-strip" style="background:${advice.color};color:#fff;padding:5px 14px;border-radius:8px;font-size:13px;font-weight:700;margin-right:4px" title="${advice.reason}">${advice.action}</span>
        <span class="rank">${i + 1}</span>
        <span class="code">${h.code}</span>
        <span class="name">${h.name}</span>
        <span class="price">${h.price ?? "-"}</span>
        <span class="chg ${up ? 'chg-up' : 'chg-down'}">${up ? '+' : ''}${h.changePct ?? 0}%</span>
        <span class="pe">PE ${h.pe > 0 ? h.pe.toFixed(0) : '亏损'}</span>
        <span class="mcap">${h.mcap ? (h.mcap >= 10000 ? (h.mcap/10000).toFixed(1)+'万亿' : h.mcap.toFixed(0)+'亿') : '-'}</span>
        <span class="arrow">▼</span>
      </div>
      <div class="hc-detail">
        <div class="detail-top">
          <div class="chart-wrap" id="chart-${h.code}">
            <div class="chart-tooltip" id="tt-${h.code}"></div>
            <div class="chart-legend">
              <span class="cl-item"><span class="cl-dot" style="background:#dc2626"></span>K线</span>
              <span class="cl-item"><span class="cl-dot" style="background:#f59e0b"></span>MA5</span>
              <span class="cl-item"><span class="cl-dot" style="background:#8b5cf6"></span>MA10</span>
            </div>
          </div>
          <div class="advice-panel">
            <div class="ap-section">
              <div class="ap-title" style="color:#dc2626">短线操作</div>
              ${panel.shortHtml}
            </div>
            <div class="ap-section">
              <div class="ap-title" style="color:#2563eb">长线操作</div>
              ${panel.longHtml}
            </div>
          </div>
        </div>
        <div class="detail-grid">
          ${h.kline ? `
          <div class="detail-item">
            <h4>技术面</h4>
            <p>
              趋势: <b>${h.kline.trend}</b><br>
              MA5:${h.kline.ma5} MA10:${h.kline.ma10}<br>
              量能: ${h.kline.volTrend}<br>
              5日涨: <span class="${+h.kline.wChg >= 0 ? 'bull' : 'bear'}">${h.kline.wChg}%</span>
            </p>
          </div>
          ` : ''}
          ${h.fundFlow ? `
          <div class="detail-item">
            <h4>资金面</h4>
            <p>
              主力今日: <span style="color:${(h.fundFlow.today?.mainNet||0)>=0?'#dc2626':'#16a34a'}">${(h.fundFlow.today?.mainNet||0)>=0?'流入':'流出'}${(Math.abs(h.fundFlow.today?.mainNet||0)/1e4).toFixed(1)}万</span><br>
              3日主力: ${(h.fundFlow.main3d/1e4).toFixed(1)}万<br>
              5日主力: ${(h.fundFlow.main5d/1e4).toFixed(1)}万<br>
              连续${h.fundFlow.consDays}日${h.fundFlow.consDir}
            </p>
          </div>
          ` : ''}
          <div class="detail-item">
            <h4>基本面</h4>
            <p>
              现价: ${h.price} | PE: ${h.pe > 0 ? h.pe.toFixed(1) : '亏损'} | PB: ${h.pb?.toFixed(2) || '-'}<br>
              市值: ${h.mcap?.toFixed(0) || '-'}亿 | 换手: ${h.turnover || '-'}%<br>
              成交额: ${h.amount ? (h.amount/10000).toFixed(1)+'亿' : '-'}
            </p>
          </div>
          ${h.mainSector ? `
          <div class="detail-item">
            <h4>所属板块</h4>
            <p>${h.mainSector.name || h.mainSector} ${h.mainSector.changePct != null ? `<span class="${h.mainSector.changePct >= 0 ? 'bull' : 'bear'}">${h.mainSector.changePct > 0 ? '+' : ''}${h.mainSector.changePct}%</span>` : ''}</p>
            ${h.conceptTags?.length ? `<p>${h.conceptTags.map(t => `<span class="tag">${t}</span>`).join(" ")}</p>` : ''}
          </div>
          ` : ''}
          ${h.dragonTiger ? (() => {
            const analysis = seatAnalysis;
            return `
          <div class="detail-item">
            <h4>龙虎榜（近30天上榜${h.dragonTiger.count}次）</h4>
            ${h.dragonTiger.latest.map((dt, j) => `<div class="dt-entry"><span style="color:var(--muted)">${dt.date}</span>${j === 0 ? ' <span style="font-size:10px;color:#f59e0b">最新</span>' : ''} ${dt.reason} · 净买${dt.netBuy}万</div>`).join("")}
            ${analysis ? `
            <div style="margin-top:8px;padding-top:8px;border-top:1px solid #f1f5f9">
              <div style="font-size:11px;color:var(--muted);margin-bottom:2px">席位资金结构 <span style="font-size:10px;color:#94a3b8">(${h.dragonTiger.latest[0]?.date || '?'} 上榜)</span></div>
              ${(() => {
                const buyers = analysis.typeSummary.filter(t => t.net > 0);
                const sellers = analysis.typeSummary.filter(t => t.net < 0);
                let html2 = '';
                if (buyers.length) html2 += `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:4px"><span style="font-size:10px;color:var(--red);line-height:20px;min-width:14px">买</span>` + buyers.map(t => `<span style="display:inline-flex;align-items:center;gap:3px;font-size:11px;padding:2px 8px;border-radius:4px;background:${t.color}10;border:1px solid ${t.color}30"><span style="width:6px;height:6px;border-radius:50%;background:${t.color}"></span>${t.label} +${t.net.toFixed(0)}万</span>`).join("") + `</div>`;
                if (sellers.length) html2 += `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px"><span style="font-size:10px;color:var(--green);line-height:20px;min-width:14px">卖</span>` + sellers.map(t => `<span style="display:inline-flex;align-items:center;gap:3px;font-size:11px;padding:2px 8px;border-radius:4px;background:${t.color}10;border:1px solid ${t.color}30"><span style="width:6px;height:6px;border-radius:50%;background:${t.color}"></span>${t.label} ${t.net.toFixed(0)}万</span>`).join("") + `</div>`;
                return html2;
              })()}
              ${analysis.topBuy.length ? `<div style="font-size:11px;margin-bottom:2px"><span style="color:var(--red)">主要买方:</span> ${analysis.topBuy.slice(0,3).map(s => `${s.name.replace(/证券营业部|证券股份有限公司|有限公司/g,'')} +${s.net.toFixed(0)}万`).join(" · ")}</div>` : ''}
              ${analysis.topSell.length ? `<div style="font-size:11px"><span style="color:var(--green)">主要卖方:</span> ${analysis.topSell.slice(0,3).map(s => `${s.name.replace(/证券营业部|证券股份有限公司|有限公司/g,'')} ${s.net.toFixed(0)}万`).join(" · ")}</div>` : ''}
            </div>
            ${outlook ? `
            <div style="margin-top:6px;padding:8px 10px;border-radius:6px;background:${outlook.color}10;border-left:3px solid ${outlook.color}">
              <div style="font-size:13px;font-weight:600;color:${outlook.color};margin-bottom:3px">${outlook.verdict}</div>
              <div style="font-size:11px;color:#475569;line-height:1.6">${outlook.outlook}</div>
            </div>
            ` : ''}
            ` : ''}
          </div>
          `; })()
          : ''}
          ${h.recentNews?.length ? `
          <div class="detail-item">
            <h4>近期要闻</h4>
            ${h.recentNews.map(n => `<div class="dt-entry"><span style="color:var(--muted)">${n.date || '?'}</span> ${n.url ? `<a href="${n.url}" target="_blank" style="color:var(--text);text-decoration:none" onmouseenter="this.style.color='var(--accent)'" onmouseleave="this.style.color='var(--text)'">${n.title}</a>` : n.title} <span style="color:#94a3b8">(${n.source || '?'})</span></div>`).join("")}
          </div>
          ` : ''}
        </div>
      </div>
    </div>`;
  }).join("");
}

window.initOneChart = async function(code) {
  const container = document.getElementById(`chart-${code}`);
  if (!container) return;

  const h = (window._holdingsData || []).find(x => x.code === code);
  if (!h) return;

  try {
    const r = await fetch(`/api/kline/${code}`);
    const d = await r.json();
    if (!d.data?.length) return;

    const rows = d.data;
    const tooltip = document.getElementById(`tt-${code}`);

    const dtMap = new Map();
    const dtMarkers = [];
    if (h.dragonTiger?.latest) {
      for (const dt of h.dragonTiger.latest) {
        dtMap.set(dt.date, dt);
        dtMarkers.push({
          time: dt.date, position: 'aboveBar',
          color: dt.netBuy >= 0 ? '#dc2626' : '#16a34a',
          shape: 'circle', size: 2,
        });
      }
    }

    const latestDTDate = h.dragonTiger?.latest?.[0]?.date;
    const seatAnalysis = analyzeSeats(h.dragonTiger?.seats);
    const outlook = analyzeOutlook(seatAnalysis);

    const chart = LightweightCharts.createChart(container, {
      width: container.clientWidth,
      height: 280,
      layout: { background: { color: '#ffffff' }, textColor: '#64748b' },
      grid: { vertLines: { color: '#f1f5f9' }, horzLines: { color: '#f1f5f9' } },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: '#e2e8f0', scaleMargins: { top: 0.15, bottom: 0.15 } },
      timeScale: { borderColor: '#e2e8f0', timeVisible: false },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#dc2626', downColor: '#16a34a', borderUpColor: '#dc2626', borderDownColor: '#16a34a',
      wickUpColor: '#dc2626', wickDownColor: '#16a34a',
    });

    candleSeries.setData(rows.map(r => ({
      time: r.date, open: r.open, high: r.high, low: r.low, close: r.close,
    })));

    for (const mk of [{ key: 'ma5', color: '#f59e0b' }, { key: 'ma10', color: '#8b5cf6' }, { key: 'ma20', color: '#2563eb' }]) {
      const maData = rows.filter(r => r[mk.key] != null).map(r => ({ time: r.date, value: r[mk.key] }));
      if (maData.length) {
        const ls = chart.addLineSeries({ color: mk.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
        ls.setData(maData);
      }
    }

    if (dtMarkers.length) candleSeries.setMarkers(dtMarkers);

    chart.timeScale().fitContent();

    chart.subscribeCrosshairMove(param => {
      if (!param.time || !param.point) { tooltip.style.display = 'none'; return; }
      const dt = dtMap.get(param.time);
      if (!dt) { tooltip.style.display = 'none'; return; }

      const price = param.seriesData.get(candleSeries);
      const priceStr = price ? `O:${price.open.toFixed(2)} H:${price.high.toFixed(2)} L:${price.low.toFixed(2)} C:${price.close.toFixed(2)}` : '';
      const isLatest = dt.date === latestDTDate;
      let seatHtml = '';
      if (isLatest && seatAnalysis) {
        const buyers = seatAnalysis.typeSummary.filter(t => t.net > 0);
        const sellers = seatAnalysis.typeSummary.filter(t => t.net < 0);
        if (buyers.length) seatHtml += '<div style="font-size:10px;margin:4px 0 2px"><span style="color:#ef4444">买:</span> ' + buyers.map(t => '<span style="color:' + t.color + '">' + t.label + ' +' + t.net.toFixed(0) + '万</span>').join(' · ') + '</div>';
        if (sellers.length) seatHtml += '<div style="font-size:10px;margin:2px 0"><span style="color:#22c55e">卖:</span> ' + sellers.map(t => '<span style="color:' + t.color + '">' + t.label + ' ' + t.net.toFixed(0) + '万</span>').join(' · ') + '</div>';
        if (outlook) seatHtml += '<div style="margin-top:4px;padding-top:4px;border-top:1px solid rgba(255,255,255,0.15)"><div style="font-size:12px;font-weight:600;color:' + outlook.color + '">' + outlook.verdict + '</div><div style="font-size:10px;color:#cbd5e1;line-height:1.5;margin-top:2px">' + outlook.outlook + '</div></div>';
      }

      tooltip.innerHTML = '<div class="tt-date">' + dt.date + ' 龙虎榜' + (isLatest ? ' <span style="color:#f59e0b;font-size:10px">(最新)</span>' : '') + '</div><div style="margin:2px 0">' + dt.reason + ' · <span class="tt-val" style="color:' + (dt.netBuy>=0?'#dc2626':'#16a34a') + '">净' + (dt.netBuy>=0?'买':'卖') + Math.abs(dt.netBuy) + '万</span></div>' + seatHtml + (priceStr ? '<div style="color:#94a3b8;font-size:10px;margin-top:3px">' + priceStr + '</div>' : '');
      tooltip.style.display = 'block';
      tooltip.style.left = Math.min(param.point.x + 15, container.clientWidth - 180) + 'px';
      tooltip.style.top = Math.min(param.point.y + 10, 240) + 'px';
    });

    new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth });
    }).observe(container);

  } catch { /* skip */ }
};

function renderDragonAlert(alerts) {
  document.getElementById("dragonSection").style.display = "block";
  document.getElementById("dragonAlert").innerHTML = alerts.map(a => {
    const analysis = analyzeSeats(a.seats);
    return `
    <div class="alert-card">
      <h3>${a.name}(${a.code}) — 近30天上榜${a.count}次</h3>
      <div style="font-size:12px;color:var(--muted)">
        ${a.latest.map(dt => `${dt.date}: ${dt.reason} 净买${dt.netBuy}万`).join("<br>")}
      </div>
      ${analysis ? (() => {
        const buyers = analysis.typeSummary.filter(t => t.net > 0);
        const sellers = analysis.typeSummary.filter(t => t.net < 0);
        let html3 = '';
        if (buyers.length) html3 += `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:5px;align-items:center"><span style="font-size:10px;color:#ef4444;min-width:14px">买</span>` + buyers.map(t => `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:${t.color}15;border:1px solid ${t.color}40;color:${t.color}">${t.label} +${t.net.toFixed(0)}万</span>`).join("") + `</div>`;
        if (sellers.length) html3 += `<div style="margin-top:5px;display:flex;flex-wrap:wrap;gap:5px;align-items:center"><span style="font-size:10px;color:#22c55e;min-width:14px">卖</span>` + sellers.map(t => `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:${t.color}15;border:1px solid ${t.color}40;color:${t.color}">${t.label} ${t.net.toFixed(0)}万</span>`).join("") + `</div>`;
        return html3;
      })() : ''}
    </div>
  `; }).join("");
}

init();
