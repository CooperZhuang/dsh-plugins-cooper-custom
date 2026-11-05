# dsh-cross-memory

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的**跨会话记忆**插件：
把会话里值得长期保留的内容抽取成条目，按作用域存进本机记忆库，在后续会话里按需注入。

- **两种作用域**：`global`（所有项目共享）与 `project`（按工作区隔离）。
- **三条协同路径**：模型可调用的 `memory` 工具、空闲时的后台抽取、有界的摘要注入与按需召回。
- **只写本机**：记忆库默认在 `$DSH_HOME/memories`，不上传任何服务；多机同步需要你自己配置一个 Git 仓库。
- **可审计**：每条记忆带来源、时间与（自动抽取时的）会话证据；归档可恢复，不静默删除。

## 功能

| 能力 | 说明 |
| --- | --- |
| 显式写入 | 模型调用 `memory` 工具写入/更新/检索/读取/遗忘；标题即身份，同名再写是更新。 |
| 后台抽取 | 会话空闲或按周期被扫描，用一次辅助模型调用抽取可复用的事实；落盘前做密钥擦除。 |
| 合并重整 | 受限子代理对一批记忆去重、改写、退役；有风险的决定进入「待裁决」由你决定。 |
| 分层注入 | 每个会话注入一次有界摘要；另有按需补注（当前这轮明显相关时）、标题轮转与增量块。 |
| 按需召回 | 关键词 + 时间衰减 + 一跳扩展；命中原因可在日志里核对。 |
| 原始片段（可选） | 补注块可附带来源会话的原文片段，默认关闭，因为它会把别的会话的原文带进当前上下文。 |
| persona | 维护「这个人是谁」的画像（`persona/human.md`），注入在记忆摘要之前，默认预算 12000 字节；设置 → 记忆 → 画像 可查看/编辑，并可锁定不让后台改写。 |
| 开放承诺 | 把会话里答应过、但还没到期/没做的事记成台账，到期未闭环会提醒。 |
| 反思与技能草稿 | 每周从记忆里提炼跨项目观察（必须引用来源记忆）；可把重复流程提成技能草稿，需你手动晋升。 |
| GUI | 设置 → 记忆：浏览/搜索/新增/删除、**画像查看/编辑与锁定**、配置项、待裁决；插件页该包下也有同一张配置卡。 |

### Persona 画像

- **在哪看**：画像是记忆库里的 `persona/human.md`（旧的单文件 `persona.md` 仍兼容读取）。每次会话开始时它被包进 `<persona>…snapshot 日期…</persona>`，注入在记忆摘要之前；超过 `personaMaxBytes`（默认 **12000**，0 关闭）的部分按行截断。
- **怎么编辑**：**设置 → 记忆 → 画像**，改完点「保存画像」即写回，不经过后台合并，不用重启宿主。
- **锁定**：同一页勾选「锁定画像」会在画像旁边写 `persona/human.lock`；锁定后后台 consolidation 即使提出画像改写也会跳过（日志会记 `persona is locked; the automatic profile update was skipped`），只有你手动保存才会改变它。取消勾选即解除。

更细的设计说明见 [`docs/DETAIL.zh.md`](docs/DETAIL.zh.md)（英文版 [`docs/DETAIL.md`](docs/DETAIL.md)）。

## 安装

包是标准 DSH profile bundle，用 `dsh plugin` 装进目标 profile：

```bash
# 从 npm 安装
dsh plugin --profile <profile> add dsh-cross-memory

# 从本地检出安装（路径按你的实际位置）
dsh plugin --profile <profile> add /path/to/packages/dsh-cross-memory

# 从 GitHub 安装
dsh plugin --profile <profile> add github:<you>/dsh-cross-memory
```

安装后**重启该 profile 的进程**（`dsh web` 这类长驻进程不会热加载新 bundle）。
`dsh --profile <profile> --dump-config` 里应能看到下面这一行：

```yaml
- id: memories        # 插件在 profile 里的固定 id，设置页与配置项都按它寻址
  name: dsh-cross-memory
```

> 插件在组合里的 id 始终是 `memories`，与包名无关。从旧包名迁移时，删掉旧的插件行、按新包名重装即可；
> 记忆数据目录不变。
>
> `lib/` 是构建产物、不入库。从 git 安装时 `prepare` 钩子会就地构建一次
> （`npm run build`）；pnpm 默认拦截安装脚本，按它打印的 key 加进 `allowBuilds` 后重跑即可。
> 从本地路径安装或从 npm 安装不需要这一步。

## 快速上手

1. 在一个会话里说一句值得记住的事，然后：

   ```
   /memories mine          # 立刻从当前会话抽取一次
   ```

2. 打开 **设置 → 记忆** 查看条目；或让模型直接调用 `memory` 工具：

   ```
   memory write scope=global title="Prefer pnpm over npm" body="..." kind=preference
   ```

3. 下一个会话开始时，摘要会自动注入；之后可用 `memory search` 或 `/memories search <query>` 检索细节。

## 配置

配置分两层，都在插件那一行的 `config` 下。

**部署层**（改完需要重挂这一行）：

```yaml
- id: memories
  config:
    memoriesDir: /custom/path        # 默认 $DSH_HOME/memories
    logFile: ''                      # 默认 $DSH_HOME/logs/dsh-cross-memory.log；空串关闭文件日志
    projectRootMarkers: ['.git']     # 向上找工作区根的标记
```

**可调项**（`.volatile()` 字段）：修改后立即生效，不需要重启，也不会重挂插件实例。
可以在设置 → 记忆 → 配置里改，也可以直接改当前 profile 的 patch。共 60 多项，常见项如下：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `maxSummaryBytes` | `4096` | 每会话注入摘要的总字节预算；`0` 关闭注入，只留工具 |
| `maxSummaryEntries` | `12` | 每个作用域最多列出几条 |
| `globalSummaryEntries` | `4` | 全局段最多列几条（两作用域共用总预算，全局段先渲染） |
| `globalSummaryBytes` | `1200` | 全局段单独占的字节预算；`0` 不注入全局段 |
| `summaryFreshSlots` | `3` | 每作用域预留几个名额给从未出现过的记忆，避免老条目长期占位 |
| `recallMode` | `on-demand` | `once` 只注一次摘要 / `on-demand` 额外按需补注 / `off` 只用工具 |
| `recallMinScore` | `9` | 按需补注的相关度下限（严格度旋钮） |
| `recallMinTerms` | `2` | 补注所需的实词数，防止只共享一个常见词就触发 |
| `recallMaxPerConversation` | `4` | 一个会话最多按需补注多少条记忆；`0` 关闭 |
| `rawRecall` | `false` | 补注块是否附带来源会话的原文片段（默认关闭） |
| `maxEntriesPerScope` | `1000` | 每作用域保留上限，超出后归档最久未用的 |
| `maxUnusedDays` | `90` | 多久没用就归档；`0` 关闭 |
| `snapshotMaxAgeDays` | `60` | `durability: snapshot` 条目的过期天数；`0` 关闭 |
| `sweepIntervalHours` | `12` | 定期整理间隔；`0` 关闭 |
| `autoExtract` | `true` | 是否启用空闲后台抽取 |
| `autoExtractIdleMs` | `300000` | 空闲多久后触发一次抽取 |
| `extractIntervalMinutes` | `30` | 周期性抽取间隔；`0` 关闭周期检查 |
| `minIdleHours` | `6` | 会话至少空闲多久才可被抽取 |
| `maxAgeDays` | `10` | 超过这么多天没活动的会话不再抽取 |
| `consolidate` | `true` | 是否启用合并重整 |
| `consolidateCooldownHours` | `6` | 两次合并之间的最小间隔 |
| `autoDecide` | `true` | 允许 AI 裁决本会排队等你的合并决定 |
| `syncRemote` | 空 | 记忆库同步用的 Git remote；空 = 只在本机提交 |
| `syncClock` | `12:05,18:05` | 定时同步的本地时刻；空则回退到 `syncIntervalMinutes` |
| `syncIntervalMinutes` | `10` | 后台同步间隔；`0` 关闭定时器 |
| `extractProvider` / `extractModel` | 空 | 抽取调用的模型路由；空则沿用会话路由 |
| `logLevel` | `info` | 插件日志详细程度：`off`/`error`/`warn`/`info`/`debug` |

完整字段与逐项说明以设置页「配置」标签为准（也可 `dsh --profile <profile> --dump-config`）。

## `memory` 工具

| action | 参数 | 作用 |
| --- | --- | --- |
| `write` | `scope` + `title` + `body` + `tags?` + `kind?` + `appliesTo?` | 写入或更新一条记忆 |
| `search` | `query?` + `scope?` + `tags?` + `limit?` | 检索；`query` 为空时按最近更新列出 |
| `read` | `id` + `scope?` | 读全文（默认先项目、后全局） |
| `forget` | `id` + `scope?` | 删除一条 |
| `evidence` | `id` 或 `evidenceSession` | 读这条记忆背后的会话证据笔记与逐字引文 |

`kind` 取值：`fact` / `preference` / `knowledge` / `failure` / `procedure`。

## `/memories` 命令

```
/memories                          列出两个作用域
/memories list global|project      只列某一作用域
/memories search <query>           检索（可加 --kind <kind>）
/memories show <id>                看全文
/memories add <global|project> <text>   手工写入
/memories forget <id>              删除
/memories archive [global|project] 列出已归档
/memories restore <id>             从归档取回
/memories mode [on|off]            本次会话临时关闭/开启记忆
/memories mine                     立刻从当前会话抽取一次
/memories backfill [--apply]       回填本进程没见过的历史会话（默认只估算）
/memories consolidate              立刻跑一次合并
/memories plan / apply / reject    查看与裁决待处理合并
/memories sweep                    立刻跑一次保留整理
/memories stale                    列出引用了已不存在文件的记忆
/memories skills / promote <name> / discard <name>    技能草稿管理
/memories stats                    存储位置与计数
```

## 数据存储

记忆库默认在 `$DSH_HOME/memories`（`$DSH_HOME` 未设置时为 `~/.dsh`）。条目是人类可读的
Markdown + 简单 frontmatter，**文件是唯一真相**；水位线、任务租约、用量计数等状态放在同目录的
SQLite（`state.db`，Node 内置 `node:sqlite`，无外部依赖）：

```text
$DSH_HOME/memories/
├── index.json                  # 可重建的索引缓存
├── entries/<id>.md             # 每条全局记忆一个文件
├── archive/<id>.md             # 归档的全局记忆（可恢复）
├── projects/<slug>/
│   ├── project.json            # slug 与根路径映射
│   ├── hosts/                  # 用过这个项目的机器
│   ├── entries/<id>.md
│   └── archive/<id>.md
├── sessions/<session-id>.md    # 证据笔记（被挖掘过的会话）
├── skills/<name>/SKILL.md      # 技能草稿（未晋升前 DSH 看不到）
├── persona/                    # persona 画像（human.md；human.lock 存在表示已锁定）
├── reflections/                # 每周反思
└── state.db                    # SQLite 状态
```

插件自己的日志默认写在 `$DSH_HOME/logs/dsh-cross-memory.log`，单文件 2 MB 轮转一代。
`npm run report` 可以把日志汇总成一份可读摘要。

## 隐私边界

- **默认不联网**。记忆只写在 `$DSH_HOME` 下，不往你的工作区仓库写文件；Git 同步默认关闭。
- **后台模型调用**会经过你配置的模型路由（默认沿用会话自己的路由）。抽取输入是会话尾部，
  只取用户与助手正文，丢弃工具结果和插件注入的内容，避免记忆自噬；落盘前做密钥擦除
  （`sk-…`、`ghp_…`、`AKIA…`、JWT、私钥块、`api_key=…`、`Bearer …` 等）。
- **注入的内容是背景数据，不是指令**：注入块会明确告诉模型，记忆记录的是写入时的事实，
  不一定现在仍成立。
- **原始片段是 opt-in**：`rawRecall` 默认关闭；打开后补注块会附带来源会话的原文（只读本机会话日志）。
- **通知可选**：默认通过操作系统通知提醒（每日摘要、积压警告、到期承诺），
  `noticeQuietHours` 可设置静默时段，`noticesEnabled: false` 完全关闭。
- **彻底关掉后台行为**：`autoExtract: false`、`consolidate: false`、`reflectionEnabled: false`；
  再设 `maxSummaryBytes: 0` 或 `recallMode: off` 就只剩 `memory` 工具与 `/memories` 命令。
- 归档与合并只动 `$DSH_HOME` 下的文件；归档条目可 `restore`，合并失败的改动会回滚。

## 多机同步（Git）

记忆库本身就是一个 Git 工作副本。把 `syncRemote` 指向**你自己创建的私有仓库**，多台机器就会共用同一份记忆：

```yaml
- id: memories
  config:
    syncRemote: https://github.com/<you>/dsh-cross-memory-store.git
    # 或 git@github.com:<you>/dsh-cross-memory-store.git
```

- 写入路径只做**本地提交**（`syncDebounceSeconds` 默认 2 秒合并一次）；拉取与推送在后台定时进行。
- 默认同步时刻 `syncClock: 12:05,18:05`（DeepSeek 谷时开始后几分钟，冲突合并成本最低）；
  留空则按 `syncIntervalMinutes`（默认 10 分钟）；`0` 关闭定时器，只保留手动同步。
- 冲突处理：能安全合并的自动合并；可能丢信息的进入 **设置 → 记忆 → 待裁决**（或 `/memories plan`）。
  `autoDecide` 开启时由 AI 先判断「这次改动是否丢信息」。
- **不入库**的状态：`state.db*`、各级 `index.json`、`pending/`、`project.json`、`*.log`。
- 同步仓库需要你自己创建并保护；插件不会替你创建远端，也不会向未配置的地址发送数据。

## 兼容性

| 依赖 | 区间 |
| --- | --- |
| DSH | `^0.2.1-rc.2 \|\| ^0.2.2-alpha.2` |
| Node.js | `>=24`（与 DSH 宿主自带运行时一致） |
| Cordis | `^4.0.5 \|\| ^4.0.6-alpha.1` |
| Schemastery | `^3.18.5 \|\| ^3.18.6-alpha.1` |

`@deepseek-ai/*` 均为 `peerDependencies`，由宿主提供，插件不另装内核包。
不同内核版本的子代理约定差异（预设路线 / 无预设直调 / 老内核黑名单路线）已在插件内适配。

## 开发

```bash
npm i                 # 或 pnpm i；prepare 钩子会构建一次
npm run typecheck     # tsc --noEmit
npm run build         # tsc + 客户端 bundle，产物在 lib/
npm test              # 编译后跑 node --test
npm run smoke         # 用真实 Cordis 根加载插件，检查注册结果
npm run report        # 汇总插件日志
```

- `src/` 是 TypeScript 源码，`client/` 是浏览器半边（构建时拼成 `lib/client.js`），
  `lib/` 是构建产物、不入库。
- `scripts/` 下有回填、检索评测、召回日志评测等运维与评测脚本；`bench/` 是基准与真实会话评测，
  其数据与语料不入库。
- 改动宿主半边（`lib/*.js`）后需要重启 DSH 宿主才生效；只改浏览器半边刷新页面即可。

## License

[MIT](LICENSE) © 2026 Cooper Zhuang
