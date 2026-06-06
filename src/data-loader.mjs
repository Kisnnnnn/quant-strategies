/**
 * 数据加载层 — 行情: 腾讯 tencentQuote，K线: 腾讯 K线（不封IP，a-stock-data推荐）
 * 缓存4小时保证同一天多次扫描结果一致
 */
import { CacheManager } from "./cache.mjs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STOCK_DATA = join(__dirname, "../../chaogu/stock-data.mjs");
const PROJECT = join(__dirname, "..");

let _m = null;
async function getMod() {
  if (!_m) _m = await import(STOCK_DATA);
  return _m;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const cache = new CacheManager();
const UA = "Mozilla/5.0";

export function buildCodePool({ boards } = {}) {
  const boardsSet = new Set(boards || ["sh", "sz", "cy", "kc"]);
  const codes = [];
  if (boardsSet.has("sh")) for (let i = 600000; i <= 605999; i++) codes.push(i.toString());
  if (boardsSet.has("sz")) for (let i = 1; i <= 3999; i++) codes.push(i.toString().padStart(6, "0"));
  if (boardsSet.has("cy")) for (let i = 300001; i <= 301999; i++) codes.push(i.toString());
  if (boardsSet.has("kc")) for (let i = 688001; i <= 689999; i++) codes.push(i.toString());
  return codes;
}

export async function fetchBatchQuotes(codes, { forceRefresh = false } = {}) {
  const CK = "batch_quotes_v5";
  if (!forceRefresh) {
    const cached = cache.get(CK, 3);
    if (cached?.codes?.length === codes.length && cached.modified) {
      return cached.data;
    }
  }

  const m = await getMod();
  const data = {};
  const QB = 60;
  for (let i = 0; i < codes.length; i += QB) {
    const batch = codes.slice(i, i + QB);
    try {
      const q = await m.tencentQuote(batch);
      if (q) Object.assign(data, q);
    } catch (e) { /* skip batch */ }
    if (i % 2400 === 0) process.stderr.write(".");
  }
  process.stderr.write("\n");

  cache.set(CK, { codes, data, modified: Date.now() });
  return data;
}

/**
 * 单只股票K线 — 腾讯K线API（不封IP）
 * 返回格式: [{date, open, close, high, low, volume}, ...]
 */
async function fetchTencentKLineRaw(code) {
  const prefix = code.startsWith("6") ? "sh" : "sz";
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${prefix}${code},day,,,80,qfq`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    const d = await r.json();
    const key = `${prefix}${code}`;
    const rows = d?.data?.[key]?.qfqday || d?.data?.[key]?.day || [];
    if (!rows.length) return null;

    return rows.map(row => ({
      date: row[0],
      open: +row[1],
      close: +row[2],
      high: +row[3],
      low: +row[4],
      volume: +row[5] || 0,
    }));
  } catch (e) {
    return null;
  }
}

/**
 * 批量获取K线 — 腾讯HTTP，并发批量（腾讯不封IP）
 * 返回: { code: { rows: [...] } }
 * MA由 indicators.mjs 本地计算
 */
export async function fetchBatchKLines(codes, { forceRefresh = false, concurrency = 50 } = {}) {
  const CK = "batch_klines_tencent";
  if (!forceRefresh) {
    const cached = cache.get(CK, 4);
    if (cached?.data) {
      const cachedSet = new Set(cached.codes);
      const allCached = codes.every(c => cachedSet.has(c));
      if (allCached) {
        process.stderr.write("  K线缓存命中\n");
        const filtered = {};
        codes.forEach(c => { if (cached.data[c]) filtered[c] = cached.data[c]; });
        return filtered;
      }
    }
  }

  const result = {};
  let done = 0, ok = 0;

  // 并发批量拉取
  for (let i = 0; i < codes.length; i += concurrency) {
    const batch = codes.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async code => {
        const rows = await fetchTencentKLineRaw(code);
        return { code, rows };
      })
    );
    for (const { code, rows } of batchResults) {
      if (rows && rows.length >= 40) {
        result[code] = { rows };
        ok++;
      }
      done++;
    }
    if (done % 300 === 0 || (done >= codes.length && done > 0)) process.stderr.write(`.${done}`);
    if (i + concurrency < codes.length) await delay(20);
  }
  process.stderr.write("\n");

  process.stderr.write(`  K线: ${ok}/${codes.length} 有效\n`);

  const allCodes = codes.slice();
  cache.set(CK, { codes: allCodes, data: result, modified: Date.now() });
  return result;
}

export async function fetchMarketBreadth() {
  const m = await getMod();
  return m.getMarketBreadth();
}
