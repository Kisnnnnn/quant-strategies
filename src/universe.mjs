/**
 * 股票池过滤 — 对标 xbb1994 项目的 universe.py
 * 根据基础条件过滤全市场代码，生成可交易股票池
 */

/**
 * 从行情数据过滤活跃股票池
 * @param {Object} quotes - tencentQuote 返回的行情字典
 * @param {Object} cfg - universe 配置
 * @returns {Object[]} 过滤后的股票列表
 */
export function buildUniverse(quotes, cfg = {}) {
  const {
    excludeST = true,
    minTurnover = 1.5,
    minPrice = 4,
    minMcap = 20,
    maxPE = 0,
    excludeLoss = false,
  } = cfg;

  const pool = [];

  Object.entries(quotes).forEach(([code, d]) => {
    if (!d?.name) return;

    // 排除ST
    if (excludeST && (d.name.includes("ST") || d.name.includes("*ST"))) return;

    // 换手率过滤
    if (d.turnoverPct < minTurnover) return;

    // 股价过滤
    if (d.price < minPrice) return;

    // 市值过滤（亿）
    if (d.mcapYi < minMcap) return;

    // PE过滤
    if (maxPE > 0 && d.peTtm > maxPE) return;
    // 排除亏损股
    if (excludeLoss && d.peTtm <= 0) return;

    pool.push({
      code, name: d.name,
      price: d.price, changePct: d.changePct,
      turnoverPct: d.turnoverPct, volRatio: d.volRatio,
      peTtm: d.peTtm, pb: d.pb,
      mcapYi: d.mcapYi, amplitudePct: d.amplitudePct,
    });
  });

  return pool;
}

/**
 * 对大股票池进行K线后过滤，生成最终可交易股票池
 * (用于龙回头等需要额外过滤的策略)
 */
export function filterByKLine(pool, minKLineBars = 40) {
  // 这个过滤在K线扫描时自然完成，此处预留扩展
  return pool;
}
