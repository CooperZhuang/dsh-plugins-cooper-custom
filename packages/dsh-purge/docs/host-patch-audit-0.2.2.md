# dsh-purge 宿主补丁规则 × 0.2.2-alpha.2 验证记录

日期：2026-10-31。对象：本机 `/Applications/DSH Desktop Beta.app`（CFBundle `2.0.21-beta.1`，内核 `0.2.2-alpha.2`）。
基线对照：`/Applications/DeepSeek Harness.app`（`0.2.1-rc.5`，即 `dshTarget` 0.2.1 时代最近的可执行样本）。

## 方法

```bash
# 解包（scripts/lib/asar.mjs，保留 asar 内相对路径）
node /tmp/asar-extract.mjs      # → /tmp/dsh-host-0.2.2（22400 个文件；3200 个 unpacked 条目未解）
node /tmp/asar-extract2.mjs     # 0.2.1-rc.5 → /tmp/dsh-host-0.2.1

# --status 必须把 DSH_BASE 指到 @deepseek-ai 目录，而不是解包根：
DSH_BASE=/tmp/dsh-host-0.2.2/node_modules/@deepseek-ai \
  node packages/dsh-purge/bin/dsh-purge.js --status
# 指到 /tmp/dsh-host-0.2.2 会得到：
#   DSH_BASE 已设置但不是有效的插件根（需要其下有 dsh-agent-instructions/lib）
```

逐条核对用一个一次性脚本（`lib/core.js` 的 `targetFiles` / `ALL_PATCHES` / `patchStatus` 全部走导出 API）：
解析每条规则的目标文件，逐个 replacement 统计锚点命中（匹配逻辑与 `patchApplied` / `patchHasRemainingWork` 一致），
再对 0.2.1-rc.5 跑同一份矩阵做对照，用来区分「0.2.2 回归」和「本来就没命中」。

`applied` 状态对 `softSettle` / 布局软补丁表示「宿主已是目标态或不需要清洗」，不等于真的打过补丁；
真正的成功判据是「目标文件存在 + 锚点命中（pending）」。

## 结果

| | 全命中 | 备选布局命中 | 已修正 | 无需清洗 | 无目标(可选) | 面门控 | 既有失效 | 仍失效 |
|---|---|---|---|---|---|---|---|---|
| 修复前 | 30 | 22 | — | 6 | 6 | 5 | 5 | 8 |
| 修复后 | 30 | 22 | 7 | 6 | 6 | 5 | 5 | 1 |

`--status` 汇总（0.2.2-alpha.2）：修复前 `7/82 已清洗, 52 待清洗` → 修复后 `6/82 已清洗, 59 待清洗`。
变化的 7 行：`#12 #14 #54 #60 #62 #67 #74` 从 applied/skipped 变为 pending（锚点命中）。

0.2.1-rc.5 基线：修复前 `6/82 已清洗, 60 待清洗`，修复后同值 — 补的 0.2.2 变体没有破坏 0.2.1 路径。

## 0.2.2 回归的 11 条规则

核心/Web 8 条（0.2.1 能命中，0.2.2 全失配）：

| # | 规则 | 失配原因 | 处理 |
|---|---|---|---|
| 12 | APPROVAL_ASK_SENTENCE_BYPASS | ask 句重写为 "Approval prompts are enabled in this session: ..." | 已补 3 变体（裸句/双引号/单引号常量） |
| 14 | ESCALATION_GRANT_UNCONDITIONAL | `displayReason` 从对象字面量改成 `escalationDisplayReason(mode, justification)` | 已补 0.2.2 锚点变体 |
| 54 | DELIVERABLE_DO_NOT | 提示词文本从 `dsh-client-ui-deliverables` 迁到 `dsh-deliverable-file-references` | 已补路径候选 |
| 60 | OFFICIAL_RUN_CODE_APPROVAL_NEUTRAL | run_code 工具迁到独立包 `dsh-tool-executor-ptc` | 已补路径键 |
| 62 | OFFICIAL_TOOL_ASK_FAILOPEN | `serviceAsk` 实现落在 `dsh-tools/lib/pipeline.js` + `lib/types/pipeline.js`；`undefined`→`void 0`、一处 case 合并成单行 | 已补路径 + 2 个锚点变体 |
| 67 | AGENT_LOOP_MESSAGES_GUARD | 两行缩进 4 → 5 个 tab | 已补 5-tab 变体 |
| 74 | ASSEMBLE_BEFORE_PRESTEP | assemble 改成对象参数，claim 后面多了 selection/toolSet | 已补锚点变体（落在 claim 之后） |
| 40 | COMPLETE_PROMPT_KEEP_INJECT | 0.1.5 兼容层：system-prompt assemble 重写（新增 tools 返回值 / requiredContexts） | 未修。需按新结构重写或退役，规则保持 inert |

桌面壳 3 条（`surfaces: ["desktop"]`，目标 `lib/main.js`）：

| # | 规则 | 失配原因 | 处理 |
|---|---|---|---|
| 45 | OFFICIAL_DESKTOP_UPDATE_HANDOFF | 2.0.21-beta.1 桌面壳没有 updater/`quitAndInstall`（全树找不到） | 无法修；已 optional |
| 82 | DESKTOP_SHELL_PROFILE_FALLBACK | 新架构用 `loadNextProfile` / `NextDesktopRuntime`，全树无 `DSH_PROFILE` | 无法修；已 optional |
| 83 | DESKTOP_HOST_CLOSE_NO_FATAL | 宿主启动改到 `lib/host.js`，`DesktopHostProcess` close 处理不存在 | 无法修；本轮标 optional，避免永远 `pattern_not_found` |

## 既有失效（0.2.1-rc.5 同样 0 命中，5 条，全部 optional）

`#80 MINIMAL_OFFICIAL_TOOLSET`、`#32 WEB_SURFACE_IDENTITY_NEUTRAL`、`#53 WEB_SURFACE_PROHIBITION`、
`#77 REWIND_DROP_SENT_ON_APPEND`、`#88 HUNG_PROMPT_STRICT_NEEDLE`。
另 `#46 OFFICIAL_DESKTOP_UPDATE_ASCII`、`#84 DESKTOP_HOST_CLOSE_CODE0_NO_FAIL` 在桌面壳上也是 0.2.1 就失配。
这些不是 0.2.2 引入的问题，本轮不动。

## 无目标（6 条，与宿主版本无关）

`#76`（unrestricted 预设不随宿主发布，两版都没有）、`#28`（liangshen 插件布局没有 `tool-bootstrap.mjs`）、
`#30/#31/#64/#65`（hooks 包不在 0.2.1/0.2.2 宿主里）。用户装对应包后才会出现。

## 验证

- **模拟全量 apply**（在 /tmp 副本上内存执行，不落盘到宿主）：59 条规则命中并改动 50 个文件、83 处；
  其中 40 个 JS 文件全部通过 `node --check`；10 个 YAML 用宿主自带的 `yaml@2.9` 解析通过（`!!js` 按自定义标签处理）。
- **0.2.1 回归**：同上 60 pending / 6 applied / 5 skipped，修复前后一致。
- 未执行 `--apply` / `--revert`，未启用插件，未改 `~/.dsh/profiles`；改动只写在 `/tmp` 与本包目录。

## 逐条矩阵（0.2.2 实测）

"锚点" 为命中数/总数（多文件、多备选布局会累加）。

| # | 规则 | 层 | 目标文件 | 0.2.2 锚点 | 0.2.1 锚点 | 状态 | 判定 |
|---|---|---|---|---|---|---|---|
| 1 | WORKSPACE_CONTEXT_INTRO | 提示词 | dsh-agent-instructions/lib/index.js | 1/6 | 1/6 | pending | 有效(备选布局) — 1/6 命中（多版本备选，0.2.1 相同） |
| 2 | REPLACEMENT_WORKSPACE_CONTEXT_INTRO | 提示词 | dsh-agent-instructions/lib/index.js | 0/6 | 0/6 | applied | 无需清洗 — marker/软settle 命中，宿主已是目标态 |
| 3 | SCOPE_INTRO | 提示词 | dsh-agent-instructions/lib/index.js | 0/1 | 0/1 | applied | 无需清洗 — marker/软settle 命中，宿主已是目标态 |
| 4 | SYSTEM_PROMPT_PERSONA | 提示词 | dsh-web-app/presets/standard.patch.yml | 4/5 | 4/5 | pending | 有效(备选布局) — 4/5 命中（多版本备选，0.2.1 相同） |
| 43 | WEB_PRESET_IDENTITY_STRIP | 提示词 | dsh-web-app/presets/standard.patch.yml | 4/12 | 4/12 | pending | 有效(备选布局) — 4/12 命中（多版本备选，0.2.1 相同） |
| 76 | PRESET_UNRESTRICTED_IDENTITY_STRIP | 提示词 | — | — | — | na | 无目标(可选) — key: preset-unrestricted |
| 70 | PRESET_SHELL_NETWORK | 提示词 | dsh-web-app/presets/minimal.patch.yml | 2/4 | 2/4 | pending | 有效(备选布局) — 2/4 命中（多版本备选，0.2.1 相同） |
| 73 | PRESET_BASH_MIRROR_LINE | 提示词 | dsh-web-app/presets/minimal.patch.yml | 2/2 | 2/2 | pending | 有效 |
| 71 | LIANGSHEN_IDENTITY_LINE | 提示词 | ~/.dsh/.agent-presets/liangshen/agent.cordis.yml | 0/1 | 0/1 | applied | 无需清洗 — marker/软settle 命中，宿主已是目标态 |
| 5 | APPROVAL_NEVER_SENTENCE | 提示词 | dsh-user-approval/lib/types/index.js | 1/1 | 1/1 | pending | 有效 |
| 6 | SANDBOX_DENY_FILE_WRITE | 代码 | dsh-sandbox-local/lib/index.js | 1/1 | 1/1 | pending | 有效 |
| 7 | SANDBOX_MODE_DEFAULT | 代码 | dsh-base/cordis.patch.yml | 1/1 | 1/1 | pending | 有效 |
| 8 | APPROVAL_POLICY_DEFAULT | 代码 | dsh-base/cordis.patch.yml | 1/1 | 1/1 | pending | 有效 |
| 9 | APPROVAL_AUTO_GRANT | 代码 | dsh-user-approval/lib/index.js | 2/4 | 2/4 | pending | 有效(备选布局) — 2/4 命中（多版本备选，0.2.1 相同） |
| 10 | APPROVAL_CONFIG_DEFAULT_NEVER | 代码 | dsh-user-approval/lib/index.js | 1/1 | 1/1 | pending | 有效 |
| 11 | APPROVAL_NEVER_SENTENCE_BYPASS | 提示词 | dsh-user-approval/lib/index.js | 1/1 | 1/1 | pending | 有效 |
| 12 | APPROVAL_ASK_SENTENCE_BYPASS | 提示词 | dsh-user-approval/lib/index.js | 4/10 | 3/10 | pending | 已修正 — 补 0.2.2 锚点/路径 |
| 13 | ESCALATION_WIDENING_EXEMPT | 代码 | dsh-sandbox/lib/index.js | 1/1 | 1/1 | pending | 有效 |
| 14 | ESCALATION_GRANT_UNCONDITIONAL | 代码 | dsh-sandbox/lib/index.js | 1/3 | 1/3 | pending | 已修正 — 补 0.2.2 锚点/路径 |
| 15 | SANDBOX_CONFINE_PASSTHROUGH | 代码 | dsh-sandbox-local/lib/index.js | 1/2 | 1/2 | pending | 有效(备选布局) — 1/2 命中（多版本备选，0.2.1 相同） |
| 16 | FS_FENCE_DISABLED | 代码 | dsh-fs-sandbox/lib/index.js | 1/1 | 1/1 | pending | 有效 |
| 17 | FS_OBSERVATION_INTENT_FREE | 代码 | dsh-fs-observation-policy/lib/index.js | 2/2 | 2/2 | pending | 有效 |
| 18 | REPEAT_TOOL_REMINDER_DISABLED | 代码 | dsh-repeat-tool-reminder/lib/index.js | 1/1 | 1/1 | pending | 有效 |
| 19 | TOOL_RESULT_PRUNER_DISABLED | 代码 | dsh-compaction-tool-result-pruner/lib/index.js | 1/1 | 1/1 | pending | 有效 |
| 21 | BASH_TIMEOUT_RESTORE | 代码 | dsh-base/cordis.patch.yml | 0/1 | 0/1 | applied | 无需清洗 — marker/软settle 命中，宿主已是目标态 |
| 22 | READ_CAPS_RAISED | 代码 | dsh-tool-fs/lib/index.js | 3/3 | 3/3 | pending | 有效 |
| 23 | SUBAGENT_MAXDEPTH_RAISED | 代码 | dsh-subagent/lib/index.js | 2/6 | 2/6 | pending | 有效(备选布局) — 2/6 命中（多版本备选，0.2.1 相同） |
| 24 | PRESET_FETCH_ENABLED | 代码 | dsh-web-app/presets/standard.patch.yml | 0/4 | 0/4 | applied | 无需清洗 — marker/软settle 命中，宿主已是目标态 |
| 25 | HARNESS_IDENTITY_STRIP | 提示词 | dsh-system-prompt/lib/index.js | 3/3 | 3/3 | pending | 有效 |
| 26 | MINIMAL_PERSONA_PURGE | 提示词 | dsh-web-app/presets/minimal.patch.yml | 1/8 | 1/8 | pending | 有效(备选布局) — 1/8 命中（多版本备选，0.2.1 相同） |
| 80 | MINIMAL_OFFICIAL_TOOLSET | 工具 | dsh-web-app/presets/minimal.patch.yml | 0/8 | 0/8 | skipped | 既有失效 — 0.2.1 同样 0 命中 |
| 28 | LIANGSHEN_PHASE1_KEEP_INJECT | 提示词 | — | — | — | na | 无目标(可选) — key: liangshen-tool-bootstrap |
| 32 | WEB_SURFACE_IDENTITY_NEUTRAL | 提示词 | dsh-web-app/lib/index.js | 0/2 | 0/2 | skipped | 既有失效 — 0.2.1 同样 0 命中 |
| 29 | TOOL_WEB_UNTRUSTED_NEUTRAL | 工具 | dsh-tool-web/lib/index.js | 3/5 | 3/5 | pending | 有效(备选布局) — 3/5 命中（多版本备选，0.2.1 相同） |
| 30 | HOOKS_CLAUDE_DENY_ALLOW | 工具 | — | — | — | na | 无目标(可选) — key: hooks-claude-code,hooks-claude-code-nested |
| 31 | HOOKS_CODEX_DENY_ALLOW | 工具 | — | — | — | na | 无目标(可选) — key: hooks-codex,hooks-codex-nested |
| 33 | TOOL_SHELL_DENIAL_PROMPT | 提示词 | dsh-tool-bash/lib/index.js | 7/22 | 7/22 | pending | 有效(备选布局) — 7/22 命中（多版本备选，0.2.1 相同） |
| 34 | SANDBOX_HINT_NEUTRAL | 提示词 | dsh-sandbox/lib/index.js | 2/2 | 2/2 | pending | 有效 |
| 35 | ESCALATION_NEVER_REJECT | 代码 | dsh-sandbox/lib/index.js | 1/2 | 1/2 | pending | 有效(备选布局) — 1/2 命中（多版本备选，0.2.1 相同） |
| 36 | TOOL_FS_ESCALATION_SCHEMA | 提示词 | dsh-tool-fs/lib/index.js | 2/8 | 2/8 | pending | 有效(备选布局) — 2/8 命中（多版本备选，0.2.1 相同） |
| 37 | SUBAGENT_SCOPE_LOCK_NEUTRAL | 提示词 | dsh-subagent/lib/index.js | 2/4 | 2/4 | pending | 有效(备选布局) — 2/4 命中（多版本备选，0.2.1 相同） |
| 38 | PERSONA_TEXT_PREFIX_ALIAS | 代码 | dsh-persona/lib/index.js | 2/2 | 2/2 | pending | 有效 |
| 39 | SESSION_V0_PLUGIN_SUMMARY_ALIAS | 代码 | dsh-session-format-v0-to-v1/lib/index.js | 1/1 | 1/1 | pending | 有效 |
| 40 | COMPLETE_PROMPT_KEEP_INJECT | 0.1.5 兼容 | dsh-system-prompt/lib/index.js | 0/7 | 1/7 | skipped | 0.2.2 失效 — 既有锚点全部消失 |
| 42 | SETTINGS_LEGACY_API | 代码 | dsh-settings/lib/index.js | 8/12 | 8/12 | pending | 有效(备选布局) — 8/12 命中（多版本备选，0.2.1 相同） |
| 45 | OFFICIAL_DESKTOP_UPDATE_HANDOFF | 代码 | — | — | — | na | 面门控(desktop) — surfaces=["desktop"] |
| 46 | OFFICIAL_DESKTOP_UPDATE_ASCII | 代码 | — | — | — | na | 面门控(desktop) — surfaces=["desktop"] |
| 47 | ANTHROPIC_OAUTH_NO_CLAUDE_IDENTITY | 0.2.0 兼容 | node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js | 1/2 | 1/2 | pending | 有效(备选布局) — 1/2 命中（多版本备选，0.2.1 相同） |
| 48 | TOOL_SHELL_DELETE_MOVE_NEUTRAL | 工具 | dsh-tool-bash/lib/index.js | 2/2 | 2/2 | pending | 有效 |
| 49 | ANTHROPIC_OAUTH_CLI_NEUTRAL | 0.2.0 兼容 | node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js | 3/3 | 3/3 | pending | 有效 |
| 50 | SESSION_REFERENCE_FRAMING_NEUTRAL | 提示词 | dsh-session-reference/lib/index.js | 0/9 | 0/9 | applied | 无需清洗 — marker/软settle 命中，宿主已是目标态 |
| 51 | FRESH_SESSION_FULL_ACCESS | 代码 | dsh-permission-presets/lib/index.js | 4/4 | 4/4 | pending | 有效 |
| 52 | SESSION_LOG_UPLOAD_DEFAULT_OFF | 代码 | dsh-session-log-deepseek/lib/index.js | 2/4 | 2/4 | pending | 有效(备选布局) — 2/4 命中（多版本备选，0.2.1 相同） |
| 53 | WEB_SURFACE_PROHIBITION | 提示词 | dsh-web-app/lib/index.js | 0/2 | 0/2 | skipped | 既有失效 — 0.2.1 同样 0 命中 |
| 54 | DELIVERABLE_DO_NOT | 提示词 | dsh-deliverable-file-references/lib/index.js | 2/4 | 2/2 | pending | 已修正 — 补 0.2.2 锚点/路径 |
| 55 | SYSTEM_PROMPT_REPLACE_HEAD | 代码 | dsh-agent-loop/lib/index.js | 1/1 | 1/1 | pending | 有效 |
| 74 | ASSEMBLE_BEFORE_PRESTEP | 代码 | dsh-agent-loop/lib/index.js | 1/2 | 1/2 | pending | 已修正 — 补 0.2.2 锚点/路径 |
| 66 | SYSTEM_PROMPT_RENDER_GUARD | 代码 | dsh-system-prompt/lib/index.js | 3/3 | 3/3 | pending | 有效 |
| 83 | DESKTOP_HOST_CLOSE_NO_FATAL | 代码 | — | — | — | na | 面门控(desktop) — surfaces=["desktop"] |
| 84 | DESKTOP_HOST_CLOSE_CODE0_NO_FAIL | 代码 | — | — | — | na | 面门控(desktop) — surfaces=["desktop"] |
| 67 | AGENT_LOOP_MESSAGES_GUARD | 代码 | dsh-agent-loop/lib/index.js | 1/2 | 1/2 | pending | 已修正 — 补 0.2.2 锚点/路径 |
| 68 | SYSTEM_NODES_CONTENT_GUARD | 代码 | dsh-agent-loop/lib/index.js | 3/8 | 3/8 | pending | 有效(备选布局) — 3/8 命中（多版本备选，0.2.1 相同） |
| 69 | MODEL_STREAM_RELEASE | 代码 | dsh-llm-deepseek/lib/index.js | 1/3 | 1/3 | pending | 有效(备选布局) — 1/3 命中（多版本备选，0.2.1 相同） |
| 72 | MESSAGES_SYSTEM_CURRENT | 代码 | dsh-llm-deepseek/lib/index.js | 1/1 | 1/1 | pending | 有效 |
| 56 | REWIND_HIDE_CUT_ONLY | 代码 | dsh-client-ui-conversation/lib/client.js | 2/4 | 2/4 | pending | 有效(备选布局) — 2/4 命中（多版本备选，0.2.1 相同） |
| 77 | REWIND_DROP_SENT_ON_APPEND | 代码 | dsh-client-ui-conversation/lib/client.js | 0/1 | 0/1 | skipped | 既有失效 — 0.2.1 同样 0 命中 |
| 75 | REWIND_RESET_TODOS | 代码 | dsh-tool-todo/lib/index.js | 1/1 | 1/1 | pending | 有效 |
| 57 | DEEPSEEK_SYSTEM_ROLE | 代码 | node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js | 1/12 | 1/12 | pending | 有效(备选布局) — 1/12 命中（多版本备选，0.2.1 相同） |
| 58 | REWIND_SKIP_DERIVE | 代码 | dsh-session/lib/index.js | 1/1 | 1/1 | pending | 有效 |
| 59 | OFFICIAL_AUTO_REVIEW_PASSTHROUGH | 代码 | dsh-experimental-auto-review/lib/index.js | 1/1 | 1/1 | pending | 有效 |
| 60 | OFFICIAL_RUN_CODE_APPROVAL_NEUTRAL | 工具 | dsh-tools/lib/index.js | 8/12 | 8/8 | pending | 已修正 — 补 0.2.2 锚点/路径 |
| 61 | OFFICIAL_SANDBOX_POLICY_NEUTRAL | 提示词 | dsh-sandbox-policy/lib/index.js | 1/1 | 1/1 | pending | 有效 |
| 62 | OFFICIAL_TOOL_ASK_FAILOPEN | 代码 | dsh-tools/lib/index.js | 3/24 | 3/12 | pending | 已修正 — 补 0.2.2 锚点/路径 |
| 63 | OFFICIAL_PLAN_MODE_NEUTRAL | 提示词 | dsh-base/cordis.patch.yml | 12/12 | 12/12 | pending | 有效 |
| 64 | HOOKS_STOP_STEER_NEUTRAL | 工具 | — | — | — | na | 无目标(可选) — key: hooks-claude-code,hooks-claude-code-nested,hooks-codex,hooks-codex-nested |
| 65 | HOOKS_PRESTEP_REJECT_NEUTRAL | 工具 | — | — | — | na | 无目标(可选) — key: hooks-claude-code,hooks-claude-code-nested,hooks-codex,hooks-codex-nested |
| 78 | OVERLAY_RESTORE_FROM_BAK | 代码 | dsh-app-boot/lib/index.js | 1/1 | 1/1 | pending | 有效 |
| 82 | DESKTOP_SHELL_PROFILE_FALLBACK | 代码 | — | — | — | na | 面门控(desktop) — surfaces=["desktop"] |
| 85 | SESSION_PROMPT_ALWAYS_FOLLOWUP | 代码 | dsh-api-session-controller/lib/index.js | 1/1 | 1/1 | pending | 有效 |
| 86 | SESSION_STEER_ALWAYS_FOLLOWUP | 代码 | dsh-api-session-controller/lib/index.js | 2/6 | 2/6 | pending | 有效(备选布局) — 2/6 命中（多版本备选，0.2.1 相同） |
| 87 | HUNG_PROMPT_LF_NEEDLE | 代码 | dsh-agent-loop/lib/index.js | 1/8 | 1/8 | pending | 有效(备选布局) — 1/8 命中（多版本备选，0.2.1 相同） |
| 88 | HUNG_PROMPT_STRICT_NEEDLE | 代码 | dsh-agent-loop/lib/index.js | 0/4 | 0/4 | skipped | 既有失效 — 0.2.1 同样 0 命中 |
