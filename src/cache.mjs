/**
 * 缓存管理器 — 避免重复拉取行情数据，复用历史结果
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, "..");

export class CacheManager {
  constructor(cacheDir = join(PROJECT, "data/cache")) {
    this.dir = cacheDir;
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  }

  _key(name) {
    return join(this.dir, `${name}.json`);
  }

  get(name, maxAgeHours = 6) {
    const p = this._key(name);
    if (!existsSync(p)) return null;
    try {
      const age = (Date.now() - statSync(p).mtimeMs) / 3600000;
      if (age > maxAgeHours) return null;
      return JSON.parse(readFileSync(p, "utf-8"));
    } catch {
      return null;
    }
  }

  set(name, data) {
    writeFileSync(this._key(name), JSON.stringify(data, null, 2), "utf-8");
  }

  clear(name) {
    const p = this._key(name);
    if (existsSync(p)) {
      try { require("fs").unlinkSync(p); } catch {}
    }
  }
}
