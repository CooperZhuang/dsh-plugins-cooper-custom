/**
 * `dsh-session-store` —— DSH 会话插件之间**共享的会话存储知识**。
 *
 * 这个包只做库：没有模型工具、没有槽位注册、没有 DSH 插件生命周期代码，
 * 也**零 `@deepseek-ai/*` 运行时依赖**（只用 node 内置模块）。它被
 * `dsh-session-admin`（删除）与 `dsh-session-move`（搬迁）共用，用来消掉两边
 * 逐字重复的会话存储知识。
 *
 * 四个子模块：
 *   - {@link module:dsh-session-store/paths}：项目目录键 `--C-proj--` 的编解码、
 *     会话目录与 generation 文件名的命名规则；
 *   - {@link module:dsh-session-store/frames}：`session[.vN].jsonl[.zstd]` 的帧扫描、
 *     头部读取（两种严格度）与 cwd 改写；
 *   - {@link module:dsh-session-store/registry}：工作区注册表成员表 / 归档集合、
 *     驻留会话、「正在跑一轮」判定、内存里三处 cwd 的重定向；
 *   - {@link module:dsh-session-store/host}：`$DSH_HOME`、尽力而为的文件日志、
 *     volatile 配置解包；
 *   - {@link module:dsh-session-store/http}：两个插件共用的 HTTP 面（JSON 响应封装、
 *     请求体读取、前缀路由骨架；**信任栅栏按插件语义不同，不在这里**）。
 *
 * 有意**没有**放进来的东西（语义不同或只有一个插件有，见各仓库的注释）：
 * 两套信任栅栏、迁移的三步改名策略（`planMove`/`applyPlan`）、磁盘扫描与范围筛选
 * （admin 专有）、项目记忆跟随（move 专有）、模型工具与槽位定义。
 *
 * @module dsh-session-store
 */

export * from './paths.js'
export * from './frames.js'
export * from './registry.js'
export * from './host.js'
export * from './http.js'
