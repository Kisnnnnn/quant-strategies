/**
 * Serenity 红旗扫描引擎
 *
 * 对"命中即降级/否决"的红旗进行自动化检测。
 * 硬否决返回 rejected=true，警告类返回 warnings 列表。
 */

/**
 * @param {Object} stock - 行情数据
 * @param {Object} financial - 财务数据
 * @param {Object} supplyChain - 供应链位置
 * @returns {Object} { rejected: bool, hardRejects: [...], warnings: [...], riskLevel: "low"|"medium"|"high"|"rejected" }
 */
export function scanRedFlags(stock, financial, supplyChain, config = {}) {
  const hardRejects = [];
  const warnings = [];

  // ── 硬否决 ──

  // ST股
  if (stock.name?.includes("ST") || stock.name?.includes("*ST")) {
    hardRejects.push({ flag: "ST", detail: `${stock.name} 是ST股，直接排除`, level: "hard" });
    return buildResult(true, hardRejects, warnings);
  }

  // 无限ATM增发稀释 (从股东户数异常增加检测)
  if (financial?.shareCountCagr && financial.shareCountCagr > 0.5) {
    hardRejects.push({
      flag: "unlimited_atm",
      detail: `股本年增 ${(financial.shareCountCagr * 100).toFixed(0)}%，疑似无限ATM增发`,
      level: "hard",
    });
  }

  // ── 警告类红旗 ──

  // 单一客户集中
  if (financial?.customerConcentration) {
    const top1 = financial.customerConcentration.top1;
    if (top1 > 60) warnings.push({ flag: "single_customer", detail: `第一大客户占比${top1}%（>60%极度集中）`, level: "critical" });
    else if (top1 > 40) warnings.push({ flag: "single_customer", detail: `第一大客户占比${top1}%（>40%偏高）`, level: "warning" });
  }

  // 零收入纯炒作
  if (financial?.revenue !== undefined && financial.revenue <= 0) {
    warnings.push({ flag: "zero_revenue", detail: "公司零收入，纯概念炒作", level: "critical" });
  }

  // 技术太远(2028+)
  if (supplyChain?.sub_layer?.includes("2028") || supplyChain?.description?.includes("2028")) {
    warnings.push({ flag: "tech_too_far", detail: "技术量产时间线在2028+，商业化太远", level: "warning" });
  }

  // 大市值无不对称
  if (stock.mcapYi > 2000) {
    warnings.push({ flag: "large_mcap_no_asymmetry", detail: `市值${stock.mcapYi}亿远超Sub-$2B，10x不对称已关闭`, level: "warning" });
  }

  // 纯软件无硬卡点
  if (supplyChain?.role?.includes("软件") && !supplyChain?.bottleneck) {
    warnings.push({ flag: "pure_software", detail: "纯软件无硬件卡点壁垒", level: "warning" });
  }

  // A股特色：蹭热点
  if (supplyChain?.tier === "成品" && supplyChain?.bottleneck === false && stock.mcapYi < 50) {
    warnings.push({ flag: "hot_money_only", detail: "成品层非卡点小市值：疑似蹭概念炒作", level: "warning" });
  }

  // A股特色：无机构关注（流动性陷阱）
  if (stock.turnoverPct && stock.turnoverPct < 1 && stock.mcapYi < 50) {
    warnings.push({ flag: "no_institutional_attention", detail: `换手率${stock.turnoverPct}%（<1%）+ 小市值 = 无流动性`, level: "warning" });
  }

  // 管理层诚信红旗（从数据异常推断）
  if (financial?.hasAuditorChange) {
    warnings.push({ flag: "management_integrity", detail: "审计师更换 — 需人工核实原因", level: "critical" });
  }

  // 技术路线变更风险
  if (supplyChain?.sub_layer?.includes("InP") || supplyChain?.description?.includes("InP")) {
    warnings.push({
      flag: "tech_route_risk",
      detail: "依赖InP衬底路线，硅光替代风险存在",
      level: "warning",
    });
  }

  // 利润亏损+高PE(亏损股)
  if (stock.peTtm > 300 || stock.peTtm <= 0) {
    warnings.push({ flag: "valuation_extreme", detail: `PE=${stock.peTtm}（极端估值/亏损），偏离基本面`, level: "warning" });
  }

  // 确定风险等级
  let riskLevel = "low";
  const criticals = warnings.filter(w => w.level === "critical");
  const warnLevel = warnings.filter(w => w.level === "warning");

  if (hardRejects.length > 0) riskLevel = "rejected";
  else if (criticals.length >= 2) riskLevel = "high";
  else if (criticals.length >= 1 || warnLevel.length >= 3) riskLevel = "medium";

  return buildResult(false, hardRejects, warnings, riskLevel);
}

function buildResult(rejected, hardRejects, warnings, riskLevel = null) {
  if (!riskLevel) {
    riskLevel = rejected ? "rejected" : "low";
  }

  return {
    rejected,
    riskLevel,
    hardRejects,
    warnings,
    totalFlags: hardRejects.length + warnings.length,
    summary: rejected
      ? `硬否决: ${hardRejects.map(r => r.flag).join(", ")}`
      : warnings.length > 0
        ? `${warnings.length}条警告 (critical: ${warnings.filter(w => w.level === "critical").length})`
        : "无明显红旗",
  };
}
