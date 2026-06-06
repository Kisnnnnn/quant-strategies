/**
 * 报告生成器 — 对标 xbb1994 项目的 report.py
 * 输出 Markdown 报告 + JSON 数据
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { ensureOutputDir } from "./pipeline.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, "..");

export function generateMarkdownReport(strategyName, results, meta = {}) {
  const now = new Date().toLocaleString("zh-CN", { hour12: false });
  const ts = new Date().toISOString().slice(0, 10);
  const outDir = ensureOutputDir();

  let md = `# ${meta.displayName || strategyName} 选股报告\n\n`;
  md += `> 生成时间: ${now}\n`;
  md += `> 信号总数: ${results.length}\n`;
  if (meta.breadth) {
    md += `> 市场情绪: ${meta.breadth.sentiment} (涨跌比 ${meta.breadth.advDecRatio})\n`;
  }
  md += `\n---\n\n`;

  if (results.length === 0) {
    md += `**今日无符合条件标的。** 弱势市场下这是正常现象，不要强行交易。\n\n`;
  } else {
    md += `| # | 代码 | 名称 | 评分 | 现价 | 趋势 | 核心信号 |\n`;
    md += `|---|------|------|------|------|------|----------|\n`;

    results.forEach((r, i) => {
      const name = r.name || "";
      const signal = r.signals || r.firstWave || "";
      md += `| ${i + 1} | ${r.code} | ${name} | ${r.score} | ${r.price} | ${r.trend || ""} | ${signal} |\n`;
    });

    md += `\n## 详细数据\n\n`;

    results.forEach((r, i) => {
      md += `### ${i + 1}. ${r.code} ${r.name || ""} — ${r.score}分\n\n`;
      const fields = { ...r };
      delete fields.code;
      delete fields.name;
      delete fields.score;
      md += "```\n" + JSON.stringify(fields, null, 2) + "\n```\n\n";
    });
  }

  md += `\n---\n`;
  md += `> ⚠️ 以上结果仅供参考验证，不构成投资建议。\n`;

  const outFile = join(outDir, `${strategyName}-${ts}.md`);
  writeFileSync(outFile, md, "utf-8");
  console.log(`报告已保存: ${outFile}`);
  return outFile;
}
