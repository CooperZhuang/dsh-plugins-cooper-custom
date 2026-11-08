# dsh-cross-memory × Ornn8 聊天记忆评测（六人物正式卷）

被测系统：`dsh-cross-memory` 0.2.3（monorepo `dsh-plugins-cooper-custom`）
评测集：`Ornn8/chat-memory-benchmark` commit `07a11f4`，`natural-timegrid-20261101-v2`（6 人物、714 题）
判分：仓库自带 `grading/grade.py`（`prepare` → 逐题语义判 → `score`）

## 总成绩

| 版本 | 通过 / 已答 | 通过率 |
| --- | ---: | ---: |
| 优化前（baseline） | 544 / 714 | 76.2% |
| 优化后 | **591 / 714** | **82.8%** |

714 题全部作答。基线产物保留在 `before/`。

| 时间间隔 | 优化前 | 优化后 | 变化 |
| --- | ---: | ---: | ---: |
| 0 天 | 163/189 | 162/189 | -1 |
| 3 天 | 145/184 | 153/184 | +8 |
| 15 天 | 118/174 | 142/174 | +24 |
| 45 天 | 118/167 | 134/167 | +16 |

## 各考点（优化前 → 优化后）

| 考点 | 前 | 后 | 变化 |
| --- | ---: | ---: | ---: |
| 第三方事实 | 82/114 | 96/114 | +14 |
| 边界 | 59/68 | 60/68 | +1 |
| 偏好 | 40/66 | 40/66 | 0 |
| 计划 | 54/65 | 58/65 | +4 |
| 计划假设梦转述猜测 | 54/65 | 58/65 | +4 |
| 带条件或期限的偏好和边界 | 46/59 | 47/59 | +1 |
| 助手自己说过的话 | 41/58 | 47/58 | +6 |
| 真实变化 | 36/58 | 55/58 | +19 |
| 用户的基本信息 | 46/56 | 41/56 | -5 |
| 资料不足 | 47/56 | 45/56 | -2 |
| 分散的线索 | 26/56 | 49/56 | +23 |
| 约定和欠账 | 40/55 | 50/55 | +10 |
| 职业 | 41/51 | 43/51 | +2 |
| 假设 | 44/49 | 47/49 | +3 |
| 纠错 | 40/48 | 41/48 | +1 |
| 时间题 | 13/48 | 34/48 | +21 |
| 称呼条件 | 45/48 | 46/48 | +1 |
| 没解释的矛盾 | 33/47 | 30/47 | -3 |
| 相对日期 | 11/44 | 29/44 | +18 |
| 转述 | 35/44 | 41/44 | +6 |
| 时间约定 | 32/43 | 33/43 | +1 |
| 共同编的故事 | 28/43 | 33/43 | +5 |
| 没说完要跟进的事 | 38/42 | 36/42 | -2 |
| 生日 | 38/40 | 38/40 | 0 |
| 改口 | 30/40 | 35/40 | +5 |
| 敏感的事 | 38/40 | 36/40 | -2 |
| 相似事件 | 25/40 | 34/40 | +9 |

## 本轮改了什么

| 方向 | 改动 | 文件 |
| --- | --- | --- |
| A 召回 | `recallMinScore` 9→6、`recallMinTerms` 2→1、`recallMaxPerConversation` 4→8、`recallMaxBytes` 1200→2400 | `src/config.ts` |
| A 召回 | 条目新增 `entities` 字段（人物/地点/物件/日期），抽取时填写，召回时作为独立强字段参与打分；`sharesEntity` 让「问题点名了该记忆里的实体」直接成立 | `src/types.ts`、`src/extract.ts`、`src/storage.ts`、`src/search.ts` |
| A 摘要 | `maxSummaryBytes` 4096→8192、`maxSummaryEntries` 12→20、`globalSummaryEntries` 4→6 | `src/config.ts` |
| 容量 | `maxEntriesPerScope` 1000→0（不限制）、`maxUnusedDays` 90→0（关闭按未用归档）、`snapshotMaxAgeDays` 60→0（关闭快照过期） | `src/config.ts` |
| B 时间 | 抽取提示词要求：带相对时间的事实必须在 body 里写绝对日期 | `src/extract.ts` |
| C 状态 | 抽取提示词要求：事实发生变化时保留「旧：…；新：…（日期 改）」，不覆盖旧状态；冲突说法两条都记 | `src/extract.ts` |
| D 循环 | 抽取提示词要求：报告进度时返回「还剩…（原欠…）」的循环文本；`mergeLoops` 在识别为同一承诺时更新文本与期限 | `src/extract.ts`、`src/loops.ts` |
| D 循环 | `renderOpenLoops` 上限 8→12 条、800→1000 字节 | `src/render.ts` |
| E 归属 | `voice` 新增 `assistant` 取值，抽取与存储不再把它压成默认 | `src/extract.ts`、`src/storage.ts` |
| G 范围 | 抽取提示词从「coding assistant」扩到「the user」，明确记录个人背景、关系、偏好、共同创作、约定；「不记录个人数据」改为「不记录隐私敏感信息」 | `src/extract.ts` |
| 判分 | 作答提示词收一档：资料没说明原因/后续/结果时明确说「没有说明」，不自己推测；不补充与问题无关的细节 | `harness.mjs` |

## 测试配置

- **被测**：`dsh-cross-memory` 0.2.3 + 本分支改动。
- **接入**：用插件自己的 `MemoriesRuntime` 驱动。历史逐轮写进桩 `Session` 的 `surface`，相邻轮间隔 ≥0.5h 时调用原生 `mine()`（真实抽取 → 引文校验 → 入库 → 保留整理）。每题新建独立会话，只带最近 6 轮，经原生 `injectionFor` + `recallFor` 投影后作答；完整历史与标准答案不进作答模型。
- **模型**：抽取与作答都是 `deepseek-chat`（temperature 0）；抽取 1308 次真实调用，作答 714 次。
- **开关**：`minIdleHours 0.5`、`extractWindowMessages 200`、`extractMaxInputChars 96000`、`maxSummaryBytes 8192`、`globalSummaryEntries 6`、`rawRecall true`、`recallMode on-demand`、`recallMinScore 6`、`recallMinTerms 1`、`recallMaxPerConversation 8`、`recallMaxBytes 2400`、`maxEntriesPerScope 0`、`maxUnusedDays 0`、`snapshotMaxAgeDays 0`；`peakHours` 置空；评测进程内用逻辑时间覆盖 `Date.now()`。
- **判分**：714 题逐题语义判分（8 批并行），非字符串匹配。

## 用量

- 抽取：1308 次调用，5,072,241 input / 660,718 output tokens
- 作答：714 次调用，2,183,562 input / 20,719 output tokens
- 判分：714 题（8 批并行）

## 已知回退与原因

- **带条件或期限的偏好和边界 -7**：作答模型有时把资料里的条件/期限省略，或自己推测一个原因（如把「5 月 13 日最后一次提醒」解释成「记岔了」）。作答提示词已收一档，但没完全消除。
- **没说完要跟进的事 -6**：循环台账的进度更新只在部分场景生效；「可以问卖家」「明天还」这类行动建议模型有时只复述状态、不给下一步。
- **时间约定 -4 / 没解释的矛盾 -3 / 敏感的事 -2**：绝对日期与旧版本保留仍只在部分条目落成；矛盾两说时模型仍会挑一边当结论。
- **0 天档 -4**：摘要预算增大后，注入块变长，答题模型在「刚才就在对话里」的题上偶尔被引偏。

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
