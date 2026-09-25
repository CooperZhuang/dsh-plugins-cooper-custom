# dsh-session-store

给 DSH 会话插件共用的**会话存储知识**库：`dsh-session-admin`（删除）与
`dsh-session-move`（搬迁）原先各自维护同一套事实，这个包把它们收敛到一处。

它**只是库**：没有模型工具、没有槽位注册、没有 DSH 插件生命周期代码，也**零
`@deepseek-ai/*` 运行时依赖**（只用 node 内置模块）。

## 分层

| 模块 | 内容 |
| --- | --- |
| `lib/paths.js` | 项目目录键 `--C-proj--` 的编解码、会话目录与 generation 文件名 |
| `lib/frames.js` | `session[.vN].jsonl[.zstd]` 的帧扫描、头部读取（两种严格度）、cwd 改写 |
| `lib/registry.js` | 工作区注册表成员表/归档集合、驻留会话、「正在跑一轮」判定、内存 cwd 重定向 |
| `lib/host.js` | `$DSH_HOME`、尽力而为的文件日志、volatile 配置解包 |
| `lib/http.js` | 两个插件共用的 HTTP 面：JSON 响应封装、请求体读取、前缀路由骨架 |

每个导出都带中文 JSDoc；`lib/index.js` 汇总再导出。

## 刻意没有收敛的东西

语义不同就不能合并——合并等于偷偷改掉其中一边的对外行为：

- **信任栅栏**：`dsh-session-admin` 看 `Host` 头（loopback / `allowHosts` 的
  host/hostname 匹配）并拒绝 `sec-fetch-site: cross-site` 与跨源 `Origin`；
  `dsh-session-move` 看 socket 的 `remoteAddress` 与 `allowHosts` 的精确字符串匹配。
  两套判定都留在各自仓库，`createApiHandler` 只收一个 `trustRequest(req)` 回调。
- **`writeJson` 的 `content-length`** 与 **`readJsonBody` 的严格程度**：两边原本就不同，
  用显式开关保留（默认值对应 move，admin 传 `true` / 用宽松模式）。
- 文件日志的**行格式**：admin 是 `[时间] 级别 正文`，move 是 `时间 [级别] 正文`；
  两种都作为预设导出（`LOG_LINE_LEVEL_FIRST` / `LOG_LINE_TIME_FIRST`）。
- 迁移的三步改名策略、磁盘扫描与范围筛选、项目记忆跟随、模型工具与槽位定义、
  浏览器半边（它们是经典脚本 IIFE，拿不到 ESM 的包解析）。

## 用法

```bash
npm test   # node --test
```

两个插件通过各自 `node_modules/dsh-session-store` 的 junction/symlink 解析本包
（与它们解析 `@deepseek-ai/schemastery` 的做法一致）；`package.json` 里按 profile
的约定写 `link:` 依赖。

## 不变量

- 帧 0 只含一行 header；改写 cwd 只重压帧 0，后续字节原样接上。
- 工作区成员表 `workspace.sessionIds` 是**按会话头过滤过的视图**，完整记账在
  `workspace.record.sessionIds`；删除必须**先摘登记表、再删文件**。
- 「挂着」≠「正在跑一轮」；守卫只认后者。
