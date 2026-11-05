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

### 会话右键菜单（内核 0.2.2 起）

`dsh.client.inject` 里声明了 `@deepseek-ai/dsh-client-ui-context-menu`；两半各注册一个
`target: 'session'` 的贡献，合起来是会话行右键 / Shift+F10 菜单里的两项：

- 「移动会话到工作区…」：菜单里只判断能不能搬（运行中 / 没有 cwd / Host 配置拒绝）并把
  理由写进标题；点下去时重新读一次 Host 状态，再打开既有「会话归位」面板并选中这条会话；
- 「删除会话…」：与标题栏垃圾桶共用同一条流程（预演 → 二次确认 → 删除），`run` 里会再
  预演一次；禁用理由同样写在标题里，位置与原生「归档」同区。

图标挂在 `contextMenu.icon` 的 keyed slot（key 分别是 `session-toolbox.move-session` /
`session-toolbox.delete-session`）。`contextMenus` 是**可选**注入：没有这个服务（0.2.1
及更早的外壳）时只少这两项，其它入口照旧。

## 安全默认（一字未变）

`headerDeleteButton=true`、`allowWorkspaceSessions=false`、`allowLiveSessions=false`、
`maxBatch=200`、`refuseRunning=true`、`maxSessions=2000`、`memoryFollow=off`、
`adminAllowHosts=[]`、`moveAllowHosts=[]`。

删除与搬迁的守卫、二次确认、`refuseRunning` 里"正在跑一轮"的判定全部照搬原实现。

## fork 子会话自愈

2026-10-31 实测事故：dsh-easyrewrite 的「编辑重发」会 fork 一条新会话再把原会话归档。
两次 fork 出来的子会话（`session-267986cf`、`session-4cf88d34`）最终都是 `ungrouped`
（`session_admin` 里 `workspaceTitle: null`），而第一次 fork 的父会话明明是 `.dsh`
工作区的成员。客户端只把子会话记进「占位」列表，刷新/重启后侧栏里就再也看不到——
表现就是「刚才那个会话找不到了」。

### Host 侧到底发生了什么（2026-10-31 复盘）

用的是 0.2.1-rc.3 / 0.2.1-rc.5 / 0.2.2-alpha.2 三份内核源码逐行对照（`session/fork` 逻辑
在三个版本里一致，`dsh-workspace` 三个版本字节相同）：

1. `session/fork` 唯一的"不报错但没落账"分支是 `forkWorkspace(source.header)` 返回
   `undefined`：`workspaces.find(w => w.sessionIds.includes(source.id))` 找不到归属时，
   非子代理源会话直接 `return undefined`，之后 `attachSession` 整段被跳过，RPC 照常返回
   成功。所以**父会话自己是 ungrouped 时，子会话必然 ungrouped 且无任何报错**——当晚第二次
   fork（源是第一次的子会话）就是这一类。
2. 第一次 fork 的父会话是 `.dsh` 成员，fork 又返回成功（easyrewrite 日志走的是成功分支，
   失败分支 `fork 失败（编辑重发中止）` 全程 0 条），说明 `attachSession` 确实执行并
   落了盘（`attachSession` 的所有失败都会 reject，没有静默吞掉的写法）。
3. 但同一时刻的**归档也没落住**：22:28 客户端对子会话取消失败（`restored:false`，即本来
   没被归档），父会话随后又被重新归档了一次。新 attach 和归档集合是同一份
   `storages/workspace.json`，能一起抹掉的只有"另一个 Host 进程用旧内存快照整文件覆盖"。
   证据：当晚 22:10:16 / 22:10:40 有两个非测试版的 Host 进程在同一 `~/.dsh` 上挂了同一批
   插件（`logs/dsh-rtk-slim.log` 里 pid=15206、15449，与测试版自己的 host.start 记录对不上，
   即正式版 0.2.1-rc.5 同时在跑）；存储层是整文件原子替换、**没有跨进程锁**
   （`dsh-storage-json`：一个 unit 只有单写者、后写覆盖先写），会话日志那套
   `session.lock` 并不覆盖 `storages`。

所以这不是 `session/fork` 能靠打补丁修好的问题：**记账在 attach 之后被并发写者抹掉**，
只能由 Host 修（跨进程锁 / 合并写入，或让两个 App 不共用 `$DSH_HOME`）；插件层能做的是
"发现即补回来"。

**修复方式**：`mountForkMembershipRepair()` 分两道，规则一致、都只补记账：

1. **创建期**：`session/created` 时补一次（挡住 Host fork 时就没挂的那一类）；
2. **启动期**：`sweepForkChildrenOnBoot()` 扫一轮 `sessionPersistence.list()`，把"父会话
   已入册、子会话却不在任何工作区"的 fork 子会话补回去（挡住记账写进去又被覆盖的那一类）。
   开关是 `repairForkChildrenOnBoot`（默认 `true`）。

规则收窄（`lib/move.js`）：

- 只处理普通 fork 子会话：有 `parentSession`、`origin !== 'subagent'`、`delegationDepth` 不 > 0；
- 父会话已挂在某个工作区才动手，子会话挂到**同一个**工作区；父会话没归属就不猜；
- 子会话 `header.cwd` realpath 后必须等于该工作区路径，否则不挂；
- 幂等、并发去重，attach 失败只记日志，绝不影响 Host 创建会话。

启动期**只认 fork 子会话、不做全量扫描**：真机 343 条存量会话里 155 条是子代理、还有一批
刻意 ungrouped 的迁移会话，全量 attach 会改写既有侧栏结构。存量漂移用 `session_move` 显式修。
自愈日志（`dsh-session-move.log`）：`membership repair mounted`、
`membership: attached fork child …`、`membership: attach failed …`、
`membership sweep: re-attached N of M fork child(ren) …`。

## 搬迁与 `session.lock`（内核 0.2.2+）

0.2.2 起 `dsh-session-persistence-jsonl` 在每个会话目录里放 `session.lock`：POSIX flock，
写入句柄整个生命周期持有，文件永不删除（靠稳定 inode 判断归属，第二个写入者会在
`SessionWriteLease.acquire` 被拒）。搬迁的本质是把会话目录从旧 project 目录挪到新
project 目录，所以租约文件也必须一起走：`applyPlan` 在日志改名完成后用 `rename(2)`
把 `session.lock` 移到目标目录——inode 不变，本进程已持有的 flock 跟着到新路径，仍能
挡住第二个写入者；源目录随之为空并被删除。目标目录已存在 `session.lock` 时
`planMove` 直接拒绝，不制造「锁在旧目录、日志在新目录」的半套租约。

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
