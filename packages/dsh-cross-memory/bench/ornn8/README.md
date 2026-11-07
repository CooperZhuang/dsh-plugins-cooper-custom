# dsh-cross-memory × Ornn8 聊天记忆评测（六人物正式卷）

被测系统：`dsh-cross-memory` 0.2.3（commit `682a138`，monorepo `dsh-plugins-cooper-custom`）
评测集：`Ornn8/chat-memory-benchmark` commit `07a11f4`，`natural-timegrid-20261101-v2`（6 人物、714 题）
判分：仓库自带 `grading/grade.py`（`prepare` → 逐题语义判 → `score`）

## 总成绩

| 版本 | 通过 / 已答 | 通过率 |
| --- | ---: | ---: |
| 优化前（baseline） | 544 / 714 | 76.2% |
| 优化后 | **553 / 714** | **77.5%** |

714 题全部作答、无中断。基线产物保留在 `before/`。

| 时间间隔 | 优化前 | 优化后 | 变化 |
| --- | ---: | ---: | ---: |
| 0 天 | 163/189 | 154/189 | -9 |
| 3 天 | 145/184 | 151/184 | +6 |
| 15 天 | 118/174 | 125/174 | +7 |
| 45 天 | 118/167 | 123/167 | +5 |

长期间隔（3/15/45 天）全面提升，0 天档回退 9 题——摘要预算增大后，直接上下文里的近期事实被更多记忆块挤占，答题模型在「刚才就在对话里」的题上反而更容易被引偏。

## 各考点（优化前 → 优化后）

| 考点 | 前 | 后 | 变化 |
| --- | ---: | ---: | ---: |
| 第三方事实 | 82/114 | 93/114 | +11 |
| 边界 | 59/68 | 60/68 | +1 |
| 偏好 | 40/66 | 41/66 | +1 |
| 计划 | 54/65 | 53/65 | -1 |
| 计划假设梦转述猜测 | 54/65 | 58/65 | +4 |
| 带条件或期限的偏好和边界 | 46/59 | 39/59 | -7 |
| 助手自己说过的话 | 41/58 | 44/58 | +3 |
| 真实变化 | 36/58 | 44/58 | +8 |
| 用户的基本信息 | 46/56 | 45/56 | -1 |
| 资料不足 | 47/56 | 47/56 | 0 |
| 分散的线索 | 26/56 | 38/56 | +12 |
| 约定和欠账 | 40/55 | 41/55 | +1 |
| 职业 | 41/51 | 42/51 | +1 |
| 假设 | 44/49 | 45/49 | +1 |
| 纠错 | 40/48 | 41/48 | +1 |
| 时间题 | 13/48 | 15/48 | +2 |
| 称呼条件 | 45/48 | 48/48 | +3 |
| 没解释的矛盾 | 33/47 | 32/47 | -1 |
| 相对日期 | 11/44 | 16/44 | +5 |
| 转述 | 35/44 | 41/44 | +6 |
| 时间约定 | 32/43 | 30/43 | -2 |
| 共同编的故事 | 28/43 | 29/43 | +1 |
| 没说完要跟进的事 | 38/42 | 31/42 | -7 |
| 生日 | 38/40 | 39/40 | +1 |
| 改口 | 30/40 | 35/40 | +5 |
| 敏感的事 | 38/40 | 37/40 | -1 |
| 相似事件 | 25/40 | 29/40 | +4 |

## 本轮改了什么

| 方向 | 改动 | 文件 |
| --- | --- | --- |
| A 召回 | `recallMinScore` 9→6、`recallMinTerms` 2→1、`recallMaxPerConversation` 4→8、`recallMaxBytes` 1200→2400 | `src/config.ts` |
| A 召回 | 条目新增 `entities` 字段（人物/地点/物件/日期），抽取时填写，召回时作为独立强字段参与打分；`sharesEntity` 让「问题点名了该记忆里的实体」直接成立 | `src/types.ts`、`src/extract.ts`、`src/storage.ts`、`src/search.ts` |
| A 摘要 | `maxSummaryBytes` 4096→8192、`maxSummaryEntries` 12→20、`globalSummaryEntries` 4→6 | `src/config.ts` |
| B 时间 | 抽取提示词要求：带相对时间的事实必须在 body 里写绝对日期 | `src/extract.ts` |
| C 状态 | 抽取提示词要求：事实发生变化时保留「旧：…；新：…（日期 改）」，不覆盖旧状态；冲突说法两条都记 | `src/extract.ts` |
| D 循环 | 抽取提示词要求：报告进度时返回「还剩…（原欠…）」的循环文本；`mergeLoops` 在识别为同一承诺时更新文本与期限 | `src/extract.ts`、`src/loops.ts` |
| D 循环 | `renderOpenLoops` 上限 8→12 条、800→1000 字节 | `src/render.ts` |
| E 归属 | `voice` 新增 `assistant` 取值，抽取与存储不再把它压成默认 | `src/extract.ts`、`src/storage.ts` |
| G 范围 | 抽取提示词从「coding assistant」扩到「the user」，明确记录个人背景、关系、偏好、共同创作、约定；「不记录个人数据」改为「不记录隐私敏感信息」 | `src/extract.ts` |

## 测试配置

- **被测**：`dsh-cross-memory` 0.2.3 + 本分支改动。
- **接入**：用插件自己的 `MemoriesRuntime` 驱动。历史逐轮写进桩 `Session` 的 `surface`，相邻轮间隔 ≥0.5h 时调用原生 `mine()`（真实抽取 → 引文校验 → 入库 → 保留整理）。每题新建独立会话，只带最近 6 轮，经原生 `injectionFor` + `recallFor` 投影后作答；完整历史与标准答案不进作答模型。
- **模型**：抽取与作答都是 `deepseek-chat`（temperature 0）；抽取 1308 次真实调用，作答 714 次。
- **开关**：`minIdleHours 0.5`、`extractWindowMessages 200`、`extractMaxInputChars 96000`、`maxSummaryBytes 8192`、`globalSummaryEntries 6`、`rawRecall true`、`recallMode on-demand`、`recallMinScore 6`、`recallMinTerms 1`、`recallMaxPerConversation 8`、`recallMaxBytes 2400`；`peakHours` 置空；评测进程内用逻辑时间覆盖 `Date.now()`。
- **判分**：714 题逐题语义判分（8 批并行），非字符串匹配。

## 用量

- 抽取：1308 次调用，5,063,383 input / 652,920 output tokens
- 作答：714 次调用，2,174,864 input / 20,303 output tokens
- 判分：714 题（8 批并行 + 缺失批次补判）

## 已知回退与原因

- **0 天档 -9**：摘要预算翻倍后，注入块变长，答题模型在「刚才就在对话里」的题上更容易被引偏。
- **带条件或期限的偏好和边界 -7 / 没说完要跟进的事 -7**：抽取提示词的变化让部分条目被改写成更晚的状态，或把记忆归到 global 作用域后受限于全局摘要名额。
- **时间题仍低（15/48）**：绝对日期只在部分条目里落成，`UPDATES`/`TIME` 指令对「前天搬花」这类单次事件仍会被后续状态覆盖。
- **共同编的故事仍低（29/43）**：故事初稿与「旧版作废」的版本保留只在部分场景生效。

## 文件

| 文件 | 内容 |
| --- | --- |
| `harness.mjs` | 评测适配器（桩会话 + 原生抽取/注入/召回 + 考试作答） |
| `answers.jsonl` | 714 题的实际回答 |
| `packets.jsonl` | 判分材料 |
| `reviews.jsonl` | 714 题逐题判分 |
| `judgments.jsonl` | `grade.py score` 的规则汇总 |
| `summary.json` | 总成绩与按人物/考点/间隔统计 |
| `run-stats.json` | 各人物维护调用数、写入条数、考试数与 token 用量 |
| `before/` | 优化前的同口径产物（544/714） |

完整运行日志在评测机的 `/tmp/chat-memory-benchmark/outputs/run-log.jsonl`（含每次抽取的原始回复与每题记忆快照），未入库。

## 复现

```sh
cd /Users/cooper/Documents/Code/Dsh/dsh-plugins-cooper-custom
pnpm install && pnpm run build
git clone https://github.com/Ornn8/chat-memory-benchmark.git /tmp/chat-memory-benchmark
node packages/dsh-cross-memory/bench/ornn8/harness.mjs
cd /tmp/chat-memory-benchmark
python3 grading/grade.py prepare --answers outputs/answers.jsonl --out outputs/packets.jsonl
# 逐题判分写入 outputs/reviews.jsonl（规则见 grading/judge-prompt.md）
python3 grading/grade.py score --packets outputs/packets.jsonl --reviews outputs/reviews.jsonl \
  --out outputs/judgments.jsonl --summary outputs/summary.json
```
