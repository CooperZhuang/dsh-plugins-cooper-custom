# bench：检索排名与答案基准

记忆检索的对照台。跑的都是本地真实记忆库，数据不随仓库走。

```
node bench/export-corpus.mts            # 导出 ~/.dsh/memories 的 global 作用域 + 抽样 150 条
node bench/run-bench.mts                # 六条排名臂：current / relevance / BM25 / dense，另加 hybrid 与 hybrid+current 两条 RRF 融合臂
node bench/ablate.mts                   # 复刻打分函数后逐项拆解：idf、长度、饱和、注入排序
node bench/analyze.mts                  # 字段贡献、闸门拒绝原因、按 kind 的召回
node bench/sensitivity.mts              # BM25 的 k1×b×字段重复 64 格敏感性
node bench/inject-relevance.mts      # 注入块实际渲染的条目与主题相关率（前缀切分）
node bench/recall-quality.mts         # 日志里真实 recall 案例的排序质量（新/旧顺序对比）
node bench/e2e/run.mts                  # 端到端三臂（记忆 / 整段原文 / 闭卷），见 e2e/README.md
node bench/real/sample.mts               # 真实会话取样 → 出题 → 三臂评测，见 real/README.md
```

前五个是检索排名基准；`e2e/` 与 `real/` 是答案基准——记忆有没有让回答变对、闭卷能不能猜中。`e2e/` 用合成场景，`real/` 用真实会话。

`bench/data/` 全部由记忆库派生（含用户私事），`sensitivity.md` 引用了真实条目原文，两者都在 `.gitignore` 里，不进仓库。

## 读数守则

查询集分两批，两批不是同一个实验，别混算：

- `queries-b.jsonl`：生成时没跑任何自查，是干净样本。下结论只看这一批。
- `queries-a.jsonl`：生成器边写边跑检索自查，改到三臂都排第一才落盘，出厂打分在这批上是 100% R@1。这批只能当上限，不能用来衡量排序改动。

所以 `run-bench.mts` 与 `ablate.mts` 的表都按 all / a / b 拆开打印。聚合数会把一批饱和样本和一批干净样本平均成一个谁都不代表的数。

## 已知边界

- 语料是 global 作用域 732 条。项目作用域的 150 个目标只命中 2 条，无法用同一套查询做第二语料验证；要做得另生成查询。
- 查询是让模型按记忆条目写的「将来会话会怎么问」，与实际会话分布仍有差距；防泄漏只做到「不照抄原文」，标题里的专有名词和版本号会自然复现。
- dense 臂用本地 ollama 的 `qwen3-embedding:0.6b`（1024 维）。换模型要重跑，缓存按文本哈希存在 `bench/data/emb-*.json`。

## 数字来源与复算

检索基准的数字可以用一条命令核对：

```bash
node bench/verify-doc.mts
```

三份 bench 文档共用这一份判定：脚本只读 `bench/data/` 与题库源码，逐项打印 `PASS` / `MISMATCH` / `UNVERIFIABLE`，有 `MISMATCH` 时退出码非 0。当前 127 项里 PASS 103 项、UNVERIFIABLE 24 项、无 `MISMATCH`。

可复算：语料 732 条、`queries-a` / `queries-b` 各 75 条、`queries-a` 上 current 臂 R@1 = 73/75（2026-11-23 排序层改 BM25 后；改前词法排序是 75/75）、dense 缓存的模型 `qwen3-embedding:0.6b` 与 1024 维。

不能复算：「项目作用域的 150 个目标只命中 2 条」对应的命中比对没有留存产物，`bench/data/sample.json` 只有 150 条抽样，不要把 2 条这个数当成可验证的结论引用。

### 注入相关性的基线（2026-11-23）

`inject-relevance.mts` 在 20 场真实会话上回放注入选择，改前（词法排序、global 先、
每作用域独立排名、非 tier 填满）与改后（BM25 排序、project 先、合并排序、tier 不填满）：

| 指标 | 改前 | 改后 |
| --- | ---: | ---: |
| listed/会话 | 25.1 | 20.4 |
| 其中与开场白相关 | 51.5% | 63.4% |
| 其中与会话全文相关 | 73.8% | 68.8% |
| 渲染块前 6 条与开场白相关 | 49/120 | 113/120（94.2%） |

绝对相关数几乎不变（约 12.9 条/会话），减少的是噪声条目。前 6 条的差距最大，因为
字节预算稳定渲染的就是头部。收窄 `maxSummaryBytes` 不是替代手段：渲染器按
perScope 分级降级，预算一紧每节只渲染 1 条，相关绝对数反而掉到 4.4。

### 按需召回的排序质量（2026-11-23）

`recall-quality.mts` 读日志里的真实 recall 案例，比较 BM25 顺序与它取代的
relevance 顺序。**判据不是「相关率」**：真实用户轮多是短句（人工判 top-1 相关
约 40%，见 e2e/real 的说明），所以用排序质量——前 3 条的平均 BM25 分数。

| 指标 | 改前（relevance） | 改后（BM25） |
| --- | ---: | ---: |
| 前 3 条平均 BM25（32 案例） | 46.49 | 54.91 |
| 改善 / 变差 / 持平 | — | 25 / 0 / 7 |

拼前几轮用户消息做 query 实测只把主题相关从 36.4 提到 38.0（+4%），不是短轮弱的
根因；要再进一步只能靠 dense 语义通道（见下）。

### 未采纳的方向：dense 语义通道

bench 的 hybrid 臂（BM25 + ollama 嵌入 RRF）在 queries-b 上：R@1 74.7（BM25 76.0）、
R@5 96.0（92.0）、落榜 1（5）。收益集中在「落榜」和 R@5，R@1 反而略降。引入它需要
把同步的 `searchMemories` 异步化，并让运行时依赖本机 ollama；本机 ollama 的定位是
冒烟，所以先不做，作为已量化的备选。
