# quant-strategies

A股量化策略选股工具 — 基于多源行情数据的多因子打分选股系统，覆盖波段回调、龙回头、短线信号三个维度的策略选股。

## 功能概览

| 模块 | 说明 |
|------|------|
| **波段回调策略** | 趋势多头个股缩量回踩20日均线，企稳反弹信号捕捉 |
| **龙回头策略** | 龙头股首波大涨后缩量回调，二次启动信号识别 |
| **短线信号扫描** | 基于情绪周期（六位顶级游资方法论），全市场强势股量化评分 |
| **可视化报告** | Web 交互式看板，含K线图、板块分布、龙虎榜穿透 |
| **持仓复盘** | 个人持仓日度分析，席位资金结构穿透 + 研报跟踪 |
| **管线编排** | 代码池 → 行情拉取 → 指标计算 → 信号生成 → 信息增强 → 输出 |

## 前置依赖

### 1. Node.js ≥ 18

```bash
node -v
```

### 2. stock-data.mjs（A股数据工具包）

本项目依赖 [chaogu-stock-data](https://github.com/Kisnnnnn/chaogu-stock-data)（`chaogu` 目录）提供底层数据获取能力，涵盖：

- **行情**: 腾讯行情（批量）、百度K线
- **选股增强**: 东财概念板块、龙虎榜、个股新闻、同花顺热点
- **资金面**: 个股资金流120日、融资融券
- **市场情绪**: 涨跌家数、北向资金实时、涨停板、跌停板
- **研报**: 东财个股研报

**目录结构要求**：

```
workspace/
├── quant-strategies/   # 本项目
│   ├── src/
│   ├── scripts/
│   └── ...
└── chaogu/             # stock-data.mjs 所在目录
    └── stock-data.mjs
```

如果 `chaogu` 在不同路径，修改各 `.mjs` 文件中的 `STOCK_DATA` 变量：

```js
const STOCK_DATA = join(__dirname, "../../chaogu/stock-data.mjs");
```

## 安装

```bash
cd quant-strategies

# 初始化（检查依赖、创建目录）
bash scripts/01-init.sh
```

## 项目结构

```
quant-strategies/
├── config/
│   ├── default.json              # 全局配置（数据源、股票池、输出）
│   └── strategies/
│       ├── band-dip.json         # 波段回调策略参数
│       └── dragon-reverse.json   # 龙回头策略参数
├── src/
│   ├── pipeline.mjs              # 策略管线编排器（核心）
│   ├── data-loader.mjs           # 数据加载层（行情+K线+缓存）
│   ├── indicators.mjs            # 技术指标计算（MA/布林/K线形态）
│   ├── universe.mjs              # 股票池过滤
│   ├── signals-band.mjs          # 波段回调信号生成
│   ├── signals-dragon.mjs        # 龙回头信号生成
│   ├── cache.mjs                 # 磁盘缓存管理器
│   └── report.mjs                # Markdown 报告生成
├── scripts/
│   ├── 01-init.sh                # 环境初始化
│   ├── 02-run-band.sh            # 运行波段回调策略
│   ├── 03-run-dragon.sh          # 运行龙回头策略
│   ├── 04-run-all.sh             # 一键执行全部策略
│   ├── 05-review.mjs             # 持仓复盘分析
│   ├── short-term-scan.mjs       # 短线信号扫描
│   └── generate-viz.mjs          # 生成静态HTML报告
├── viz/
│   ├── server.mjs                # 可视化Web服务器
│   ├── index.html                # 策略扫描看板
│   ├── review.html               # 持仓复盘看板
│   ├── js/app.js                 # 主看板交互逻辑
│   ├── js/review.js              # 复盘看板交互逻辑
│   └── css/                      # 样式文件
├── data/cache/                   # 行情缓存目录（不入库）
├── outputs/                      # 结果输出目录（不入库）
├── band-dip.mjs                  # 波段回调独立脚本（轻量版）
└── dragon-reverse.mjs            # 龙回头独立脚本（轻量版）
```

## 策略详解

### 1. 波段回调选股（band-dip）

捕捉趋势多头个股回调至20日均线附近的企稳信号。

**核心逻辑**：
1. **趋势确认**：收盘站上MA20，20日线走平或上行，排除弱势股
2. **回踩到位**：股价与MA20的距离在 ±5% 以内
3. **假信号排除**：放量大阴线直接剔除；板块逆势过滤
4. **信号验证**：缩量止跌、锤子线/十字星K线形态、均线多头排列

**动态权重（按市场情绪自适应）**：
- 趋势市：趋势质量权重 35%（顺势而为）
- 震荡市：贴线距离权重 30% + 缩量权重 25%
- 弱势市：缩量权重 30% + 贴线距离权重 30%（保守）

**打分维度**：趋势质量、均线偏离度、量能状态、价格形态、流动性

**典型用法**：
```bash
bash scripts/02-run-band.sh
```

### 2. 龙回头选股（dragon-reverse）

识别龙头股大涨后缩量回调，捕捉第二波启动信号。

**核心逻辑**：
1. **龙性识别**：首波涨幅 ≥25%，至少1次涨停，波段高点接近60日最高价
2. **回调确认**：回调幅度 8%~35%，回调时间 2~15天，缩量至峰值60%以下
3. **企稳信号**：锤子线止跌、连续不创新低、放量突破回调趋势
4. **催化剂验证**：机构龙虎榜净买入加分、净卖出扣分

**打分维度**：首波强度、强势日数、缩量程度、回调质量、企稳确认

**量化时代提示**：龙回头策略在量化程序化交易环境下胜率有所下降，建议结合机构席位数据和板块共振信号使用，仅供观察验证。

```bash
bash scripts/03-run-dragon.sh
```

### 3. 短线信号扫描（short-term）

融合市场情绪周期判断与个股多因子评分。

**情绪周期判定**（六位游资方法论精华）：
- **主升期**：涨停 ≥50只 + 龙头 ≥4板 + 涨跌比 ≥1.5 → 重仓出击
- **试错期**：涨停 ≥30只 + 涨跌比 ≥1.2 + 题材梯队 → 中等仓位
- **震荡期**：涨停 ≥15只 + 涨跌比 ≥0.7 → 轻仓试探
- **主跌期**：不满足以上条件 → 15%仓位冰点布局
- **休市日**：非交易日自动中性模式

**评分因子**：
- 龙头辨识度、题材梯队、金叉启动、主力吸筹、缩量企稳
- 减分项：中位股风险回避（4-6板）、死亡换手（>70%）
- 市场修正：极端恐慌/过热自动调整

**Web界面一键触发**：

在可视化界面点击"生成短线信号"按钮，或直接运行：
```bash
node scripts/short-term-scan.mjs
```

## 使用方式

### 方式一：Web 可视化（推荐）

```bash
# 先运行策略产生数据
bash scripts/04-run-all.sh

# 启动可视化服务器
node viz/server.mjs
# 访问 http://localhost:3456
```

**功能**：
- 多策略Tab切换查看选股结果
- 点击股票展开详情：K线图 + 长短线分析 + 买卖席位穿透
- 行业/概念/评级多维度筛选
- 搜索股票代码/名称添加持仓
- 一键生成复盘分析（20秒）和短线信号（60秒）

### 方式二：命令行

```bash
bash scripts/04-run-all.sh    # 一键执行全部策略
bash scripts/02-run-band.sh   # 仅波段回调
bash scripts/03-run-dragon.sh # 仅龙回头
```

### 方式三：轻量独立脚本

```bash
node band-dip.mjs        # 波段回调（不依赖src管线）
node dragon-reverse.mjs  # 龙回头（不依赖src管线）
```

适用于快速测试或不需要完整管线的场景。

## 配置说明

### 全局配置 (`config/default.json`)

```json
{
  "data": {
    "cache_max_age_hours": 6,     // 缓存有效期
    "source": {
      "provider": "tencent",       // 行情源（tencent不封IP）
      "kline_provider": "baidu",   // K线源
      "request_delay_ms": 50       // 请求间隔限流
    }
  },
  "universe": {
    "exclude_st": true,            // 排除ST股
    "exclude_new_stocks_days": 60, // 排除新股天数
    "boards": ["sh", "sz", "cy", "kc"]  // 市场板块
  },
  "outputs": {
    "max_results": 20              // 最多显示结果数
  }
}
```

### 策略参数调优

编辑 `config/strategies/band-dip.json` 或 `config/strategies/dragon-reverse.json`：

**波段回调示例**：
```json
{
  "pullback": {
    "max_dist_ma20_pct": 5,        // 离20日线最大距离(%)
    "min_turnover_pct": 1.5        // 最小换手率(%)
  },
  "filters": {
    "min_price": 4,                // 最低股价
    "min_mcap_yi": 50              // 最低市值(亿)
  }
}
```

**龙回头示例**：
```json
{
  "dragon": {
    "min_first_wave_pct": 25,      // 最小首波涨幅(%)
    "min_retrace_pct": 8,           // 最小回调幅度(%)
    "max_retrace_pct": 35,          // 最大回调幅度(%)
    "max_retrace_days": 15,         // 最大回调天数
    "max_vol_ratio": 0.6            // 最大量比（回调量/峰值量）
  }
}
```

## 输出说明

运行策略后，`outputs/` 目录生成以下文件：

| 文件 | 说明 |
|------|------|
| `band-dip-YYYY-MM-DD.json` | 波段回调选股结果 |
| `dragon-reverse-YYYY-MM-DD.json` | 龙回头选股结果 |
| `short-term-YYYY-MM-DD.json` | 短线信号扫描结果 |
| `review-YYYY-MM-DD.json` | 持仓复盘分析报告 |
| `report.html` | 静态可视化报告 |
| `portfolio.json` | 用户持仓列表（不入库） |

每条选股结果包含：
- 技术面：趋势、均线、量比、缩量状态、信号标签
- 基本面：PE、市值、换手率
- 增强信息：概念板块、龙虎榜席位、近期新闻
- 归因分析：选中原因、语义化解读
- 操作建议：短线买入/加仓/观望/回避 + 长线估值判断

## 自定义策略

基于现有管线快速开发新策略（三步）：

### 1. 创建信号生成器

```js
// src/signals-mine.mjs
export function generateMySignal(stock, indicators, stratCfg, marketCtx) {
  // 你的策略逻辑，返回信号对象或 null
  if (!indicators.trendOK) return null;
  // ... 打分、标签、归因
  return { code, name, score, reason, ... };
}
```

### 2. 创建策略配置

```json
// config/strategies/my-strategy.json
{
  "strategy": { "name": "my-strategy", "display_name": "我的策略" },
  "filters": { "min_mcap_yi": 100 },
  "scoring": { "weights": { ... } }
}
```

### 3. 在管线中注册

在 `src/pipeline.mjs` 的 `runAll()` 中，`active_strategies` 数组加上你的策略名，并在 `runStrategy()` 中添加对应的 `if` 分支。

## 注意事项

1. **非投资建议**：所有选股结果仅供研究验证，不构成任何投资建议
2. **数据延迟**：行情数据可能有15秒~1分钟延迟，缓存有效期内结果不变
3. **龙回头胜率**：量化程序化交易大环境下，该策略胜率已下降，建议观察为主
4. **API限流**：东财接口内置200ms限流，批量扫描约需30秒（400只）~ 2分钟（全市场）
5. **交易时间**：建议收盘后（15:00）运行，确保当天数据完整
6. **持仓隐私**：`portfolio.json` 和 `outputs/` 已加入 `.gitignore`，不会上传到仓库

## License

仅供个人学习研究使用。
