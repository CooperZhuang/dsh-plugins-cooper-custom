# dsh-rtk-slim 设计（2026-10-16）

一个 DeepSeek Harness（DSH）宿主半边插件：把超大的命令输出交给 `rtk`（Rust Token Killer）精简后
再交给模型，并且**任何一次精简都可追溯、任何一次失败都静默降级**。

本仓库同时是本设计的实现仓库。仓库路径：`~/Documents/Code/dsh-rtk-slim`。

---

## 1. 背景与要解决的问题

目标环境：DSH Desktop Beta，运行时 `@deepseek-ai/dsh-*` = **0.2.1-alpha.2**（实测，非猜测）。

社区已有的两个同类插件都不适用于本环境，原因如下（均为本机实测结论）：

| 插件 | 机制 | 在本环境的问题 |
|---|---|---|
| `dsh-bash-rtk` | 覆写 `LocalBashExecutor.resolve()`，把命令改写成 `rtk git status` | ① 声明 `engines: >=0.1.0-rc.6 <0.2.0`，**明确排除 0.2.x**；② 它构造的返回类型 `ShellExecSpec` 在已安装的 `@deepseek-ai/dsh-shell@0.2.1-alpha.2` 中**已不存在**（只剩 `ShellExecutor` / `ShellExecution`）；③ npm 上 peer 钉在 `0.0.1-rc.*`；④ 不覆盖后台 `job_output`；⑤ 含 `\| & ; < > \` $` 的命令一律放行，而 agent 的多数命令都带管道 |
| `dsh-rtk-filter` | 挂 `tools/post-execute`，把大输出管道给 `rtk pipe` | ① 默认 `args: ['pipe']` 只能靠 rtk 自动识别，git log 这类认不出（实测 6202 B → 6202 B）；② 一旦按 README 建议配 `-f <filter>`，**不匹配的内容会被删**（实测 751 B 无关文本 → 4 行）——这是最危险的失败模式；③ `-f` 是单值，无法按内容自适应 |

`rtk` 本身已安装且可用：`/opt/homebrew/bin/rtk`（0.49.0），且 DSH 的 bash 工具 PATH 中**包含**
`/opt/homebrew/bin`（实测 `which rtk` 命中），因此不需要写绝对路径。

### rtk 行为基线（本机实测，作为实现与测试的依据）

| 输入 | 裸 `rtk pipe`（无 `-f`） | 说明 |
|---|---|---|
| cargo test 真实输出 866 B | → 38 B | 自动识别 |
| pytest 真实输出 2364 B | → 17 B | 自动识别 |
| `grep -rn` 大输出 4729 B | → 2425 B | 自动识别 |
| 真实 `git log --oneline` 6202 B | → 6202 B | **认不出，透传**；需 `-f git-log`（→ 约 180 B） |
| `ls -la` / 源码 / JSON / 无结构文本 | 逐字节不变 | 认不出即透传 |

结论：裸 `pipe` 是**安全的**（认不出就透传），而 `-f` 是**危险但高收益**的。设计的核心就是
「只在能证明家族匹配时才用 `-f`，并对 `-f` 的结果做不变式体检」。

---

## 2. 目标与非目标

**目标**

1. 自动压缩 `bash`（前台）与 `job_output`（后台）的大输出，节省上下文。
2. 在 `rtk pipe` 之上补上它认不出的家族（首要为 `git log`），且不引入 `-f` 误伤。
3. 每一次精简都**可追溯**：全文落盘 + 在模型可见文本里给出一行定位提示。
4. 失败面收敛：rtk 缺失、超时、非零退出、输出无变化、任何异常 → 保留原文，绝不把成功调用变成 `isError`。
5. 只依赖 0.2.1-alpha.2 里**已实测存在**的 API；开发期类型与测试跑在同一版本上。

**非目标**

- 不新增工具、不改命令本身、不做命令改写（明确放弃 `dsh-bash-rtk` 的路线）。
- 不做客户端/UI 半边，不做设置页。
- 不按 token 计量阈值做决策（token-meter 属于 spill-policy 的职责）。
- 不管理 `rtk` 的安装与升级（缺失即静默降级）。
- 不做多 filter 级联（实测：不匹配的 `-f` 会破坏内容，级联不可用）。

---

## 3. 架构与数据流

```
bash / job_output 工具产出结果
        │
        ▼
tools/post-execute waterfall（官方扩展点，已实测存在于 dsh-tools@0.2.1-alpha.2）
        │  本插件登记为「最内层」→ 拿到的一定是原始文本
        ▼
[1] 门槛：工具名 / 非失败 / 纯文本 / 字节数 ≥ minBytes
        ▼
[2] 拆出末尾状态标记（逐字保留）
        ▼
[3] 家族嗅探 → 决定 rtk 参数（匹配则 -f <filter>，否则裸 pipe）
        ▼
[4] 调 rtk（stdin → stdout，超时/取消整组击杀）
        ▼
[5] 不变式体检 I1/I2/I3 —— 任一不过 → 回退原文
        ▼
[6] 全文落盘（ctx.spillStore）→ 拿 locator；落盘失败 → 回退原文
        ▼
[7] 替换 content：精简正文 + notice + 原状态标记
```

**与 `dsh-spill-policy` 的共存顺序（关键）**：`spill-policy` 与 `spill-local` 已由 base bundle 挂载
（`dsh-base/cordis.patch.yml` 的 `id: spill-policy` / `id: spill-local`）。本插件**不使用**
`{ prepend: true }` 登记，因此处在 waterfall 最内层，看到的是原始文本；`spill-policy` 在外层，
若精简后的文本仍超过它的 token 上限，它再按自己的策略落盘。两层各管一段，不互相吞噬。

**升级路径**：若某次调用 `decision.content` 已被更内层监听者替换（例如未来有插件先动手），
本插件读 `decision.content ?? result.content`，对已变小的文本自然不再触发压缩，行为仍然正确。

---

## 4. 组件与接口

纯 ESM JavaScript（`lib/*.js` 即源码，无构建步骤），JSDoc + `tsc --checkJs` 做类型检查。
`apply()` 只做装配，handler 通过工厂函数导出以便无 cordis 单测。

| 模块 | 职责 | 导出 |
|---|---|---|
| `lib/markers.js` | 末尾状态标记的拆分与还原（纯函数） | `splitTailMarkers(text) → { body, tail }`、`joinTailMarkers(body, tail) → string` |
| `lib/sniff.js` | 家族嗅探 → rtk 参数（纯函数） | `FAMILIES`、`chooseFilter(text) → { family, filter \| undefined }` |
| `lib/guards.js` | 不变式 I1/I2/I3（纯函数） | `FAILURE_PATTERNS`、`collectFailureLines(text)`、`checkInvariants(input) → { ok: true } \| { ok: false, reason }` |
| `lib/rtk.js` | 调用 rtk（spawn / 超时 / 整组击杀 / 输出上限） | `runRtk({ command, args, input, timeoutMs, signal, maxOutputBytes }) → Promise<Result>` |
| `lib/spill.js` | 与 `ctx.spillStore` 集成 + notice 文案 | `saveFullText(ctx, exec, text, label) → Promise<Ref \| undefined>`、`formatCondenseNotice({ beforeBytes, afterBytes, ref }) → string` |
| `lib/index.js` | 插件装配与 handler | `name`、`inject`、`Config`、`apply(ctx, config)`、`createPostExecuteHandler(ctx, config, deps?)` |

`Result`：`{ ok: true, text }` 或 `{ ok: false, reason: 'spawn' | 'exit' | 'timeout' | 'aborted' | 'empty' | 'too-large' }`。
`Ref`：`{ locator, retrievalHint }`（由 `spillStore.saveText()` 返回，原样使用）。

### 4.1 状态标记的真实词汇（来自 `dsh-tool-bash` 的 `renderResult`，非二手文档）

`[exit code: N]`（**仅当 exitCode ≠ 0**）、`[timed out after Nms]`、`[stopped: …]`、
`[killed by signal: …]`、`[sandbox: …]`（沙箱拒绝）+ 可选的同轮升级提示行、
`[still running after Nms; moved to background job <id>]` 及其后两行后台指引。

`splitTailMarkers` 的规则：从末尾向上，连续吃掉匹配
`/^\[(exit code: -?\d+|timed out after \d+ms|stopped: [^\]]*|killed by signal: [^\]]*|sandbox: [^\]]*|still running after \d+ms; moved to background job [^\]]+)\]$/`
的行，以及其后可能存在的后台指引段落（`The command keeps running in the background.` 起始的那段）。
被拆出的部分**逐字**回填，长度与字节数完全不变。正文里恰好形似标记的行**不拆**（只在末尾连续区段内生效）。

---

## 5. 家族嗅探表

判定在**已拆掉末尾标记的正文**上进行；自上而下**首个命中者胜**；全部不命中则用裸 `pipe`（实测安全）。

| id | 判据（正则，作用于正文） | rtk 参数 | 依据 |
|---|---|---|---|
| `cargo-test` | `/^running \d+ tests?$/m` **且** `/^test result:/m` | `pipe -f cargo-test` | 双条件避免误判普通文本 |
| `pytest` | `/^=+ .*test session starts.* =+$/m` 或（`/^\S+::\S+/m` 且 `/PASSED\|FAILED/`） | `pipe -f pytest` | |
| `git-log` | ≥5 行匹配 `/^[0-9a-f]{7,40} \S/`，或 `/^commit [0-9a-f]{40}$/m` | `pipe -f git-log` | 裸 pipe 认不出，本插件的主要增量收益 |
| `grep` | ≥5 行匹配 `/^[^\s:]+:\d+:/` | `pipe -f grep` | 裸 pipe 也能认，但显式更稳 |
| `find` | ≥10 行匹配 `/^[^\s]+$/` 且多数行含 `/` 且无冒号 | `pipe -f find` | 保守阈值，避免吃掉 `ls` 输出 |
| `auto` | 以上皆不命中 | `pipe`（无 `-f`） | 实测认不出即逐字节透传 |

阈值行数（≥5 / ≥10）与正则都写在 `FAMILIES` 里，配置项 `filters` 可增删/覆盖；
单测必须包含**负例**：`ls -la`、源码文件、JSON、无结构文本必须落到 `auto`。

---

## 6. 不变式（任一不过 → 整条回退原文）

**I1 标记保全**：`splitTailMarkers` 拆出的 `tail` 必须与原文中的对应片段逐字节一致，并被原样回填到
精简结果末尾。实现上由「先拆后拼」结构性保证，不靠字符串搜索。

**I2 失败证据保全**：从原文收集失败信号行（trim + 去重）：

```
/^\s*test result: FAILED/m
/^\s*FAILED\b/m
/^\s*--- FAIL:/m
/^error(\[E\d+\])?:/m
/^\s*Traceback \(most recent call last\):/m
/panicked at/m
/^\s*AssertionError\b/m
/^FAIL\b/m
```

精简文本必须**逐行包含**每一条失败信号行（trim 后子串匹配）。缺任何一条 → `{ ok:false, reason:'failures' }` → 回退。
**关键**：模式只覆盖"失败信号"，不含 `failed` 这种普通词——否则通过的测试输出里 `0 failed` 会让
不变式恒假，把主收益全部回退掉（这是设计里特意避开的陷阱，单测必须覆盖"全通过的 cargo/pytest 不影响压缩"）。

**I3 压缩比合理性**：若 `condensed.length < 2% × raw.length` 且 `raw.length ≥ 32 KiB`，
则要求精简文本含 rtk 的省略标记（`[+N lines omitted]` 形如 `/\[\+\d+ lines? omitted\]/`）或
含 spill notice；否则回退（防某个 filter 返回残桩）。

**共同前置**：`ok`、`text` 非空、且 `text.trim() !== raw.trim()`（输出无变化视为未压缩，直接用原文）。

---

## 7. 有损可追溯（复用官方 spillStore）

调用方式与官方 `dsh-spill-policy` 完全一致（照抄其调用契约，不自己发明文件布局）：

```js
const ref = await ctx.get('spillStore').saveText({
  owner: { sessionId: exec.agent?.session.header.id },
  source: { kind: 'tool', toolName: exec.name, callId: exec.callId, label: 'result' },
  suggestedName: `${exec.name}.txt`,
  content: rawText,                       // 完整原文（含被拆出的标记之前的部分）
});
// ref = { locator, retrievalHint: 'Use read with offset/limit, or grep this path to search within it.' }
```

模型可见文本末尾追加与 spill-policy 同款措辞的 notice：

```
(rtk condensed 6202 → 184 bytes. Full formatted result stored at: <locator>. Use read with offset/limit, or grep this path to search within it.)
```

**回退规则**：`spill` 关闭时跳过落盘；`requireSpill`（默认 `true`）开启时，若 `spillStore` 不存在、
会话 id 缺失或落盘抛错 → **整条回退原文**。原因：本插件承诺"有损必可追溯"，做不到就不做。
（`notice:false` 只影响文本提示，不影响落盘。）

文件清理交给 `spill-local` 自带的 sweep（`runCleanup`），本插件不删文件、不建目录。

---

## 8. 降级与错误处理

| 情形 | 行为 |
|---|---|
| `rtk` 不在 PATH / spawn 失败 | 原文照旧；`warn` 一次 |
| rtk 非零退出 | 原文照旧；`warn` 一次 |
| rtk 超时（默认 10s）或调用方取消（`exec.signal`） | `process.kill(-pid, 'SIGKILL')` 整组击杀；原文照旧；`warn` 一次 |
| 输出为空 / 与输入相同 | 视为未压缩，原文照旧 |
| 输入超过 `maxInputBytes`（默认 4 MiB） | 不调 rtk，原文照旧 |
| I1/I2/I3 不过 | 原文照旧（`warn` 一次，带 reason） |
| 落盘失败且 `requireSpill` | 原文照旧 |
| 任何未预期异常 | 捕获后原文照旧；**绝不**抛给 waterfall、**绝不**置 `isError`、**绝不**替换 `value` |

`warn` 去重按 reason 各一次（进程级 Set），避免刷日志。

---

## 9. 配置

`schemastery` 定义的 `Config`，全部有默认值，零配置可用：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | `false` 时完全不注册监听器 |
| `command` | string | `'rtk'` | rtk 可执行文件；裸名走 PATH |
| `tools` | string[] | `['bash', 'job_output']` | 需要过滤的工具名 |
| `minBytes` | number | `2048` | 低于此字节数直接放行 |
| `maxInputBytes` | number | `4194304` | 超过则不调 rtk |
| `timeoutMs` | number | `10000` | rtk 超时 |
| `maxOutputBytes` | number | `8388608` | 捕获 stdout 上限 |
| `filters` | object | `{}` | 覆盖/扩展 `FAMILIES`（按 id 覆盖 `filter` 或启用/停用） |
| `spill` | boolean | `true` | 是否落盘全文 |
| `requireSpill` | boolean | `true` | 落盘失败时是否回退原文 |
| `notice` | boolean | `true` | 是否追加 notice 行 |
| `ultraCompact` | boolean | `false` | 透传 `--ultra-compact` 给 rtk |

---

## 10. 测试策略

**单测（`node:test`，纯函数，无需 cordis）**

- `markers`：各类标记末尾拆分/回填逐字节一致；正文中形似标记的行不被拆；无标记时 `tail === ''`。
- `sniff`：正例 4 个（本机真实语料）+ **负例 4 个**（`ls -la`、源码、JSON、无结构文本必须 `auto`）；
  边界（3 行 grep 不触发、`find` 阈值不误吃 `ls`）。
- `guards`：**全通过的 cargo/pytest 必须仍然允许压缩**（I2 恒真陷阱的回归测试）；
  失败运行丢失败行必须回退；I3 的两个分支；空输出/未变化。
- `rtk`：stub 可执行文件覆盖 —— 正常、非零退出、超时（挂起）、超大输出截断、取消（AbortSignal）。
- `spill`：注入假 `ctx.get('spillStore')`，覆盖成功、抛错、`spillStore` 缺失、会话 id 缺失。

**端到端（真 rtk 0.49.0）**：用本机已固定的 8 份语料断言压缩结果与回退行为；
stub rtk 二进制位于 `test/bin/rtk`（JS + shebang），通过临时 PATH 前置注入。

**验收标准（可执行、可复现）**

1. cargo test 语料：866 B → 约 38 B；pytest：2364 B → 约 17 B；grep：4729 B → 约 2425 B；
   git log：6202 B → 显著变小（走 `-f git-log`）。
2. 构造含 `test result: FAILED` 的 cargo 输出与含 `FAILED` 的 pytest 输出，压缩后失败行**逐字仍在**。
3. 非零退出命令的 `[exit code: 1]` 与超时命令的 `[timed out after …]` 在替换后逐字仍在。
4. 每一次替换都带 spill 指针；`read` 该 `locator` 取回的内容与原文**逐字节相同**。
5. 把 `command` 指向不存在的可执行文件后重跑：模型看到的输出与未装插件时**完全一致**。
6. `ls -la` / 源码 / JSON 三类输出**逐字节不变**（不发生替换）。

---

## 11. 安装与激活

1. 仓库即包：`package.json` 的 `main` 指向 `lib/index.js`，`dsh.bundle.patch` 指向 `cordis.patch.yml`。
2. 以 pnpm `file:` 依赖装进 profile（Desktop 的 profile 解析器会 canonicalize 路径，
   必须走 pnpm 而不是在 `node_modules` 手放符号链接）：

   ```sh
   cd "/Applications/DSH Desktop Beta.app/Contents/Resources/app"
   PNPM="<runtime-commands 下的 pnpm>"
   "$PNPM" --dir ~/.dsh/profiles/desktop add --ignore-scripts \
     "dsh-rtk-slim@file:/Users/cooper/Documents/Code/dsh-rtk-slim"
   ```

3. `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 追加 `dsh-rtk-slim`
   （bundle 自带的 `cordis.patch.yml` 负责 insert；按 profile 既有注释，**改 bundles 是热生效的**）。
4. 宿主半边代码默认**需重启** DSH Desktop 一次（Node ESM 缓存）；之后按 `~/.dsh/logs/dsh-rtk-slim.log`
   确认 `mounted`。
5. 验收：在本 GUI 里跑第 10 节的 6 条验收标准。

peer 声明照本地惯例（`dsh-memories` 同款）：`@deepseek-ai/dsh-tools` / `dsh-llm` / `cordis` / `schemastery`
用 `^0.2.0-rc.1` 系列；**devDependencies 精确钉 `@deepseek-ai/dsh-tools@0.2.1-alpha.2`**（npm alpha 通道
存在该版本且带 `.d.ts`），使类型检查与集成测试跑在与运行时相同的版本上。

---

## 12. 风险与对策

| 风险 | 对策 |
|---|---|
| rtk 升级改变 filter 语义（如 `git-log` 截断比例变化） | 固定语料回归测试；rtk 升级后重跑 e2e |
| DSH 后续版本改变 `tools/post-execute` 形状 | devDep 钉版本 + handler 只读 `decision.content ?? result.content`，形状变化时自然退化为"不压缩" |
| 家族误判导致内容被删 | 负例单测强制 `auto`；I2/I3 双保险；最坏情况仍可回退原文 |
| `-f git-log` 的截断是设计内损失（71 行 → 4 行） | 由 spill 指针兜底，随时可取回全文 |
| `spillStore` 在别的部署里不存在 | `requireSpill` 回退原文；文档写明如何放宽到"压缩但不落盘" |
| PTC（`run_code`）子调度 | 与前台同一处理：替换的只是模型可见副本，`value` 不动，程序侧不受影响 |

---

## 13. 已否决的替代方案

- **改写命令的 executor 路线**（`dsh-bash-rtk`）：见 §1，API 已漂移且覆盖率低。
- **多 filter 级联**：实测不匹配的 `-f` 会破坏内容，级联不可用。
- **只做提示词约定**（让我自觉写 `rtk git log`）：无自动收益，作为补充手段保留，不作为插件方案。
- **`-f` 全量强制**：会重现 `dsh-rtk-filter` 最危险的失败模式。
