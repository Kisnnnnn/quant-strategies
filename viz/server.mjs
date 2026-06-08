/**
 * 可视化报告服务器 — 读取 outputs/ 下最新JSON，提供API + 静态文件
 * 用法: node viz/server.mjs
 * 访问: http://localhost:3456
 */
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { createServer } from "http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, "..");
const OUT = join(PROJECT, "outputs");
const STATIC = __dirname;

const STOCK_DATA = join(PROJECT, "../chaogu/stock-data.mjs");

const MIME = {
  ".html": "text/html;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".js": "application/javascript;charset=utf-8",
  ".json": "application/json;charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// ── K-line cache (in-memory, 4h TTL) ────────────────────
const klineCache = new Map();

function sma(arr, window) {
  if (arr.length < window) return null;
  let sum = 0;
  for (let i = arr.length - window; i < arr.length; i++) sum += arr[i];
  return sum / window;
}

async function fetchKLine(code) {
  const cacheKey = code;
  const cached = klineCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 4 * 3600_000) return cached.data;

  const prefix = code.startsWith("6") ? "sh" : "sz";
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${prefix}${code},day,,,80,qfq`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const d = await r.json();
    const key = `${prefix}${code}`;
    const rows = d?.data?.[key]?.qfqday || d?.data?.[key]?.day || [];
    if (!rows.length) return null;

    const data = rows.map(row => ({
      date: row[0],
      open: +row[1],
      close: +row[2],
      high: +row[3],
      low: +row[4],
      volume: +(row[5] || 0),
    }));

    // Compute MAs
    const closes = data.map(r => r.close);
    for (let i = 0; i < data.length; i++) {
      if (i >= 4) {
        let s = 0;
        for (let j = i - 4; j <= i; j++) s += closes[j];
        data[i].ma5 = +(s / 5).toFixed(2);
      }
      if (i >= 9) {
        let s = 0;
        for (let j = i - 9; j <= i; j++) s += closes[j];
        data[i].ma10 = +(s / 10).toFixed(2);
      }
      if (i >= 19) {
        let s = 0;
        for (let j = i - 19; j <= i; j++) s += closes[j];
        data[i].ma20 = +(s / 20).toFixed(2);
      }
    }

    klineCache.set(cacheKey, { data, ts: Date.now() });
    return data;
  } catch {
    return null;
  }
}

function loadLatestData() {
  const files = readdirSync(OUT).filter(f => f.endsWith(".json") && f !== "report.html" && f !== "portfolio.json");
  const latest = {};
  for (const f of files) {
    const name = f.replace(/-\d{4}-\d{2}-\d{2}\.json$/, "");
    if (!latest[name] || f > latest[name].file) {
      latest[name] = { file: f, path: join(OUT, f) };
    }
  }
  const data = {};
  for (const [name, { path }] of Object.entries(latest)) {
    try {
      data[name] = JSON.parse(readFileSync(path, "utf-8"));
    } catch { /* skip corrupt */ }
  }
  return data;
}

function parsePathQuery(rawUrl) {
  const [path, qs] = rawUrl.split("?", 2);
  return { pathname: (path || "/").split("#")[0], searchParams: new URLSearchParams(qs || "") };
}

const server = createServer(async (req, res) => {
  const { pathname, searchParams } = parsePathQuery(req.url);

  // API: /api/search?q=keyword
  if (pathname === "/api/search") {
    const q = searchParams.get("q") || "";
    if (!q || q.length < 1) {
      res.writeHead(200, { "Content-Type": "application/json;charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end("[]");
      return;
    }
    try {
      const m = await import(STOCK_DATA);
      const data = await m.searchStock(q);
      res.writeHead(200, { "Content-Type": "application/json;charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json;charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end("[]");
    }
    return;
  }

  // API: /api/kline/:code
  const klineMatch = pathname.match(/^\/api\/kline\/(\d{6})$/);
  if (klineMatch) {
    const code = klineMatch[1];
    const data = await fetchKLine(code);
    res.writeHead(200, { "Content-Type": "application/json;charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(data ? { code, count: data.length, data } : { code, error: "no data" }));
    return;
  }

  // API: /api/portfolio
  const PF = join(OUT, "portfolio.json");
  if (pathname === "/api/portfolio") {
    const sendJSON = (d, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json;charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(d));
    };
    if (req.method === "GET") {
      try { sendJSON(JSON.parse(readFileSync(PF, "utf-8"))); } catch { sendJSON([]); }
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        try {
          const { action, code, name } = JSON.parse(body);
          let list = JSON.parse(readFileSync(PF, "utf-8"));
          if (action === "add" && code && !list.find(h => h.code === code)) {
            list.push({ code, name: name || code });
          } else if (action === "remove" && code) {
            list = list.filter(h => h.code !== code);
          } else if (action === "update" && code) {
            const idx = list.findIndex(h => h.code === code);
            if (idx >= 0 && name) list[idx].name = name;
          }
          writeFileSync(PF, JSON.stringify(list, null, 2), "utf-8");
          sendJSON(list);
        } catch (e) { sendJSON({ error: e.message }, 500); }
      });
      return;
    }
    sendJSON({ error: "Method Not Allowed" }, 405);
    return;
  }

  // API: /api/run-review (后台触发生成)
  if (pathname === "/api/run-review") {
    const script = join(PROJECT, "scripts", "05-review.mjs");
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true, msg: "started" }));
    exec(`node "${script}"`, { cwd: PROJECT }, (err, stdout, stderr) => {
      if (err) console.error("review gen error:", err.message);
    });
    return;
  }

  // API: /api/review
  if (pathname === "/api/review") {
    const files = readdirSync(OUT).filter(f => f.startsWith("review-") && f.endsWith(".json"));
    if (!files.length) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no review data" }));
      return;
    }
    const latest = files.sort().pop();
    const data = JSON.parse(readFileSync(join(OUT, latest), "utf-8"));
    res.writeHead(200, { "Content-Type": "application/json;charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(data));
    return;
  }

  // API: /api/run-short-scan (后台触发短线扫描)
  if (pathname === "/api/run-short-scan") {
    const script = join(PROJECT, "scripts", "short-term-scan.mjs");
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true, msg: "started" }));
    exec(`node "${script}"`, { cwd: PROJECT }, (err, stdout, stderr) => {
      if (err) console.error("short-term scan error:", err.message);
    });
    return;
  }

  // API: /api/run-strategies
  if (pathname === "/api/run-strategies") {
    const bandScript = join(PROJECT, "scripts", "02-run-band.sh");
    const dragonScript = join(PROJECT, "scripts", "03-run-dragon.sh");
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true, msg: "strategies started" }));
    exec(`bash "${bandScript}"`, { cwd: PROJECT }, (err, stdout, stderr) => {
      if (err) console.error("band-dip error:", err.message);
      else console.log("band-dip done");
    });
    exec(`bash "${dragonScript}"`, { cwd: PROJECT }, (err, stdout, stderr) => {
      if (err) console.error("dragon-reverse error:", err.message);
      else console.log("dragon-reverse done");
    });
    return;
  }

  // API: /api/short-term
  if (pathname === "/api/short-term") {
    const files = readdirSync(OUT).filter(f => f.startsWith("short-term-") && f.endsWith(".json"));
    if (!files.length) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no short-term data" }));
      return;
    }
    const latest = files.sort().pop();
    const data = JSON.parse(readFileSync(join(OUT, latest), "utf-8"));
    res.writeHead(200, { "Content-Type": "application/json;charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(data));
    return;
  }

  // API: /api/data
  if (pathname === "/api/data") {
    const data = loadLatestData();
    res.writeHead(200, { "Content-Type": "application/json;charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(data));
    return;
  }

  // Static files
  let filePath = join(STATIC, pathname === "/" ? "index.html" : pathname === "/review" ? "review.html" : pathname);
  try {
    const content = readFileSync(filePath);
    const ext = extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found");
  }
});

const PORT = 3456;
server.listen(PORT, () => {
  console.log(`可视化报告: http://localhost:${PORT}`);
  console.log(`数据目录: ${OUT}`);
  console.log(`按 Ctrl+C 停止`);
});
