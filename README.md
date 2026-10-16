# dsh-rtk-slim

DSH 宿主半边插件：把 `bash` / `job_output` 的超大输出交给 [rtk](https://github.com/rtk-ai/rtk)（Rust Token Killer）
精简后再交给模型，并且**每一次精简都可追溯、每一次失败都保留原文**。

## 它做了什么

- 挂在官方 `tools/post-execute` waterfall 上，**登记为最内层**（不加 `prepend`），因此看到的是原始结果；
  `dsh-spill-policy` 在外层，仍可对精简后的文本再落盘。
- 只改模型看到的 `content`，**从不动命令、不动 `value`、绝不把成功调用变成 `isError`**。
- 家族嗅探决定 rtk 参数：识别得出才用 `-f <filter>`（cargo-test / pytest / git-log / grep / find），
  识别不出走裸 `rtk pipe`（实测认不出即逐字节透传）。这避免了「`-f` 选错把内容删掉」的失败模式。
- 替换前过四道闸门：标记逐字保全、失败证据保全、压缩比合理、**必须严格变小**；任一不过就保留原文。
- 每次替换都把**全文**经官方 `ctx.spillStore` 落盘，并在文本末尾附一行
  `(rtk condensed A → B bytes. Full formatted result stored at: <path>. …)`。

## 实测效果（本机 rtk 0.49.0，语料见 `test/fixtures/`）

| 输入 | 原始 | 插件输出的正文 | 说明 |
|---|---|---|---|
| cargo test（40 用例） | 866 B | 约 38 B | `-f cargo-test` |
| pytest（30 用例） | 2313 B | 约 17 B | `-f pytest` |
| `grep -rn`（70 命中 / 4 文件） | 9104 B | 约 3220 B | `-f grep`（rtk 按文件分组） |
| `git log --oneline`（74 提交） | 6472 B | 约 373 B | `-f git-log`，rtk 自动省略中段 |
| `ls -la` / 源码 / JSON | — | 逐字节不变 | 落 `auto`，rtk 认不出即透传 |

## 安装

```sh
PNPM="/Users/cooper/Library/Application Support/DSH Desktop Beta/runtime-commands/generations/<gen>/bin/pnpm"
"$PNPM" --dir ~/.dsh/profiles/desktop add --ignore-scripts \
  "dsh-rtk-slim@file:/Users/cooper/Documents/Code/dsh-rtk-slim"
```

再把 `dsh-rtk-slim` 追加到该 profile `package.json` 的 `dsh.profile.bundles`，然后**重启宿主一次**。

> **实测（Desktop Beta 2.0.17）**：新增 bundle **不会**热挂载。两条路径都试过且都无效——
> ① 改 `dsh.profile.bundles`（等 21 s）；② 往 profile 的 `cordis.patch.yml` 追加 `insert`（等 6 s）：
> 命令输出始终原样返回。同期已排除解析层问题（两个 YAML 均可解析、`.package-map.json` 与
> `pnpm-lock.yaml` 均已登记、`import('dsh-rtk-slim')` 在 profile 下可加载、宿主进程 PATH 里
> `rtk` 可解析）。**装/卸插件请预留一次重启**；重启后 profile 侧配置即生效。

> **改了源码之后必须重新同步安装副本**：profile 里的 `file:` 依赖是**快照拷贝**（不是符号链接，
> 也不与仓库共享 inode），此时 `pnpm install` 与 `pnpm add`（含 `--force`）都会报
> `Already up to date` 而**不会**刷新。正确做法是先删后加（注意 `pnpm remove` 不接受
> `--ignore-scripts`，会报 `Unknown option`）：
>
> ```sh
> "$PNPM" --dir ~/.dsh/profiles/desktop remove dsh-rtk-slim
> "$PNPM" --dir ~/.dsh/profiles/desktop add --ignore-scripts \
>   "dsh-rtk-slim@file:/Users/cooper/Documents/Code/dsh-rtk-slim"
> ```
>
> 复核一致性：`diff -r lib ~/.dsh/profiles/desktop/node_modules/dsh-rtk-slim/lib`。


## 如何确认已激活

宿主不把 stdout 落盘，所以插件自己在挂载时写一行启动记录（这是唯一能回答"到底挂上没、生效配置是什么"的证据）：

```sh
tail -n 3 ~/.dsh/logs/dsh-rtk-slim.log
# 2026-10-16T04:35:12.345Z mounted pid=14813 enabled=true command=rtk tools=bash,job_output minBytes=2048 timeoutMs=10000 spill=true requireSpill=true notice=true ultraCompact=false filters={}
```

- 有 `mounted` 行 → 宿主确实加载了（`enabled=false` 也会留痕，便于区分"没挂上"与"挂了但被停用"）。
- 想快速停用而不卸载：在 profile 的 `cordis.patch.yml` 里给 `rtk-slim` 行加 `config: { enabled: false }`（同样需要重启宿主）。

## 配置（全部有默认值）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 时完全不注册监听器 |
| `command` | `'rtk'` | rtk 可执行文件（裸名走 PATH） |
| `tools` | `['bash','job_output']` | 需要过滤的工具名 |
| `minBytes` | `2048` | 低于此字节数放行（避免为小输出付一次 spawn） |
| `maxInputBytes` | `4194304` | 高于此字节数不调 rtk |
| `timeoutMs` | `10000` | rtk 超时（超时按进程组击杀） |
| `maxOutputBytes` | `8388608` | 捕获 stdout 上限 |
| `filters` | `{}` | 按家族 id 覆盖 filter 名，或传 `false` 停用某家族 |
| `spill` | `true` | 是否落盘全文 |
| `requireSpill` | `true` | 落盘失败时是否放弃替换（「有损必可追溯」） |
| `notice` | `true` | 是否追加 notice 行 |
| `ultraCompact` | `false` | 透传 `--ultra-compact` 给 rtk |

把 `requireSpill` 设为 `false` 即可放宽成「压缩但不落盘」。

## 排错与验证（实测，2026-10-16）

**宿主日志在这里**——`dsh-plugin-hot-load` skill 说"dsh web 的 stdout 不落盘"，但 Desktop 会把宿主日志写到：

```sh
tail -50 ~/Library/Application\ Support/DSH\ Desktop\ Beta/logs/host/dsh-$(date +%F).log
```

- 纯文本行（`[I]/[W]/[E]`）记 hmr 配置重载、包解析失败等；JSONL 行记 `host.tools` / `host.session` 事件。
- 实测样例：`[W] [hmr] config reload at …/package.json failed` → `duplicate loader entry id "memories" in the composed profile`。
  profile 处于**编辑中间态**时会这样（本次实测发生在 11:49–11:52 的外部改动期间），编辑落定后自愈——
  用下面的 dump 技巧确认即可，不要据此判定插件坏了。

**不重启也能验证"下次启动会不会挂上"**。Desktop profile 被 app 独占（`--dump-config` 会被拒绝：
`profile "desktop" is managed exclusively by the Electron application`），但**复制一份**就能用同一套组合逻辑验证：

```sh
cp -Rc ~/.dsh/profiles/desktop ~/.dsh/profiles/rtkcheck   # APFS clone，秒级
cd "/Applications/DSH Desktop Beta.app/Contents/Resources/app"
node node_modules/@deepseek-ai/dsh/lib/bin.js --profile rtkcheck --dump-config | grep -A3 rtk-slim
rm -rf ~/.dsh/profiles/rtkcheck                            # 验完删掉
```

**想在一个真实但一次性、隔离的宿主里验证挂载**（不碰你自己的会话/记忆/凭据）：

```sh
export DSH_HOME=/tmp/rtk-verify
node …/dsh/lib/bin.js --profile rtkcheck --from-default-profile headless --dump-config
"$PNPM" --dir $DSH_HOME/profiles/rtkcheck add --ignore-scripts "dsh-rtk-slim@file:/Users/cooper/Documents/Code/dsh-rtk-slim"
# 在该 profile 的 dsh.profile.bundles 里加上 dsh-rtk-slim，然后启动一次：
node …/dsh/lib/bin.js --profile rtkcheck headless "<任意任务>"
cat $DSH_HOME/logs/dsh-rtk-slim.log     # 出现 mounted 行 = 真实宿主加载成功
```

headless 模板自带的 base bundle 已含 `bash` / `job_output` / `spill-local` / `spill-policy`，所以插件全路径可用；
没有凭据时 LLM 调用会以 `MISSING_CREDENTIAL` 失败，但**插件挂载已经发生**——启动日志就是证据。

> 注意：每次 `pnpm add` 这个 `file:` 包都会触碰仓库内所有文件（store 拷贝），
> 因此编辑前若刚跑过 `pnpm add`，编辑器/工具会认为文件"已变更"，重读一次即可。

## 开发

```sh
npm install --ignore-scripts
npm run check                          # tsc --checkJs（仅 lib/）+ node --test test/*.test.mjs
node test/fixtures/make-fixtures.mjs   # 重新生成语料（确定性）
```

- 类型检查只覆盖 `lib/**`：那是「用运行时同版本类型校验插件契约」的落点。测试文件是动态桩，
  给它们加 JSDoc 注解既不增加安全性也会淹没真正的错误；测试的正确性由实跑 50 项保证。
- `lib/` 对 `@deepseek-ai/dsh-*` 的**运行时导入为 0**（只用 JSDoc `import type`）。所以 DSH 将来改 API，
  最坏后果是「不压缩」，而不是像覆写 executor 的插件那样加载即失败。
- 语料必须**忠实于真实输出**：例如 rtk 的 `grep` filter 按文件分组，语料若写成「每个文件 1 行命中」
  就不会被压缩（曾因此误判为代码 bug）。

## 设计文档与计划

- 设计（v3，两轮评审 Approved）：`docs/superpowers/specs/2026-10-16-dsh-rtk-slim-design.md`
- 实施计划：`docs/superpowers/plans/2026-10-16-dsh-rtk-slim-implementation.md`
