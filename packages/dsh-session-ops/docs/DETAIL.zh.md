# 会话运维

把 DSH 的「会话 → 工作区」绑定关系做成可操作的工具：真删除会话、把会话搬到另一个工作区，并修好成员关系。

## 两个页签

- 删除：按未分组、临时或失效目录、归档、子代理筛选，支持批量选择；运行中的会话默认拒绝。
- 搬迁：列出会话与归属，选择目标工作区后搬日志、改 header 的 `cwd`、跟随注册表成员；支持项目记忆跟随（默认关）。

## 其他入口

- 会话右键菜单：移动会话到工作区…、删除会话…
- 「会话归位」页签的「新建工作区…」：选一个已存在的目录，登记成工作区并直接选为搬迁目标。
- 模型工具 session_admin、session_move、workspace_create；宿主 HTTP /session-admin/api、/session-move/api（含 workspaceCreate）。

## 会话面板「会话日志」（内核 0.2.2-rc.3+）

在会话标题栏的会话面板里注册一个只读 section：槽 `conversation.session.panel.section`、id `dsh-session-ops:session`、order 350（排在 environment 0 / change-requests 100 / subagents 200 / shared-tasks 250 / background-jobs 300 之后）。

- 数据面：`/session-admin/api/health`，一次 `ctx.sessionPersistence.stat(sessionId)` 返回 `path` / `dir` / `sizeBytes` / `compression` / `formatStatus` / `workspaceId` / `resident` / `running`。
- 不 list、不 scan、不整读日志（`readStoredLog` 会解压整条帧链）；面板显示日志**目录**，并提供「打开目录」按钮（`/session-admin/api/openDir`）：浏览器只传 sessionId，目录由 Host 从 stat 结果推导，没有任意路径打开能力；打开失败在面板内显示一句话。深度检查留给后续。
- 会话不存在、宿主没有 `stat`、`stat` 抛错都返回 200 + `{found:false, reason}`；非法 id（空串、路径分隔符等）返回 400 结构化错误。
- 0.2.1 宿主不声明该槽：注册挂起、不报错，其余入口照旧。

## 共享存储原语

源码在 `src/store/*.ts`，构建后是 `lib/store/*.js`：

- `paths.ts`：项目目录 key 编解码（`projectKey` / `encodeSegment`）、会话目录与 generation 文件名规则。
- `frames.ts`：`session[.vN].jsonl[.zstd]` 帧扫描、header 读取（两种严格度）、cwd 改写。
- `registry.ts`：工作区成员表与归档集合、驻留会话、「正在跑一轮」判定、写入句柄重定向。
- `host.ts`：`$DSH_HOME`、尽力而为的文件日志、volatile 配置解包。
- `http.ts`：JSON 响应与请求体读取底座、前缀路由骨架。

## 注意

- 搬迁会把 `session.lock` 一起搬走（内核 0.2.2+ 写租约），源目录清空；目标已有租约时拒绝。
- 启动时会做一次 fork 子会话的定向补记账（`repairForkChildrenOnBoot`，默认开）。
- 删除是永久性的：没有回收站、无法恢复；操作前请备份 `$DSH_HOME`。
