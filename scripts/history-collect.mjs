/**
 * 历史快照收集器 — 跑一次扫描，产出归档到 history/ 目录
 * 用法: node scripts/history-collect.mjs
 * 也可 cron 定时：0 16 * * 1-5 cd /path/celue && node scripts/history-collect.mjs
 */
import { existsSync, mkdirSync, copyFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, "..");
const SCAN = join(__dirname, "short-term-scan.mjs");
const HISTORY = join(PROJECT, "history");

if (!existsSync(HISTORY)) mkdirSync(HISTORY, { recursive: true });

const now = new Date().toLocaleString("zh-CN", { hour12: false });
console.log(`[${now}] 收集历史快照...`);

// 运行扫描
execFile("node", [SCAN], { timeout: 300000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
  if (err) {
    console.error("扫描失败:", err.message);
    process.exit(1);
  }
  process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  // 归档：从 outputs/ 复制到 history/
  const today = new Date().toISOString().slice(0, 10);
  const src = join(PROJECT, "outputs", `short-term-${today}.json`);
  const dst = join(HISTORY, `${today}.json`);

  if (existsSync(src)) {
    copyFileSync(src, dst);
    console.log(`[ok] 快照已归档: history/${today}.json`);

    // 统计
    const data = JSON.parse(readFileSync(dst, "utf-8"));
    console.log(`  阶段: ${data.emotion?.phaseLabel || "?"} | 龙头: ${(data.emotion?.leaders || []).map(l => l.name).join(", ") || "无"}`);
    console.log(`  候选: ${data.total}只 | 买入${data.results.filter(r => r.action === "买入").length} 加仓${data.results.filter(r => r.action === "加仓").length}`);
  } else {
    console.error("[!] 扫描完成但源文件不存在:", src);
  }

  // 统计已有快照
  const files = require("fs").readdirSync(HISTORY).filter(f => f.endsWith(".json")).sort();
  console.log(`\n历史快照总数: ${files.length}天`);
  if (files.length > 0) {
    console.log(`  范围: ${files[0].replace(".json", "")} ~ ${files[files.length - 1].replace(".json", "")}`);
  }
});
