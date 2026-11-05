/**
 * `dsh-session-ops/lib/store` —— 本包内部的**会话存储原语**。
 *
 * 这一层只做库：没有模型工具、没有槽位注册、没有 DSH 插件生命周期代码，
 * 也**零 `@deepseek-ai/*` 运行时依赖**（只用 node 内置模块）。删除半边与搬迁半边
 * 共用它，避免两边逐字重复同一套会话存储知识。
 *
 * 五个子模块：
 *   - {@link module:dsh-session-ops/store/paths}：项目目录键 `--C-proj--` 的编解码、
 *     会话目录与 generation 文件名的命名规则；
 *   - {@link module:dsh-session-ops/store/frames}：`session[.vN].jsonl[.zstd]` 的帧扫描、
 *     头部读取（两种严格度）与 cwd 改写；
 *   - {@link module:dsh-session-ops/store/registry}：工作区注册表成员表 / 归档集合、
 *     驻留会话、「正在跑一轮」判定、内存里三处 cwd 的重定向；
 *   - {@link module:dsh-session-ops/store/host}：`$DSH_HOME`、尽力而为的文件日志、
 *     volatile 配置解包；
 *   - {@link module:dsh-session-ops/store/http}：两个半边共用的 HTTP 面（JSON 响应封装、
 *     请求体读取、前缀路由骨架；**信任栅栏按插件语义不同，不在这里**）。
 *
 * 有意**没有**放进来的东西（语义不同或只有一边有）：两套信任栅栏、迁移的三步改名策略
 * （`planMove`/`applyPlan`）、磁盘扫描与范围筛选（删除半边专有）、项目记忆跟随
 * （搬迁半边专有）、模型工具与槽位定义。
 *
 * @module dsh-session-ops/store
 */

export * from './paths.js'
export * from './frames.js'
export * from './registry.js'
export * from './host.js'
export * from './http.js'
