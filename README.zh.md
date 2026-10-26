# dsh-session-toolbox

DeepSeek Harness (DSH) 的**会话工具箱**：把原先两个独立插件合并成一个包、一个插件行。

| 半边 | 原来 | 现在仍然提供 |
| --- | --- | --- |
| 删除 | `dsh-session-admin` | `/session-admin/api/*`、模型工具 `session_admin`、右栏「会话管理」页签、会话标题栏垃圾桶、设置页 section |
| 搬迁 | `dsh-session-move` | `/session-move/api/*`、模型工具 `session_move`、右栏「会话归位」页签、左栏底部入口 |

两个半边都是**逐字搬过来的**（`lib/admin.js` ← `dsh-session-admin/lib/index.js`，
`lib/move.js` ← `dsh-session-move/lib/index.js`，`lib/engine.js` / `lib/memory.js` /
`lib/sessionlog.js` 原样复制），只有三处差异：entry 元信息与配置 schema 上移到
`lib/index.js`，两个 `API_PREFIX` 分别改名 `ADMIN_API_PREFIX` / `MOVE_API_PREFIX`，
两个 `allowHosts` 拆成两个键（语义不同，见下）。

会话存储知识（路径命名、帧读写、注册表、宿主与 HTTP 底座）来自共享包
**`dsh-session-store`**，本包不重抄。

## 配置键：旧 → 新

| 旧（dsh-session-admin 行） | 旧（dsh-session-move 行） | 新（session-toolbox 行） |
| --- | --- | --- |
| `enabled` | `enabled` | `enabled`（两半共用一个总开关） |
| `allowHosts` | — | `adminAllowHosts` |
| — | `allowHosts` | `moveAllowHosts` |
| — | `root` | `root` |
| `headerDeleteButton` | — | `headerDeleteButton` |
| `allowWorkspaceSessions` | — | `allowWorkspaceSessions` |
| `allowLiveSessions` | — | `allowLiveSessions` |
| `maxBatch` | — | `maxBatch` |
| — | `refuseRunning` | `refuseRunning` |
| — | `maxSessions` | `maxSessions` |
| — | `memoryFollow` | `memoryFollow` |

两个 `allowHosts` **必须**拆开：删除半边按 `Host` 头解析 authority 并额外拒绝
`sec-fetch-site: cross-site` 与跨源 `Origin`；搬迁半边按 socket 的 `remoteAddress` 精确
匹配。合成一个键就等于放宽其中一边。**旧 profile 里残留的 `allowHosts` 不会被任何
栅栏读取**（schemastery 容忍未知键、不报错），需要 LAN 访问时必须改写成上面两个新键，
否则会静默退回"只信 loopback"（更严，不会更松）。

只有 `enabled` 是语义合并：两个旧键变成一个，任一为 `false` 的组合在新键下只能是
"全开"或"全关"。

## 浏览器半边

一个 loader id（`dsh-session-toolbox`）、一个插件对象，里面两个块作用域各放一个原
插件半边（一行都不用改名）。对外的 id 全部保持原样：

- 页签 kind：`dsh-session-admin:manager`、`dsh-session-move:panel`
  （装 dsh-better-sidebar 时分别是 `…:manager-via-better-sidebar` / `…:panel-via-better-sidebar`）；
- 标题栏垃圾桶：`dsh-session-admin:delete-current`（图标形态 + 两步确认，开关是
  `headerDeleteButton`，默认开）；
- 设置页 section：id 从 `session-admin` 改成 `session-toolbox`（标签「会话工具」）。**保留**，
  因为那一页是清理面板，不是配置菜单。

**两张配置卡片合并成一张**，并且 2026-09-25 起挂在**插件页**：槽 `plugins.bundle.config`、
key = 包名 `dsh-session-toolbox`，渲染在本组合包页面的「描述与行之间」，7 个 volatile
旋钮全在这一张卡上（删除 4 + 搬迁 3）。原来那处 `plugins.row.config`
（key `dsh-session-toolbox#session-toolbox`）随之摘掉——同一份表单只留一处。

## 安全默认（一字未变）

`headerDeleteButton=true`、`allowWorkspaceSessions=false`、`allowLiveSessions=false`、
`maxBatch=200`、`refuseRunning=true`、`maxSessions=2000`、`memoryFollow=off`、
`adminAllowHosts=[]`、`moveAllowHosts=[]`。

删除与搬迁的守卫、二次确认、`refuseRunning` 里"正在跑一轮"的判定全部照搬原实现。

## 排障产物

两份日志、两种行格式保持原样（各自的历史格式是可见产物，不做统一）：

- `$DSH_HOME/logs/dsh-session-admin.log` —— `[时间] 级别 正文`
- `$DSH_HOME/logs/dsh-session-move.log` —— `时间 [级别] 正文`

## 用法

```bash
npm test   # node --test：原两个仓库的用例（18 + 30）全部搬入，另有合并期新增断言
```

依赖解析按两个源仓库的约定：`node_modules/dsh-session-store` 与
`node_modules/@deepseek-ai/schemastery` 是 junction，`package.json` 里按 profile 的
约定写 `link:` 依赖。
