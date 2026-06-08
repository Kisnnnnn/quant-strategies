/**
 * Serenity 9条好卡点判据评分引擎
 *
 * 对每条判据进行自动化评分（0~1），
 * 能取到数据的自动算，取不到的返回 null 标记为 [需人工判断]
 */

/**
 * @param {Object} stock - 行情数据 {code, name, price, peTtm, pb, mcapYi, turnoverPct, ...}
 * @param {Object} financial - 财务数据 {revenue, netProfit, grossMargin, cash, totalDebt, revenueCagr, ...}
 * @param {Object} supplyChain - 供应链位置 {layer, tier, subLayer, bottleneck, ...}
 * @param {Object} thresholds - 阈值配置
 * @returns {Object} { scores: {criteria_id: {score, confidence, detail}}, totalScore }
 */
export function scoreCriteria(stock, financial, supplyChain, thresholds = {}) {
  const t = {
    maxMcapYi: thresholds.max_mcap_yi || 200,
    maxFwdPE: thresholds.max_fwd_pe || 100,
    minGrossMargin: thresholds.min_gross_margin || 0.25,
    maxInstitutionalPct: thresholds.max_institutional_pct || 40,
    maxSingleCustomerPct: thresholds.max_single_customer_pct || 40,
    targetPE: thresholds.target_pe || 30,
    ...thresholds,
  };

  const results = {
    c1_monopoly: scoreMonopoly(stock, supplyChain),
    c2_mcap_vs_tam: scoreMcapVsTam(stock, financial, t),
    c3_designed_in: scoreDesignedIn(stock, supplyChain),
    c4_certification: scoreCertification(financial, supplyChain),
    c5_balance_sheet: scoreBalanceSheet(stock, financial),
    c6_supply_demand: scoreSupplyDemand(financial, supplyChain),
    c7_policy_moat: scorePolicyMoat(stock, supplyChain),
    c8_institutional: scoreInstitutional(stock, financial, t),
    c9_valuation: scoreValuationMargin(stock, financial, t),
  };

  const weights = thresholds.weights || {
    c1_monopoly: 0.18,
    c2_mcap_vs_tam: 0.15,
    c3_designed_in: 0.15,
    c4_certification: 0.12,
    c5_balance_sheet: 0.10,
    c6_supply_demand: 0.08,
    c7_policy_moat: 0.08,
    c8_institutional: 0.08,
    c9_valuation: 0.06,
  };

  let totalScore = 0;
  let totalWeight = 0;
  for (const [key, result] of Object.entries(results)) {
    if (result.score !== null) {
      const w = weights[key] || 0.1;
      totalScore += result.score * w;
      totalWeight += w;
    }
  }

  return {
    scores: results,
    totalScore: totalWeight > 0 ? Math.round((totalScore / totalWeight) * 100) : null,
    confidence: calculateConfidence(results),
    scorableCount: Object.values(results).filter(r => r.score !== null).length,
    totalCriteria: 9,
  };
}

// ── 判据 #1: 垄断性/不可替代性 ──
function scoreMonopoly(stock, supplyChain) {
  if (!supplyChain) return { score: null, confidence: "low", detail: "[需人工] 供应链位置未确认" };

  const clues = {
    isBottleneck: supplyChain.bottleneck === true,
    hasLockedStocks: supplyChain.locked_stocks?.length > 0,
    tier: supplyChain.tier, // "成品" = weaker, "器件/芯片/材料" = stronger
  };

  let score = 0.5; // neutral baseline

  if (clues.isBottleneck) score += 0.2;
  if (clues.hasLockedStocks && supplyChain.locked_stocks.length <= 3) score += 0.15;
  if (["芯片", "器件", "衬底", "材料"].some(t => clues.tier?.includes(t))) score += 0.1;
  if (["成品", "组装", "代工"].some(t => clues.tier?.includes(t))) score -= 0.1;

  score = Math.max(0, Math.min(1, score));

  return {
    score: Math.round(score * 100) / 100,
    confidence: clues.isBottleneck ? "medium" : "low",
    detail: buildMoatDetail(clues),
    source: supplyChain._source || "supply-chain-map",
  };
}

function buildMoatDetail(clues) {
  const parts = [];
  if (clues.isBottleneck) parts.push("链上卡点位置");
  else parts.push("非卡点环节");
  if (clues.tier === "器件" || clues.tier === "芯片") parts.push("上游器件级(卡点更强)");
  else if (clues.tier === "成品") parts.push("成品级(卡点中等)");
  return parts.join("；");
}

// ── 判据 #2: 极小市值 vs 巨大下游 TAM ──
function scoreMcapVsTam(stock, financial, t) {
  const mcap = stock.mcapYi;

  if (!mcap) return { score: null, confidence: "low", detail: "[需人工] 市值数据缺失" };

  let score;
  if (mcap < 50) score = 1.0;
  else if (mcap < 100) score = 0.9;
  else if (mcap < 200) score = 0.7;
  else if (mcap < 500) score = 0.4;
  else if (mcap < 1000) score = 0.2;
  else score = 0.05;

  return {
    score: Math.round(score * 100) / 100,
    confidence: "high",
    detail: `市值 ${mcap} 亿${mcap > t.maxMcapYi ? ` (超出Sub-${t.maxMcapYi}亿门槛，10x空间基本关闭)` : mcap < 200 ? " (在Sub-$2B射程内)" : " (偏大)"}`,
    source: "tencent-quote",
  };
}

// ── 判据 #3: designed-in + 多客户 ──
function scoreDesignedIn(stock, supplyChain) {
  if (!supplyChain) return { score: null, confidence: "low", detail: "[需人工] 供应链位置未确认" };

  const multiClient = supplyChain.locked_stocks?.length <= 3; // supply is concentrated = toll booth
  const hasDesignWin = supplyChain.tier !== "成品" || supplyChain.bottleneck === true;

  let score = 0.5;
  if (multiClient) score += 0.2;
  if (hasDesignWin) score += 0.15;
  if (supplyChain.sub_layer?.includes("进入")) score += 0.15;

  score = Math.max(0, Math.min(1, score));

  return {
    score: Math.round(score * 100) / 100,
    confidence: "medium",
    detail: `${supplyChain.sub_layer || supplyChain.layer} | ${multiClient ? "寡头格局(toll booth特征)" : "竞争较分散"}`,
    source: "supply-chain-map",
    needsVerification: true,
  };
}

// ── 判据 #4: 认证周期未反映营收 ──
function scoreCertification(financial, supplyChain) {
  if (!financial) return { score: null, confidence: "low", detail: "[需人工] 无财务数据" };

  const rev = financial.revenue || 0;
  const revGrowth = financial.revenueCagr;
  const isCertifying = supplyChain?.sub_layer?.includes("认证") || supplyChain?.sub_layer?.includes("导入");

  let score = 0.5;
  let detail = "";

  if (isCertifying) {
    score += 0.3;
    detail = "处于认证/design-in阶段，量产在远期 → 当前财报必然难看 = 可能错杀";
  } else if (revGrowth && revGrowth > 0.5) {
    score += 0.2;
    detail = `营收增速 ${(revGrowth*100).toFixed(0)}%，已在放量中`;
  } else if (revGrowth && revGrowth > 0.2) {
    score += 0.1;
    detail = `营收增速 ${(revGrowth*100).toFixed(0)}%，早期放量`;
  } else {
    detail = "未发现认证周期-营收时间差证据";
  }

  score = Math.max(0, Math.min(1, score));

  return {
    score: Math.round(score * 100) / 100,
    confidence: "medium",
    detail,
    source: "financial-report",
    needsVerification: !isCertifying,
  };
}

// ── 判据 #5: 资产负债表能活到放量 ──
function scoreBalanceSheet(stock, financial) {
  if (!financial) return { score: null, confidence: "low", detail: "[需人工] 无财务数据" };

  const cash = financial.cash || 0;
  const debt = financial.totalDebt || 0;
  const netBurn = financial.netBurn || (financial.netProfit < 0 ? Math.abs(financial.netProfit) : 0);
  const mcap = stock.mcapYi || 0;

  // 现金跑道（年）
  const runway = netBurn > 0 ? cash / netBurn : Infinity;
  const debtRatio = financial.totalAssets > 0 ? debt / financial.totalAssets : 0;
  const cashToMcap = mcap > 0 ? cash / (mcap * 1e8) : 0; // cash in yuan, mcap in yi

  let score = 0.7;

  if (runway < 1) score -= 0.5;
  else if (runway < 2) score -= 0.3;
  else if (runway > 5) score += 0.15;

  if (debtRatio > 0.6) score -= 0.3;
  else if (debtRatio < 0.3) score += 0.1;

  if (cashToMcap > 0.5) score += 0.15; // 净现金≈市值 = 下行保护
  else if (cashToMcap > 0.3) score += 0.1;

  score = Math.max(0.1, Math.min(1, score));

  return {
    score: Math.round(score * 100) / 100,
    confidence: financial.confidence || "medium",
    detail: `现金跑道: ${runway === Infinity ? "盈利(无烧钱)" : runway.toFixed(1) + "年"} | 负债率: ${(debtRatio*100).toFixed(0)}% | 现金/市值: ${(cashToMcap*100).toFixed(0)}%`,
    source: "financial-report",
  };
}

// ── 判据 #6: 供需严重失衡 ──
function scoreSupplyDemand(financial, supplyChain) {
  const grossMargin = financial?.grossMargin;
  const orderBacklog = financial?.orderBacklog;
  const isBottleneck = supplyChain?.bottleneck === true;

  let score = 0.5;
  const clues = [];

  if (isBottleneck) { score += 0.2; clues.push("链上卡点位置"); }
  if (grossMargin && grossMargin > 0.5) { score += 0.15; clues.push(`毛利${(grossMargin*100).toFixed(0)}%(高毛利暗示供需失衡)`); }
  else if (grossMargin && grossMargin > 0.35) { score += 0.1; clues.push(`毛利${(grossMargin*100).toFixed(0)}%`); }
  if (orderBacklog && orderBacklog > 0) { score += 0.15; clues.push("有backlog"); }

  score = Math.max(0, Math.min(1, score));

  return {
    score: Math.round(score * 100) / 100,
    confidence: grossMargin ? "medium" : "low",
    detail: clues.length > 0 ? clues.join("；") : "[需人工] 供需数据不足",
    source: "financial-report",
  };
}

// ── 判据 #7: 政策/地缘护城河 ──
function scorePolicyMoat(stock, supplyChain) {
  let score = 0.5;
  const clues = [];

  // 国产替代线索
  if (supplyChain?.role?.includes("国产") || supplyChain?.sub_layer?.includes("国产")) {
    score += 0.25; clues.push("国产替代");
  }

  // 出口管制受益
  const exportControlled = ["芯片", "光刻", "设备", "EDA"].some(kw =>
    supplyChain?.layer?.includes(kw) || supplyChain?.sub_layer?.includes(kw)
  );
  if (exportControlled) { score += 0.15; clues.push("出口管制壁垒"); }

  // 军工/国安
  if (supplyChain?.role?.includes("军工") || supplyChain?.layer?.includes("军工")) {
    score += 0.1; clues.push("军工护城河");
  }

  score = Math.max(0.2, Math.min(1, score));

  return {
    score: Math.round(score * 100) / 100,
    confidence: "medium",
    detail: clues.length > 0 ? clues.join("；") : "无明显政策/地缘护城河",
    source: "supply-chain-map",
  };
}

// ── 判据 #8: 机构低配 + 下行保护 ──
function scoreInstitutional(stock, financial, t) {
  const mcap = stock.mcapYi || 0;
  const instHolding = financial?.institutionalHolding;

  if (mcap > 500) {
    return { score: 0.2, confidence: "high", detail: `市值${mcap}亿>500亿，机构低配判据失效（大盘天然机构重仓）`, source: "tencent-quote" };
  }

  if (instHolding === undefined || instHolding === null) {
    return { score: null, confidence: "low", detail: "[需人工] 机构持仓数据不可用", source: null };
  }

  let score;
  if (instHolding < 10) score = 1.0;
  else if (instHolding < 20) score = 0.8;
  else if (instHolding < 30) score = 0.6;
  else if (instHolding < 40) score = 0.4;
  else if (instHolding < 50) score = 0.2;
  else score = 0.05;

  return {
    score: Math.round(score * 100) / 100,
    confidence: "high",
    detail: `机构持股 ${instHolding}%${instHolding < t.maxInstitutionalPct ? " (低配，有上行空间)" : " (高配，上行空间有限)"}`,
    source: "financial-report",
  };
}

// ── 判据 #9: 估值安全边际 ──
function scoreValuationMargin(stock, financial, t) {
  const peTtm = stock.peTtm;
  const peg = financial?.peg;
  const fwdPE = financial?.fwdPE;

  if (!peTtm || peTtm <= 0) {
    return { score: null, confidence: "low", detail: "[需人工] PE无效(亏损股)", source: null };
  }

  let score;

  // 用前向PE优先
  const pe = fwdPE || peTtm;

  if (pe < 20) score = 0.95;
  else if (pe < 30) score = 0.8;
  else if (pe < 40) score = 0.65;
  else if (pe < 50) score = 0.5;
  else if (pe < 60) score = 0.35;
  else if (pe < 80) score = 0.2;
  else if (pe < 100) score = 0.1;
  else score = 0.05;

  // PEG调整
  if (peg !== undefined && peg !== null && peg > 0) {
    if (peg < 0.8) score = Math.min(1, score + 0.15);
    else if (peg < 1.0) score = Math.min(1, score + 0.1);
    else if (peg > 2.0) score = Math.max(0.05, score - 0.2);
    else if (peg > 1.5) score = Math.max(0.05, score - 0.1);
  }

  score = Math.max(0.05, Math.min(1, score));

  return {
    score: Math.round(score * 100) / 100,
    confidence: "high",
    detail: `PE(TTM): ${peTtm}${fwdPE ? ` / FwdPE: ${fwdPE}` : ""}${peg ? ` / PEG: ${peg}` : ""} | ${score >= 0.6 ? "有安全边际" : score >= 0.3 ? "估值合理偏贵" : "估值严重透支"}`,
    source: "tencent-quote",
  };
}

// ── 综合置信度 ──
function calculateConfidence(results) {
  const scored = Object.values(results).filter(r => r.score !== null);
  if (scored.length < 5) return "low";
  const highConf = scored.filter(r => r.confidence === "high").length;
  if (highConf >= 6) return "high";
  if (highConf >= 4) return "medium";
  return "low";
}
