# bench

记忆检索的对照台。跑的都是本机真实记忆库，数据不随仓库走。

```
node bench/export-corpus.mjs            # 导出 ~/.dsh/memories 的 global 作用域 + 抽样 150 条
node bench/run-bench.mjs                # 四条对照臂：出厂打分 / BM25 / dense / RRF
node bench/ablate.mjs                   # 复刻打分函数后逐项拆解：idf、长度、饱和、注入排序
node bench/analyze.mjs                  # 字段贡献、闸门拒绝原因、按 kind 的召回
node bench/sensitivity.mjs              # BM25 的 k1×b×字段重复 64 格敏感性
```

`bench/data/` 全部由记忆库派生（含用户私事），`sensitivity.md` 引用了真实条目原文，
两者都在 `.gitignore` 里，不进仓库。

## 读数守则

查询集分两批，两批不是同一个实验，别混算：

- `queries-b.jsonl`：生成时没跑任何自查，是干净样本。**下结论只看这一批。**
- `queries-a.jsonl`：生成器边写边跑检索自查，改到三臂都排第一才落盘，出厂打分在这批上
  是 100% R@1。这批只能当上限，不能用来衡量排序改动。

所以 `run-bench.mjs` 与 `ablate.mjs` 的表都按 all / a / b 拆开打印。聚合数会把一批饱和
样本和一批干净样本平均成一个谁都不代表的数。

## 已知边界

- 语料是 global 作用域 732 条。项目作用域的 150 个目标只命中 2 条，无法用同一套查询做
  第二语料验证；要做得另生成查询。
- 查询是让模型按记忆条目写的"将来会话会怎么问"，与实际会话分布仍有差距；防泄漏只做到
  「不照抄原文」，标题里的专有名词和版本号会自然复现。
- dense 臂用本机 ollama 的 `qwen3-embedding:0.6b`（1024 维）。换模型要重跑，缓存按文本
  哈希存在 `bench/data/emb-*.json`。
