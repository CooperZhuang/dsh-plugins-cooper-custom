# dsh-rtk-slim

DSH（DeepSeek Harness）宿主插件：把 `bash` / `job_output` 的超大输出交给
[rtk](https://github.com/rtk-ai/rtk)（Rust Token Killer）精简后再交给模型，并且**每一次精简都可追溯、
每一次失败都保留原文**。

## 功能

- 挂在官方 `tools/post-execute` waterfall 上，**登记为最内层**（不加 `prepend`），因此看到的是原始结果；
  `dsh-spill-policy` 在外层，仍可对精简后的文本再落盘。
- 只改模型看到的 `content`，**从不动命令、不动 `value`、绝不把成功调用变成 `isError`**。
- 家族嗅探决定 rtk 参数：识别得出才用 `-f <filter>`（cargo-test / pytest / git-log / grep / find），
  识别不出走裸 `rtk pipe`（rtk 对认不出的内容逐字节透传）。这避免了「`-f` 选错把内容删掉」的失败模式。
- 替换前过四道闸门：标记逐字保全、失败证据保全、压缩比合理、**必须严格变小**；任一不过就保留原文。
- 每次替换都把**全文**经官方 `ctx.spillStore` 落盘，并在文本末尾附一行
  `(rtk condensed A → B bytes. Full formatted result stored at: <path>. …)`，
  模型随时可以按路径取回原文。
- 同一进程内同类失败只告警一次（不刷屏）；宿主日志里能分清「没挂上」「挂了但被停用」「挂了但 rtk 不可用」。

## 依赖：外部 `rtk` 二进制

**本插件不捆绑 rtk。** 精简能力来自外部命令行程序 rtk：

- 上游仓库：<https://github.com/rtk-ai/rtk>（按上游说明自行安装）；
- 安装完成后确认 `rtk` 在宿主进程的 `PATH` 里：

  ```sh
  rtk --version          # 能打印版本即可
  ```

- 不在 `PATH` 或想用别的路径时，用配置项 `command`（默认 `'rtk'`）指定绝对路径。

平台要求：只要 DSH 宿主与 `rtk` 能在同一平台运行即可（macOS / Linux / Windows 均可）；
插件按平台处理子进程的超时与取消（POSIX 杀进程组，Windows 用 `taskkill /T`）。

### rtk 缺失 / 不可用时的行为

**不生效，但绝不影响原有结果**：

- 启动 `rtk` 失败（未安装、不在 `PATH`、权限不足）→ 插件放弃压缩，模型看到的内容与**完全没装本插件时一致**，
  宿主日志留一条 `rtk-slim: rtk:spawn: rtk did not condense bash output` 告警（每个进程只告警一次）。
- rtk 崩溃（非 0 退出）、超时（默认 10 s）、输出超限或调用被取消 → 同样保留原文，日志记录对应原因。
- 全文落盘失败且 `requireSpill` 为 `true`（默认）→ 放弃替换、保留原文（「有损必可追溯」）。

这些降级路径都有自动化测试覆盖；rtk 存在但内容本身压缩不了时，插件同样原样放行。

## 安装

```sh
dsh plugin --profile <profile> add dsh-rtk-slim
```

把 `<profile>` 换成目标 profile（例如桌面版 `desktop`、`dsh web` 用 `web`）。
安装后**重启一次宿主**最稳妥（bundle 是否支持热挂载取决于宿主版本）；重启后按下一节确认已激活。

从源码安装：

```sh
git clone https://github.com/CooperZhuang/dsh-plugins-cooper-custom.git
dsh plugin --profile <profile> add ./dsh-plugins-cooper-custom/packages/dsh-rtk-slim
```

### 卸载

```sh
dsh plugin --profile <profile> remove dsh-rtk-slim
```

删除后重启宿主一次。

## 如何确认已激活

插件在挂载时写一行启动记录（宿主本身不把插件激活写进磁盘，这是最直接的证据）：

```sh
tail -n 3 "${DSH_HOME:-$HOME/.dsh}/logs/dsh-rtk-slim.log"
# 2026-10-16T04:35:12.345Z mounted pid=14813 enabled=true command=rtk tools=bash,job_output minBytes=2048 timeoutMs=10000 spill=true requireSpill=true notice=true ultraCompact=false filters={}
```

- 有 `mounted` 行 → 宿主确实加载了（`enabled=false` 也会留痕，便于区分「没挂上」与「挂了但被停用」）。
- 想快速停用而不卸载：在 profile 的 `cordis.patch.yml` 里给 `rtk-slim` 行加 `config: { enabled: false }`
  （同样需要重启宿主）。

## 配置（全部有默认值）

配置写在 profile 的补丁层里（`dsh plugin add` 会接入本包自带的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: rtk-slim
      name: dsh-rtk-slim
      config:
        enabled: true
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 时完全不注册监听器 |
| `command` | `'rtk'` | rtk 可执行文件（裸名走 PATH） |
| `tools` | `['bash','job_output']` | 需要过滤的工具名 |
| `minBytes` | `2048` | 低于此字节数放行（避免为小输出付一次 spawn） |
| `maxInputBytes` | `4194304` | 高于此字节数不调 rtk |
| `timeoutMs` | `10000` | rtk 超时（超时按进程组击杀整个进程树） |
| `maxOutputBytes` | `8388608` | 捕获 stdout 上限 |
| `filters` | `{}` | 按家族 id 覆盖 filter 名，或传 `false` 停用某家族 |
| `spill` | `true` | 是否落盘全文 |
| `requireSpill` | `true` | 落盘失败时是否放弃替换（「有损必可追溯」） |
| `notice` | `true` | 是否追加 notice 行 |
| `ultraCompact` | `false` | 透传 `--ultra-compact` 给 rtk |

把 `requireSpill` 设为 `false` 即可放宽成「压缩但不落盘」。

## 兼容性

- **DSH**：`engines.dsh: ^0.2.1-rc.2 || ^0.2.2-alpha.2`。
- **Node.js**：`>=24`。
- **rtk**：不依赖特定版本；`rtk --version` 能跑即可（下表数字在 rtk 1.1.0 上测得）。

本插件碰到的内核面只有三处：

- `tools/post-execute` waterfall（`dsh-tools`）：`exec` / `result` / `next()` 签名、
  `PostToolDecision` 的两种 `accept` 形态（`content` 与 `value`）以及 `additionalContexts` 透传；
  `next()` 的兜底仍是 `{kind:'accept'}`（不带 `content`），所以本插件拿到的仍是**原始**文本。
- `ctx.get('spillStore')`（`dsh-spill`）：`saveText({owner, source, suggestedName, content})` →
  `{locator, bytes, retrievalHint}`。归属取 `exec.agent.session.header.id`。
- 插件契约：`export const name / inject / Config / apply`（cordis 的 object plugin）、
  `dsh.bundle.patch` 清单字段、`cordis.patch.yml` 的 `insert` 行格式。

`src/` 对 `@deepseek-ai/dsh-*` 的**运行时导入为 0**（只用 TypeScript `import type`，编译后擦除）。所以 DSH 将来改 API，
最坏后果是「不压缩」，而不是加载即失败。

## 评测（真实 rtk，`test/fixtures/` 语料）

`minBytes: 512`，rtk 1.1.0，数字为字节数；输入含末尾的 `[exit code: 0]` 状态标记：

| 输入 | 压缩前 | 压缩后正文 | filter |
|---|---|---|---|
| `git log --oneline`（74 提交） | 4120 B | **247 B** | `-f git-log` |
| pytest（30 用例） | 2327 B | **26 B** | `-f pytest` |
| cargo test 通过（40 用例） | 880 B | 38 B | `-f cargo-test` |
| cargo test 失败（40 用例） | 888 B | **98 B** | `-f cargo-test`（失败行保留） |
| `grep -rn`（70 命中 / 4 文件） | 7718 B | **3138 B** | `-f grep`（rtk 按文件分组） |
| `ls -la` | 2253 B | 逐字节不变 | 落 `auto` 透传 |
| 源码 / JSON | — | 逐字节不变 | 落 `auto` 透传 |

数字只作量级参考：随 rtk 版本与输入变化，插件不依赖具体数值；默认 `minBytes: 2048` 时
低于门槛的输入（如上面 880 B 的 cargo 通过）不会调用 rtk。

## 排错

- **先看启动记录**：`${DSH_HOME:-$HOME/.dsh}/logs/dsh-rtk-slim.log` 的 `mounted` 行（见「如何确认已激活」）。
- **宿主日志**：DSH Desktop 把宿主日志写在应用数据目录的 `logs/host/dsh-<date>.log`
  （macOS 为 `~/Library/Application Support/DSH Desktop/logs/host/`）。纯文本行（`[I]/[W]/[E]`）
  记配置重载、包解析失败等；`rtk-slim:*` 的告警也在这里。
- **只想验证「下次启动会不会挂上」而不重启**：Desktop profile 被应用独占，`--dump-config` 会被拒绝时，
  可以复制一份 profile 用同一套组合逻辑验证：

  ```sh
  cp -Rc ~/.dsh/profiles/desktop ~/.dsh/profiles/rtkcheck   # APFS clone，秒级
  node .../dsh/lib/bin.js --profile rtkcheck --dump-config | grep -A3 rtk-slim
  rm -rf ~/.dsh/profiles/rtkcheck                            # 验完删掉
  ```

- **想在一个一次性的隔离宿主里验证挂载**（不碰自己的会话/记忆/凭据）：

  ```sh
  export DSH_HOME=/tmp/rtk-verify
  node .../dsh/lib/bin.js --profile rtkcheck --from-default-profile headless --dump-config
  ```

  headless 模板自带的 base bundle 已含 `bash` / `job_output` / `spill-local` / `spill-policy`，插件全路径可用；
  没有凭据时 LLM 调用会失败，但**插件挂载已经发生**——启动日志就是证据。

## 开发

```sh
npm install --ignore-scripts
npm run build                          # tsc -p tsconfig.json：src/ -> lib/（含 lib/types/）
npm test                               # 先 build，再 node --test test/*.test.mjs
npm run typecheck                      # tsc -p tsconfig.json --noEmit（仅 src/）
npm run check                          # 两者都跑
node test/fixtures/make-fixtures.mjs   # 重新生成语料（确定性）
```

- 宿主半边源码是 `src/**` 下的 TypeScript，`lib/` 是 `tsc` 产物（随仓库一起提交，装好即可用）；测试仍从
  `../lib/*.js` 导入，所以跑测试前必须先 build（`npm test` 已经代劳）。
- 端到端用例会调用**真实 rtk**：`rtk` 不在 `PATH` 时自动跳过；装在非标准路径时用
  `RTK_BIN=/path/to/rtk npm test` 指定。其余用例用 `test/bin/rtk-stub.mjs`，不依赖外部程序。
- 类型检查只覆盖 `src/**`：那是「用运行时同版本类型校验插件契约」的落点；测试文件是动态桩。
- 语料必须**忠实于真实输出**：例如 rtk 的 `grep` filter 按文件分组，语料若写成「每个文件 1 行命中」
  就不会被压缩（曾因此误判为代码 bug）。

## 设计文档

- 设计（v3）：[docs/superpowers/specs/2026-10-16-dsh-rtk-slim-design.md](https://github.com/CooperZhuang/dsh-plugins-cooper-custom/blob/main/packages/dsh-rtk-slim/docs/superpowers/specs/2026-10-16-dsh-rtk-slim-design.md)
- 实施计划：[docs/superpowers/plans/2026-10-16-dsh-rtk-slim-implementation.md](https://github.com/CooperZhuang/dsh-plugins-cooper-custom/blob/main/packages/dsh-rtk-slim/docs/superpowers/plans/2026-10-16-dsh-rtk-slim-implementation.md)

## License

MIT
