/**
 * Serenity 投研报告生成器
 *
 * 生成结构化JSON报告 + Markdown摘要。
 * 遵循输出契约：risk/bear先写，bull后写，强制输出证伪门。
 */

/**
 * @param {Object} result - pipeline分析结果
 * @returns {Object} { json: {...}, markdown: "..." }
 */
export function generateReport(result) {
  const { analyzedStocks, sectorSummary, marketContext, supplyChain } = result;
  const now = new Date().toISOString().slice(0, 10);

  // 按综合得分排序
  const ranked = [...analyzedStocks].sort((a, b) =>
    (b.criteriaResult?.totalScore || 0) - (a.criteriaResult?.totalScore || 0)
  );

  const jsonReport = {
    meta: {
      generatedAt: now,
      framework: "Serenity v3.0 供应链卡点投资",
      disclaimer: "不是投资建议。仅供学习研究方法。",
      dataQuality: assessDataQuality(analyzedStocks),
    },
    sectorSummary: sectorSummary || buildSectorSummary(ranked),
    rankings: ranked.map(stockToSummary),
    detailed: ranked.map(stockToDetail),
    marketContext,
    supplyChain,
  };

  const mdReport = buildMarkdown(jsonReport);
  return { json: jsonReport, markdown: mdReport };
}

function assessDataQuality(stocks) {
  const total = stocks.length;
  const withFinance = stocks.filter(s => s.financial?.revenue > 0).length;
  const withPE = stocks.filter(s => s.stock.peTtm > 0).length;

  if (withFinance < total * 0.5) return "low — 多数标的无财务数据，评分置信度低";
  if (withPE < total * 0.8) return "medium — 部分标的无PE数据";
  return "high";
}

function stockToSummary(stock, idx) {
  const c = stock.criteriaResult;
  const r = stock.redFlagResult;
  return {
    rank: idx + 1,
    code: stock.code,
    name: stock.name,
    price: stock.stock.price,
    peTtm: stock.stock.peTtm,
    mcapYi: stock.stock.mcapYi,
    score: c?.totalScore || 0,
    scoredCount: c?.scorableCount || 0,
    riskLevel: r?.riskLevel || "unknown",
    bottleneckLayer: stock.supplyChain?.layer || "",
    verdict: getVerdict(stock),
  };
}

function stockToDetail(stock) {
  const c = stock.criteriaResult;
  const r = stock.redFlagResult;
  const scores = c?.scores || {};

  return {
    code: stock.code,
    name: stock.name,
    supplyChainPosition: stock.supplyChain,
    marketData: {
      price: stock.stock.price,
      changePct: stock.stock.changePct,
      peTtm: stock.stock.peTtm,
      pb: stock.stock.pb,
      mcapYi: stock.stock.mcapYi,
      turnoverPct: stock.stock.turnoverPct,
    },
    financial: stock.financial ? {
      revenue: stock.financial.revenue,
      netProfit: stock.financial.netProfit,
      grossMargin: stock.financial.grossMargin,
      cash: stock.financial.cash,
      totalDebt: stock.financial.totalDebt,
    } : null,
    criteriaBreakdown: Object.entries(scores).map(([id, s]) => ({
      id,
      score: s.score,
      confidence: s.confidence,
      detail: s.detail,
      needsVerification: s.needsVerification || false,
    })),
    totalScore: c?.totalScore,
    confidence: c?.confidence,
    redFlags: r ? {
      riskLevel: r.riskLevel,
      warnings: r.warnings,
      hardRejects: r.hardRejects,
      summary: r.summary,
    } : null,
    verdict: getVerdict(stock),
    falsificationGate: getFalsificationGate(stock),
  };
}

function getVerdict(stock) {
  const score = stock.criteriaResult?.totalScore || 0;
  const risk = stock.redFlagResult?.riskLevel;
  const mcap = stock.stock.mcapYi || 0;

  if (risk === "rejected") return { level: "排除", action: "硬否决，不入池" };
  if (mcap > 500) return { level: "框架判断力弱", action: "卡点真伪可定性，不给买点（市值过大）" };
  if (score >= 70) return { level: "强烈关注", action: "卡点多条命中，值得深入调研" };
  if (score >= 50) return { level: "关注", action: "卡点特征明显，但需估值/催化剂配合" };
  if (score >= 30) return { level: "观察", action: "部分卡点特征，等待更多证据" };
  return { level: "弱", action: "卡点特征不明显，入选概率低" };
}

function getFalsificationGate(stock) {
  const layer = stock.supplyChain?.layer || "";
  const gates = [];

  if (layer.includes("光模块") || layer.includes("光芯片")) {
    gates.push("1.6T光模块量产推迟到2028+");
    gates.push("硅光技术替代InP/传统光模块");
    gates.push("NV/Google大幅削减capex");
  } else if (layer.includes("PCB")) {
    gates.push("AI服务器PCB需求低于预期");
    gates.push("新竞争者进入打破寡头格局");
  } else if (layer.includes("减速器") || layer.includes("机器人")) {
    gates.push("特斯拉Optimus量产时间推迟2年+");
    gates.push("哈默纳科大幅降价挤压国产份额");
  } else if (layer.includes("液冷") || layer.includes("散热")) {
    gates.push("液冷渗透率提升慢于预期");
    gates.push("风冷性价比优势延续");
  } else {
    gates.push("下游资本开支大幅削减");
    gates.push("技术路线被替代");
  }

  return gates;
}

function buildSectorSummary(ranked) {
  const byLayer = {};
  for (const s of ranked) {
    const layer = s.supplyChain?.layer || "未分类";
    if (!byLayer[layer]) byLayer[layer] = [];
    byLayer[layer].push(s);
  }

  return Object.entries(byLayer).map(([layer, stocks]) => ({
    layer,
    count: stocks.length,
    avgScore: Math.round(stocks.reduce((sum, s) => sum + (s.criteriaResult?.totalScore || 0), 0) / stocks.length),
    best: stocks[0] ? `${stocks[0].code} ${stocks[0].name}(${stocks[0].criteriaResult?.totalScore || 0}分)` : null,
  }));
}

// ── Markdown 报告生成 ──
function buildMarkdown(report) {
  const lines = [];

  lines.push(`# Serenity 供应链卡点分析报告`);
  lines.push(`> 生成时间: ${report.meta.generatedAt}`);
  lines.push(`> 不是投资建议。仅供学习研究方法。`);
  lines.push(``);

  // 市场背景
  if (report.marketContext) {
    lines.push(`## 市场背景`);
    lines.push(`- 情绪: ${report.marketContext.sentiment || "N/A"}`);
    lines.push(`- 涨跌比: ${report.marketContext.advDecRatio || "N/A"}`);
    if (report.marketContext.northbound) {
      lines.push(`- 北向资金: ${report.marketContext.northbound.total}亿`);
    }
    lines.push(``);
  }

  // 赛道汇总
  if (report.sectorSummary?.length) {
    lines.push(`## 赛道扫描汇总`);
    lines.push(``);
    lines.push(`| 环节 | 标的数 | 均分 | 最佳标的 |`);
    lines.push(`|------|--------|------|----------|`);
    for (const s of report.sectorSummary) {
      lines.push(`| ${s.layer} | ${s.count} | ${s.avgScore} | ${s.best || "-"} |`);
    }
    lines.push(``);
  }

  // 排名
  lines.push(`## 卡点评分排名`);
  lines.push(``);
  for (const r of report.rankings) {
    const icon = r.riskLevel === "rejected" ? "🚫" : r.score >= 70 ? "⭐" : r.score >= 50 ? "★" : "  ";
    lines.push(`### ${r.rank}. ${icon} ${r.code} ${r.name} — ${r.score}分`);
    lines.push(``);
    lines.push(`| 指标 | 值 |`);
    lines.push(`|------|----|`);
    lines.push(`| 价格 | ¥${r.price} |`);
    lines.push(`| PE(TTM) | ${r.peTtm || "-"} |`);
    lines.push(`| 市值 | ${r.mcapYi}亿 |`);
    lines.push(`| 卡点层级 | ${r.bottleneckLayer} |`);
    lines.push(`| 风险等级 | ${r.riskLevel} |`);
    lines.push(`| 判定 | ${r.verdict?.level || "-"}: ${r.verdict?.action || "-"} |`);
    lines.push(``);
  }

  // 证伪门
  lines.push(`## 证伪门`);
  lines.push(``);
  for (const d of report.detailed) {
    if (d.falsificationGate?.length) {
      lines.push(`### ${d.code} ${d.name}`);
      for (const gate of d.falsificationGate) {
        lines.push(`- ❌ ${gate}`);
      }
      lines.push(``);
    }
  }

  // 免责
  lines.push(`---`);
  lines.push(`*不是投资建议。本报告基于公开数据和Serenity供应链卡点分析方法论自动生成，仅供研究参考。*`);
  lines.push(`*数据质量评级: ${report.meta.dataQuality}*`);

  return lines.join("\n");
}
