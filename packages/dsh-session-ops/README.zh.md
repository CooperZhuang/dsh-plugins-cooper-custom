# dsh-session-ops

DeepSeek Harness（DSH）的会话运维插件：真删除已持久化的会话，把会话搬到另一个工作区，并同步修好工作区成员关系。

一个包、一个插件行，包含两个半边：

| 半边 | 能力 | 入口 |
| --- | --- | --- |
| 删除 | 按未分组、临时或失效目录、归档、子代理筛选；批量选择；逐条守卫；真删磁盘数据 | HTTP `/session-admin/api/*`、模型工具 `session_admin`、右栏「会话管理」页签、会话标题栏垃圾桶、设置页「会话工具」 |
| 搬迁 | 搬日志、改写 header 的 `cwd`、跟随工作区成员表；可选项目记忆跟随（默认关） | HTTP `/session-move/api/*`、模型工具 `session_move`、右栏「会话归位」页签、会话右键菜单 |

会话存储原语收在本包的 `lib/store/`：项目目录键编解码、`session[.vN].jsonl[.zstd]` 帧读写、工作区注册表、`$DSH_HOME` 与文件日志、HTTP 底座。两个半边共用同一份实现。

## 安装

```bash
dsh plugin --profile <profile> add dsh-session-ops
```

装好后重启宿主，或按 DSH 的热加载规则让 profile 重组。插件行由包内 `cordis.patch.yml` 声明，entry ID 是 `session-toolbox`。

## 破坏性删除

「删除」是真删除，不是归档。三处数据一起从磁盘移除：

- `<DSH_HOME>/sessions/<项目目录键>/<session-id>/`：会话日志
- `<DSH_HOME>/storages/session_projcache/sessions/<session-id>.json`：投影缓存
- `<DSH_HOME>/rewind-snapshots/<session-id>/`：回退快照（若有）

删除后顺手清理因此变空的项目目录。没有回收站，删了无法恢复；删除前请自行备份 `$DSH_HOME`。面板提供预演与二次确认，但最终责任在操作者。

默认安全边界（可在配置里改）：`allowWorkspaceSessions=false`、`allowLiveSessions=false`、`refuseRunning=true`。工作区会话、正在跑的会话、运行中的搬迁默认都被拒绝。

搬迁不是删除：日志目录从旧 project 目录整体移到新目录，`header.cwd` 改写，工作区成员表跟着变。内核 0.2.2+ 的会话目录里有 `session.lock`，搬迁时会一起搬走（inode 不变）；目标目录已有租约时直接拒绝，不会留下「锁在旧目录、日志在新目录」的半套状态。

## 配置

插件行只有一个 `enabled` 总开关，两个半边共用；其余键各自独立：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 时宿主不注册路由与工具（浏览器侧页签仍会加载） |
| `root` | `''` | 会话根目录；空则取 `sessionPersistence.root`（jsonl 后端为 `$DSH_HOME/sessions`） |
| `adminAllowHosts` | `[]` | 删除半边的 LAN 信任列表（按 `Host` 头解析 `host` 或 `host:port`） |
| `moveAllowHosts` | `[]` | 搬迁半边的 LAN 信任列表（按 `Host` 头完整值精确匹配） |
| `headerDeleteButton` | `true` | 会话标题栏垃圾桶图标（图标 + 两步确认） |
| `allowWorkspaceSessions` | `false` | 允许删除已归属工作区的会话 |
| `allowLiveSessions` | `false` | 允许删除宿主里驻留的会话 |
| `maxBatch` | `200` | 单次批量删除上限 |
| `refuseRunning` | `true` | 拒绝搬迁正在跑一轮的会话 |
| `maxSessions` | `2000` | 搬迁面板一次最多列出的会话数 |
| `memoryFollow` | `off` | 项目记忆跟随：`off` / `copy` / `move`（`move` 不可逆） |
| `repairForkChildrenOnBoot` | `true` | 启动时补挂漏记账的 fork 子会话 |

两个信任键不能合并：删除半边按 `Host` 头解析回环 authority，`adminAllowHosts` 可写 `host` 或 `host:port`；搬迁半边按 socket 的 `remoteAddress` 判断回环，`moveAllowHosts` 只认 `Host` 头的完整值。两边都拒绝 `sec-fetch-site: cross-site` 与跨源 `Origin`，合并会改掉其中一边的对外行为。两者都只影响 LAN 访问，默认只信回环。

浏览器侧还有一处指向本行的配置卡片：槽 `plugins.bundle.config`，key 是包名 `dsh-session-ops`，含 7 个 volatile 旋钮（删除 4 + 搬迁 3）。保存即写回 profile 的 `cordis.patch.yml`，无需重启宿主。

## 兼容区间

- Node.js `>=24`
- DSH `^0.2.1-rc.2 || ^0.2.2-alpha.2`

会话右键菜单需要内核提供 `@deepseek-ai/dsh-client-ui-context-menu`（0.2.2+）。没有这个服务时只少两个菜单项，页签、工具与 HTTP 入口照旧。搬迁时携带 `session.lock`、启动期 fork 子会话补记账，同样以 0.2.2+ 的持久化实现为准。

## 排障产物

两份文件日志保留各自原有的行格式（历史产物，刻意不统一）：

- `$DSH_HOME/logs/dsh-session-admin.log`：`[时间] 级别 正文`
- `$DSH_HOME/logs/dsh-session-move.log`：`时间 [级别] 正文`

搬迁与自愈的关键行：`membership repair mounted`、`membership: attached fork child …`、`membership: attach failed …`、`membership sweep: re-attached N of M fork child(ren) …`。

## 作为库使用

`lib/store/` 与插件生命周期无关，零 `@deepseek-ai/*` 依赖，可以单独引用。包里提供两种入口：

```js
// 根入口（与合并前的会话存储共享库公开面一致）
import { projectKey, readSessionHeader, hasZstd } from 'dsh-session-ops'

// 或显式分层，避免和插件面混在一起
import { projectKey, readSessionHeader, hasZstd } from 'dsh-session-ops/store'
```

## 开发

```bash
npm run build     # 宿主 tsc（src/ -> lib/、lib/types/）、浏览器 tsc（client/ -> .client-build/），
                  # 再由 scripts/build-client.mts 产出 lib/client.js
npm test          # 先 build，再用 node --test 跑 test/**/*.test.ts（Node ≥24 原生执行 TS）
```

手写代码全部是 TypeScript：宿主在 `src/`，浏览器半边在 `client/`（给 `window.__ModuleLoader__` 用的经典脚本 IIFE，按单文件发射、不打包）。`lib/**/*.js` 与 `lib/types/` 是随仓库入库的构建产物，checkout 或 profile 安装不先 build 也能用；`test/*.ts` 由 Node 直接执行，不参与发射。

## License

MIT © 2026 Cooper Zhuang
