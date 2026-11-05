# dsh-purge 宿主补丁规则 × 0.2.2-rc.1 验证记录

日期：2026-11-05。对象：本机 `C:\Users\Example\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`
（桌面壳包 `@deepseek-ai/dsh-desktop`，`0.2.2-rc.1`，asar 内 `package.json` 的 `main` = `lib/main.js`）。
基线：本目录 `host-patch-audit-0.2.2.md` 的「修复后」列（0.2.2-alpha.2，`6/82 已清洗, 59 待清洗`）。

## 方法

```powershell
# 用 scripts/lib/asar.mjs 的 readArchive() 只解补丁会碰的文件（不动宿主 asar）
#   → %TEMP%\dsh-purge-audit-rc1\rc1-app
#   @deepseek-ai/<pkg>/lib/**、presets/**、cordis.patch.yml、package.json
#   @earendil-works/pi-ai/dist/api/*.js
#   桌面壳 lib/main.js
$env:DSH_SURFACE = "web"   # 与上一轮同口径；desktop 面门控的 5 条单独按 lib/main.js 核
$env:DSH_HOME = "C:\Users\Example\.dsh"   # 只读
$env:DSH_BASE = "$env:TEMP\dsh-purge-audit-rc1\rc1-app\dsh\node_modules\@deepseek-ai"
node packages\dsh-purge\bin\dsh-purge.js --status
```

逐条核对走 `lib/core.js` 导出 API（`targetFiles` / `ALL_PATCHES` / `patchStatus`），
锚点匹配逻辑与 `patchHasRemainingWork` / `patchApplied` 一致（`\r\n` 归一、YAML 无缩进 identity 跳过、RegExp）。
之后在内存里对 rc.1 树模拟全量 apply，再对 apply 后的影子树重跑 `patchStatus`。

`--status` 必须把 `DSH_BASE` 指到 `@deepseek-ai` 目录；指到解包根或 `rc1-app` 会报
「DSH_BASE 已设置但不是有效的插件根（需要其下有 dsh-agent-instructions/lib）」。

## rc.1 宿主清单（实测）

- `app.asar` 213,202,918 字节，LastWrite 2026-11-04 17:30；密封（`resources/app.asar` 是文件，不是目录）。
- asar 共 22,102 个条目；`dsh/node_modules/@deepseek-ai/` 下 331 个包，版本全部 `0.2.2-rc.1`。
- 桌面壳入口 `lib/main.js`（818.9 KB），同级 `lib/preload-app.cjs`、`renderer/`。
- pi-ai 在 `dsh/node_modules/@earendil-works/pi-ai/dist/api/`，`#47/#49/#57` 用的三个文件都在。
- 上一轮的目标键全部仍能解析；唯一缺的是用户 home 里的预设（见「环境差异」）。

## 结果（数字，对照上一轮基线）

| 口径 | rc.1 | 0.2.2-alpha.2（修复后基线） |
|---|---|---|
| `--status` 汇总 | **5/82 已清洗, 59 待清洗** | 6/82 已清洗, 59 待清洗 |
| pending | 59 | 59 |
| applied | 5 | 6 |
| skipped | 6 | 6 |
| missing_file | 1 | 0 |
| na（无目标 6 + 面门控 5） | 11 | 11 |

与基线唯一的数字差是 `#71 LIANGSHEN_IDENTITY_LINE`：本机 `C:\Users\Example\.dsh` 没有
`.agent-presets/liangshen`（alpha.2 基线的 mac 上有），目标缺失 → `missing_file`。这是本机环境差异，
不是宿主失配。`#24` 的目标数 4→3 同理（本机无 `preset-unrestricted`）。
其余 81 条的状态与锚点数与上一轮逐条一致。

## 失配逐条表

宿主面（web surface）真正失配只有 1 条：

| # | 规则 | 目标文件 | 失配原因 | 处置 |
|---|---|---|---|---|
| 17 | FS_OBSERVATION_INTENT_FREE | dsh-fs-observation-policy/lib/index.js | rc.1 把 `editIntent` 改成委托 `requirePresent(target, actor, "edit")`（`deleteIntent` 共用同一 helper）；`writeIntent` 锚点仍命中 | 已修：补 rc.1 editIntent 锚点变体，保留旧锚点 |

`#17` 值得单独说明：修复前 `writeIntent` 一条命中，规则在 `--status` 上仍是 `pending`（看起来正常），
但模拟 apply 后状态变成 **`skipped` 而不是 `applied`** —— 也就是 apply 完之后 edit 的 read-first 闸门
静默留着，面板却当成「跳过/已就绪」，不会再报错。这是「命中但覆盖不全」的假阳性。
修后锚点 2/3，apply 后 `applied`（writes/edits 两个 marker 都在）。

桌面壳（`surfaces: ["desktop"]`，目标 `resources/app.asar` 的 `lib/main.js`；web surface 下这 5 条照旧 `na`，
不影响上面的 5/82 数字）：

| # | 规则 | apply 前锚点 | apply 后状态 | 说明 | 处置 |
|---|---|---|---|---|---|
| 45 | OFFICIAL_DESKTOP_UPDATE_HANDOFF | 2/2 | applied | 0.2.2-alpha.2 的桌面壳去掉了 electron-updater；rc.1 桌面壳又内置 electron-updater + `quitAndInstall`，规则复活。调用点缩进 5 个 tab，4 tab 锚点按子串命中，替换后缩进仍是 5 tab | 不改（注释已更新） |
| 46 | OFFICIAL_DESKTOP_UPDATE_ASCII | 0/2 | applied | 链式：等 `#45` 落下换文后才命中；`#45` 现行换文本身已含 `dshPurgeWshLiteral` 与 ASCII 校验 | 不改 |
| 83 | DESKTOP_HOST_CLOSE_NO_FATAL | 1/1 | applied | rc.1 桌面壳恢复 `dsh-desktop-host` 子进程与 `exitPromise`/`close` 处理 | 不改（过时注释已更新） |
| 84 | DESKTOP_HOST_CLOSE_CODE0_NO_FAIL | 0/1 | applied | 链式：依赖 `#83` 的换文 | 不改 |
| 82 | DESKTOP_SHELL_PROFILE_FALLBACK | 0/1 | skipped | rc.1 桌面壳按 `DSH_HOME` 直接解析 `profiles/desktop`（`resolveProfileDir`），启动不再消费 `DSH_PROFILE`：全 asar 里只有 `dsh-shell-env` 把它当 tool-shell 运行时事实导出，"cannot determine the boot profile" 文本已消失；锚点里 home-paths region 的相邻行也变了 | **建议不改**：重新挂锚点只会写入一个不再被读取的 env，建议上游退役该规则 |

环境差异（与宿主版本无关，换机器会变）：

| # | 规则 | 现象 | 原因 |
|---|---|---|---|
| 71 | LIANGSHEN_IDENTITY_LINE | missing_file（alpha.2 基线 applied） | 本机 DSH_HOME 无 liangshen 预设 |
| 24 | PRESET_FETCH_ENABLED | 目标 4→3，仍 applied（marker 命中无需清洗） | 本机无 `preset-unrestricted`，`presets/` 下 standard / cordis / ptc 三个文件都在 |

## 本轮改动

- `packages/dsh-purge/lib/core.js`
  - `#17` 增加 1 条 0.2.2-rc.1 锚点变体（patterns 保留旧 `writeIntent` / 旧 `editIntent` 回退，不删旧版本支持），
    替换文本沿用原 marker：「[dsh-purge] observation bypass: edits are unconditional」。
  - `#45` / `#83` / `#82` 的注释按 rc.1 实测更新（仅注释，无逻辑改动）。
- 未改宿主 `app.asar`、未改 `~/.dsh`、未 Apply/未 Revert、未重启宿主；临时产物只在 `%TEMP%\dsh-purge-audit-rc1`。

## 验证

1. `node --check packages/dsh-purge/lib/core.js` 通过；`bin/dsh-purge.js --status` 在 rc.1 树跑通，得 `5/82 已清洗, 59 待清洗`。
2. 82 条锚点矩阵与上一轮文档的 alpha.2 列逐条 diff：只有 `#17`（宿主，已修）、`#71`/`#24`（本机环境）三行不同。
3. 全量 apply 模拟（内存执行，只写 `%TEMP%` 影子树）：59 条规则命中、改 50 个文件（40 JS + 10 YAML）、83 处；
   40 个 JS 全部 `node --check` 通过；10 个 YAML 用宿主自带 `yaml`（从 asar 解出的 `dsh/node_modules/yaml`）
   按 `!!js` 自定义标签解析通过。数字与 alpha.2 基线（59 条 / 50 文件 / 83 处 / 40 JS / 10 YAML）完全一致。
4. apply 后重跑 `patchStatus`：`0 pending`；`applied` 65（修复前 64，且 `#17` 为 `skipped`）→ `#17` 修复后真清洗。
5. 桌面壳链：内存对 `lib/main.js` 依次打 `#45→#46→#82→#83→#84`，`node --check` 通过；
   调用点 `dshPurgeHandoffDesktopUpdate(this)` 1 处、helper 定义 1 处、`dshPurgeWshLiteral` 6 处。
6. 已知无关噪音：`scripts/smoke.mjs` 在 Windows 仍因动态 import 绝对路径报
   `ERR_UNSUPPORTED_ESM_URL_SCHEME`（包自带老 bug，与本轮改动无关，未修）。
7. 局限：asar 密封时 `officialShellMain()` 解析不到 `lib/main.js`，所以桌面 5 条是按从 asar 解出的
   `lib/main.js` 直接核的，不是真实 desktop surface 上跑的 `--status`。

## 逐条矩阵（0.2.2-rc.1 实测）

「锚点」= 命中数/总数（多文件、多备选布局累加）；「0.2.2-alpha.2 锚点」取自
`host-patch-audit-0.2.2.md`。本机 DSH_HOME 与那轮 mac 环境不同，`#71/#24` 的总数差异来自用户预设缺失。

| # | 规则 | 目标键 | rc.1 锚点 | 0.2.2-alpha.2 锚点 | rc.1 状态 | 判定 |
|---|---|---|---|---|---|---|
| 1 | WORKSPACE_CONTEXT_INTRO | agent-instructions | 1/6 | 1/6 | pending | 有效 |
| 2 | REPLACEMENT_WORKSPACE_CONTEXT_INTRO | agent-instructions | 0/6 | 0/6 | applied | 宿主已是目标态/无需清洗 |
| 3 | SCOPE_INTRO | agent-instructions | 0/1 | 0/1 | applied | 宿主已是目标态/无需清洗 |
| 4 | SYSTEM_PROMPT_PERSONA | agent-preset,web-app,headless,preset-acp-app,preset-sdk-app | 4/5 | 4/5 | pending | 有效 |
| 43 | WEB_PRESET_IDENTITY_STRIP | preset-standard,preset-ptc,preset-cordis,preset-minimal | 4/12 | 4/12 | pending | 有效 |
| 76 | PRESET_UNRESTRICTED_IDENTITY_STRIP | — | — | — | na | 无目标（可选） |
| 70 | PRESET_SHELL_NETWORK | preset-minimal,preset-sdk-minimal | 2/4 | 2/4 | pending | 有效 |
| 73 | PRESET_BASH_MIRROR_LINE | preset-minimal,preset-sdk-minimal | 2/2 | 2/2 | pending | 有效 |
| 71 | LIANGSHEN_IDENTITY_LINE | — | — | 0/1 | missing_file | 环境差异：本机 DSH_HOME 无 liangshen preset |
| 5 | APPROVAL_NEVER_SENTENCE | user-approval | 1/1 | 1/1 | pending | 有效 |
| 6 | SANDBOX_DENY_FILE_WRITE | sandbox-local | 1/1 | 1/1 | pending | 有效 |
| 7 | SANDBOX_MODE_DEFAULT | base | 1/1 | 1/1 | pending | 有效 |
| 8 | APPROVAL_POLICY_DEFAULT | base | 1/1 | 1/1 | pending | 有效 |
| 9 | APPROVAL_AUTO_GRANT | user-approval-code,user-approval | 2/4 | 2/4 | pending | 有效 |
| 10 | APPROVAL_CONFIG_DEFAULT_NEVER | user-approval-code | 1/1 | 1/1 | pending | 有效 |
| 11 | APPROVAL_NEVER_SENTENCE_BYPASS | user-approval-code | 1/1 | 1/1 | pending | 有效 |
| 12 | APPROVAL_ASK_SENTENCE_BYPASS | user-approval-code,user-approval | 4/10 | 4/10 | pending | 有效 |
| 13 | ESCALATION_WIDENING_EXEMPT | escalation | 1/1 | 1/1 | pending | 有效 |
| 14 | ESCALATION_GRANT_UNCONDITIONAL | escalation | 1/3 | 1/3 | pending | 有效 |
| 15 | SANDBOX_CONFINE_PASSTHROUGH | sandbox-local | 1/2 | 1/2 | pending | 有效 |
| 16 | FS_FENCE_DISABLED | fs-sandbox | 1/1 | 1/1 | pending | 有效 |
| 17 | FS_OBSERVATION_INTENT_FREE | fs-observation-policy | 2/3 | 2/2 | pending | 已修正（补 rc.1 editIntent 锚点） |
| 18 | REPEAT_TOOL_REMINDER_DISABLED | repeat-tool-reminder | 1/1 | 1/1 | pending | 有效 |
| 19 | TOOL_RESULT_PRUNER_DISABLED | compaction-tool-result-pruner | 1/1 | 1/1 | pending | 有效 |
| 21 | BASH_TIMEOUT_RESTORE | base | 0/1 | 0/1 | applied | 宿主已是目标态/无需清洗 |
| 22 | READ_CAPS_RAISED | tool-fs | 3/3 | 3/3 | pending | 有效 |
| 23 | SUBAGENT_MAXDEPTH_RAISED | subagent,tool-subagent | 2/6 | 2/6 | pending | 有效 |
| 24 | PRESET_FETCH_ENABLED | preset-standard,preset-cordis,preset-ptc | 0/3 | 0/4 | applied | 环境差异：本机无 preset-unrestricted（目标数 4→3） |
| 25 | HARNESS_IDENTITY_STRIP | system-prompt | 3/3 | 3/3 | pending | 有效 |
| 26 | MINIMAL_PERSONA_PURGE | preset-minimal,preset-sdk-minimal | 1/8 | 1/8 | pending | 有效 |
| 80 | MINIMAL_OFFICIAL_TOOLSET | preset-minimal,preset-sdk-minimal | 0/8 | 0/8 | skipped | 既有失效（alpha.2 同样 0 命中） |
| 28 | LIANGSHEN_PHASE1_KEEP_INJECT | — | — | — | na | 无目标（可选） |
| 32 | WEB_SURFACE_IDENTITY_NEUTRAL | web-app-lib | 0/2 | 0/2 | skipped | 既有失效（alpha.2 同样 0 命中） |
| 29 | TOOL_WEB_UNTRUSTED_NEUTRAL | tool-web | 3/5 | 3/5 | pending | 有效 |
| 30 | HOOKS_CLAUDE_DENY_ALLOW | — | — | — | na | 无目标（可选） |
| 31 | HOOKS_CODEX_DENY_ALLOW | — | — | — | na | 无目标（可选） |
| 33 | TOOL_SHELL_DENIAL_PROMPT | tool-bash,tool-pwsh | 7/22 | 7/22 | pending | 有效 |
| 34 | SANDBOX_HINT_NEUTRAL | escalation | 2/2 | 2/2 | pending | 有效 |
| 35 | ESCALATION_NEVER_REJECT | escalation | 1/2 | 1/2 | pending | 有效 |
| 36 | TOOL_FS_ESCALATION_SCHEMA | tool-fs,escalation | 2/8 | 2/8 | pending | 有效 |
| 37 | SUBAGENT_SCOPE_LOCK_NEUTRAL | subagent,subagent-types | 2/4 | 2/4 | pending | 有效 |
| 38 | PERSONA_TEXT_PREFIX_ALIAS | persona | 2/2 | 2/2 | pending | 有效 |
| 39 | SESSION_V0_PLUGIN_SUMMARY_ALIAS | session-format-v0 | 1/1 | 1/1 | pending | 有效 |
| 40 | COMPLETE_PROMPT_KEEP_INJECT | system-prompt | 0/7 | 0/7 | skipped | 既有失效（0.2.2 前已死，未修） |
| 42 | SETTINGS_LEGACY_API | settings | 8/12 | 8/12 | pending | 有效 |
| 45 | OFFICIAL_DESKTOP_UPDATE_HANDOFF | —（desktop 面门控） | — | — | na | desktop 面门控（asar 密封时不判） |
| 46 | OFFICIAL_DESKTOP_UPDATE_ASCII | —（desktop 面门控） | — | — | na | desktop 面门控（asar 密封时不判） |
| 47 | ANTHROPIC_OAUTH_NO_CLAUDE_IDENTITY | pi-ai-anthropic-messages | 1/2 | 1/2 | pending | 有效 |
| 48 | TOOL_SHELL_DELETE_MOVE_NEUTRAL | tool-bash,tool-pwsh | 2/2 | 2/2 | pending | 有效 |
| 49 | ANTHROPIC_OAUTH_CLI_NEUTRAL | pi-ai-anthropic-messages | 3/3 | 3/3 | pending | 有效 |
| 50 | SESSION_REFERENCE_FRAMING_NEUTRAL | session-reference | 0/9 | 0/9 | applied | 宿主已是目标态/无需清洗 |
| 51 | FRESH_SESSION_FULL_ACCESS | permission-presets,permission-presets-types | 4/4 | 4/4 | pending | 有效 |
| 52 | SESSION_LOG_UPLOAD_DEFAULT_OFF | session-log-deepseek,session-log-deepseek-types | 2/4 | 2/4 | pending | 有效 |
| 53 | WEB_SURFACE_PROHIBITION | web-app-lib | 0/2 | 0/2 | skipped | 既有失效（alpha.2 同样 0 命中） |
| 54 | DELIVERABLE_DO_NOT | deliverables-prompt | 2/4 | 2/4 | pending | 有效 |
| 55 | SYSTEM_PROMPT_REPLACE_HEAD | agent-loop | 1/1 | 1/1 | pending | 有效 |
| 74 | ASSEMBLE_BEFORE_PRESTEP | agent-loop | 1/2 | 1/2 | pending | 有效 |
| 66 | SYSTEM_PROMPT_RENDER_GUARD | system-prompt | 3/3 | 3/3 | pending | 有效 |
| 83 | DESKTOP_HOST_CLOSE_NO_FATAL | —（desktop 面门控） | — | — | na | desktop 面门控（asar 密封时不判） |
| 84 | DESKTOP_HOST_CLOSE_CODE0_NO_FAIL | —（desktop 面门控） | — | — | na | desktop 面门控（asar 密封时不判） |
| 67 | AGENT_LOOP_MESSAGES_GUARD | agent-loop | 1/2 | 1/2 | pending | 有效 |
| 68 | SYSTEM_NODES_CONTENT_GUARD | agent-loop,session | 3/8 | 3/8 | pending | 有效 |
| 69 | MODEL_STREAM_RELEASE | llm-deepseek | 1/3 | 1/3 | pending | 有效 |
| 72 | MESSAGES_SYSTEM_CURRENT | llm-deepseek | 1/1 | 1/1 | pending | 有效 |
| 56 | REWIND_HIDE_CUT_ONLY | conversation-client | 2/4 | 2/4 | pending | 有效 |
| 77 | REWIND_DROP_SENT_ON_APPEND | conversation-client | 0/1 | 0/1 | skipped | 既有失效（alpha.2 同样 0 命中） |
| 75 | REWIND_RESET_TODOS | tool-todo | 1/1 | 1/1 | pending | 有效 |
| 57 | DEEPSEEK_SYSTEM_ROLE | pi-ai-completions,pi-ai-responses-shared | 1/12 | 1/12 | pending | 有效 |
| 58 | REWIND_SKIP_DERIVE | session | 1/1 | 1/1 | pending | 有效 |
| 59 | OFFICIAL_AUTO_REVIEW_PASSTHROUGH | auto-review | 1/1 | 1/1 | pending | 有效 |
| 60 | OFFICIAL_RUN_CODE_APPROVAL_NEUTRAL | dsh-tools,tool-executor-ptc,tool-executor-ptc-types | 8/12 | 8/12 | pending | 有效 |
| 61 | OFFICIAL_SANDBOX_POLICY_NEUTRAL | sandbox-policy | 1/1 | 1/1 | pending | 有效 |
| 62 | OFFICIAL_TOOL_ASK_FAILOPEN | dsh-tools,dsh-tools-types | 3/24 | 3/24 | pending | 有效 |
| 63 | OFFICIAL_PLAN_MODE_NEUTRAL | base,preset-ptc,preset-standard,preset-cordis | 12/12 | 12/12 | pending | 有效 |
| 64 | HOOKS_STOP_STEER_NEUTRAL | — | — | — | na | 无目标（可选） |
| 65 | HOOKS_PRESTEP_REJECT_NEUTRAL | — | — | — | na | 无目标（可选） |
| 78 | OVERLAY_RESTORE_FROM_BAK | app-boot | 1/1 | 1/1 | pending | 有效 |
| 82 | DESKTOP_SHELL_PROFILE_FALLBACK | —（desktop 面门控） | — | — | na | desktop 面门控（asar 密封时不判） |
| 85 | SESSION_PROMPT_ALWAYS_FOLLOWUP | api-session-controller | 1/1 | 1/1 | pending | 有效 |
| 86 | SESSION_STEER_ALWAYS_FOLLOWUP | api-session-controller,agent-loop | 2/6 | 2/6 | pending | 有效 |
| 87 | HUNG_PROMPT_LF_NEEDLE | agent-loop | 1/8 | 1/8 | pending | 有效 |
| 88 | HUNG_PROMPT_STRICT_NEEDLE | agent-loop | 0/4 | 0/4 | skipped | 既有失效（alpha.2 同样 0 命中） |
