# dsh-plugins-cooper-custom

DeepSeek Harness 自研插件集合。每个插件仍是独立的 npm 包（各自带 `package.json` / `cordis.patch.yml` / `lib` / 测试），只是开发与版本管理集中在一个 monorepo。

## 插件索引

| 包 | 用途 | 内核基线 |
|---|---|---|
| `packages/dsh-memories` | 跨会话记忆：抽取、召回、反思层、persona、承诺台账、桌宠通知通道 | 0.2.2-rc.1（peer 区间也覆盖 0.2.1-rc.x） |
| `packages/dsh-rtk-slim` | 工具输出瘦身（长输出压缩进 spill，按需取回） | 0.2.2-rc.1（peer 区间也覆盖 0.2.1-rc.x） |
| `packages/dsh-purge` | 破甲 / 红队补丁（宿主文件补丁 + 预设 + Drill 控制台）；**未挂载**，启用要点 Apply | 0.2.2-rc.1（补丁库已按 rc.1 asar 树逐条核对，见 `packages/dsh-purge/docs/host-patch-audit-0.2.2-rc.1.md`） |
| `packages/dsh-session-toolbox` | 会话删除 + 会话归位（右栏两个页签 + `session_admin` / `session_move` 工具） | 0.2.2-rc.1 / 0.2.1-rc.x |
| `packages/dsh-session-store` | 会话存储共享库（项目目录 key 编解码、jsonl.zstd 帧、workspace registry）；被 toolbox 依赖 | 内核无关（v4 日志已实测） |
| `packages/dsh-folder-path` | 粘贴文件夹路径而不是尝试上传（功能仅 Windows） | 0.2.2-rc.1 |
| `packages/dsh-open-in-dsh` | 「通过 DSH 打开」：Windows 资源管理器右键动词；macOS 是 Finder 快速操作 + QSpace「服务」项 + `dsh-open`（桌面外壳启动参数交接，不经插件 HTTP 路由） | 0.2.2-rc.1（peer 区间也覆盖 0.2.1-rc.x） |

## 第三方插件更新与回滚（0.2.2+）

DSH 0.2.2 起「插件 → 已安装」可以检查并更新**第三方 npm 插件**；更新过程中插件会被移除并重装，失败（装不上或起不来）时自动重装被移除的旧版本（需要 HMR 可用；没有 HMR 时只给 restart-required，不回滚）。

- 可更新：`dsh-better-sidebar`、`dsh-easyrewrite`、`dsh-lsp-actions` 这类以包名按 registry spec 安装的 npm 插件。
- 不可更新（预期）：本仓库全部 `file:` 插件，以及 `github:` 安装的 `dsh-minimax-connect`——它们的版本由本仓库提交与机器本地路径决定，升级走 git/pnpm，不走插件页更新。
- 官方 `@deepseek-ai/*` bundle 跟随 DSH 版本，不出现在可更新列表。

## 目录与历史

`packages/<name>` 分别由原独立仓库用 `git subtree` 导入，**每个子目录保留原仓库的完整 git 历史**。注意 subtree 的语义：原仓库历史作为「导入提交」的祖先保留在提交图里（`git log --graph`、`git log <导入提交>^2` 可查），但 `git log -- packages/dsh-memories` 只显示导入那一笔——这是 subtree 已知限制，不是丢历史。原独立仓库已在迁移后删除，旧仓库源码另存于迁移机的 `~/.dsh/backups/old-dsh-repos-20261026.tgz`。

## 如何装进 DSH profile

开发机本地消费（推荐，保留热改 / HMR）。两台机器都用 `file:` 指到本仓库的包目录：

```bash
# macOS（pnpm 11.8：file: 目录是硬链接副本，构建会写穿到 installed 目录）
pnpm --dir ~/.dsh/profiles/desktop add --ignore-scripts \
  "file:/Users/example/Documents/Code/Dsh/dsh-plugins-cooper-custom/packages/dsh-memories"

# Windows（pnpm 11.28：file: 目录建的是符号链接，指向仓库真实目录 → 编辑/构建直接生效）
pnpm --dir "$env:USERPROFILE\.dsh\profiles\desktop" add --ignore-scripts \
  "file:C:/code/dsh-plugins-cooper-custom/packages/dsh-memories"
```

**Windows 额外一步**：符号链接指向仓库真实目录，依赖解析也从那里向上找，所以必须先在本仓库根跑一次 `pnpm install`（`autoInstallPeers: false`；`dsh-session-store` 由根 devDependencies 的 `link:` 提供），否则 `dsh-session-store` / `@deepseek-ai/schemastery` 解析不到。

> **新增源文件不会随 `pnpm build` 进 profile**：`file:` 在本机是硬链接副本，构建只写穿已存在的文件。源码里新加的模块（2026-11-05 的 `packages/dsh-memories/lib/raw-recall.js` 就是案例）不会出现在 `~/.dsh/profiles/desktop/node_modules/<包>/lib/` 里，宿主启动时直接 `ERR_MODULE_NOT_FOUND`，而 `pnpm install` 对清单没变的 `file:` 依赖只报 `Already up to date`。改完跑 `pnpm verify:profile` 自查（加 `--fix` 补硬链接，或 `remove` + `add` 重装）；宿主里已判失败的条目改一下 profile 的 `cordis.patch.yml` 触发 hmr 重组就能重新 import，不必重启。
>
> 另一条反直觉的：**git checkout / merge 重写仓库里的源文件时，profile 里的硬链接会被换成内容相同的普通文件**（inode 变了），后续 build 就不再写穿。切分支/合并之后同样跑一次 `pnpm verify:profile --fix`，判据是每个文件与源码同 inode。

**dsh-memories 是 TS 项目**：`lib/` 是构建产物（gitignore，不入库）。新机器/clone 后要先构建一次：

```bash
pnpm --dir packages/dsh-memories install --ignore-scripts   # 或复用已装好的 node_modules
pnpm --dir packages/dsh-memories build
```

装好后把包名加进 profile 的 `dsh.profile.bundles`（或依赖它自己的 bundle patch），宿主是否需要重启见各插件 README 与 `dsh-plugin-hot-load` 技能。

其他机器从 GitHub 子目录装（pnpm 11.8.0 实测支持 `#path:`）：

```bash
pnpm add "github:CooperZhuang/dsh-plugins-cooper-custom#path:/packages/dsh-session-store"
```

装好后把包名加进 profile 的 `dsh.profile.bundles`（或依赖它自己的 bundle patch），宿主是否需要重启见各插件 README 与 `dsh-plugin-hot-load` 技能。

## App 包补丁（不进 profile）

有些上游行为编译期就定死了，配置改不了，只能动桌面端 `.app` 里的构建产物：

| 脚本 | 改什么 | 生效条件 |
|---|---|---|
| `scripts/patch-open-in-app-qspace.mjs` | 会话头部「打开方式」加 QSpace Pro，排第一（即默认项），访达保留 | 重启桌面端；**DSH 升级会整体替换 .app，升级后重跑 `--apply`** |

```bash
node scripts/patch-open-in-app-qspace.mjs --check    # 只报告两个补丁点状态
node scripts/patch-open-in-app-qspace.mjs --apply    # 打补丁 -> 自检 -> 不过就自动回滚
node scripts/patch-open-in-app-qspace.mjs --verify   # 自检：归档 + 语法 + 用 Electron 真跑路由
node scripts/patch-open-in-app-qspace.mjs --revert   # 从 .dsh-bak 恢复 app.asar 与 Info.plist
```

宿主半边（`dsh-host-open-in-app` 的目录白名单）与浏览器半边（`dsh-client-ui-open-in-app` 的 `APP_LABEL_KEY`）都要插一行：只改一边的话，条目会被菜单过滤掉或显示空名字。

### 两种打包布局

| 版本 | 目标 | 怎么做 |
|---|---|---|
| ≤ 2.0.18 | `Contents/Resources/app/node_modules/...` | 直接改两个 `lib/*.js`（`--revert` 删掉插入的行） |
| ≥ 2.0.19 | `Contents/Resources/app.asar` | 重建归档（`scripts/lib/asar.mjs`），并改写 `Info.plist` 的 `ElectronAsarIntegrity.hash` |

asar 的坑，都在 `scripts/lib/asar.mjs` 顶注里：header 是 Chromium pickle、**条目 `offset` 相对数据区起点而不是文件开头**、改过的文件要重算 `integrity`（Electron 只校验 header JSON 的 SHA256，但 header 里的 per-file 哈希得自洽）。不施加改动重建时产物与原归档逐字节相同，可以拿它当回归测试。

## 依赖关系

- `dsh-session-toolbox` 运行期依赖 `dsh-session-store`，在 `peerDependencies` 里声明；monorepo 内由**根 devDependencies 的 `link:./packages/dsh-session-store`** 提供（`autoInstallPeers: false` 不自动装 peer）。装进 profile 时**两个包都作为 profile 的直接依赖安装**，靠 hoisted 解析。历史遗留的写死路径 `link:C:/code/dsh-session-store` 已移除。

## 不在本仓库

- `dsh-minimax-connect`：上游 fork（保留上游关系与 PR），仍独立维护。
- 已退役插件（`dsh-solpi-action-fusion` / `dsh-solpi-observation-pack` / `dsh-context-window` / `dsh-auto-thinking-effort`）：GitHub 上保持归档，不迁入。

## 内核适配基线

2026-10-26 核对：Mac 内核 0.2.1-rc.2、PC 内核 0.2.1-rc.3 上，本仓库插件全部适配（peer 区间满足、内核 API 导出无缺失、各包测试通过）。

2026-10-31 复核（桌面端 2.0.21-beta.1 / 内核 0.2.2-alpha.2 / Cordis 4.0.6-alpha.1）：
peer 区间改成「旧区间 `|| ^0.2.2-alpha.2`」（Cordis/Schemastery 同理），`dsh-memories` 的 devDependencies 钉到 0.2.2-alpha.2 作为测试基线；各包测试与构建重跑通过。
这一版内核的四处破坏面在本仓库的落点：
  1. `tools.mode` / `maxParallelSubCalls` 已改成 `z.never()`（"mount a native or PTC tool executor instead"）——本仓库插件与预设都不写这两个键，无需迁移；
  2. 宿主投影改成异步的 `ctx.sessionProjections`，宿主侧 `session.projectionValues` 已不存在——本仓库只用客户端 `projectionValues` 与 `session.header.agentPreset`（`dsh-purge/lib/identity.js` 早已按 header 兜底），无需改；
  3. 组合包/客户端导出路径：`dsh.client.inject|external|platform`、`dsh.bundle.patch`、`@deepseek-ai/dsh-client-ui-settings/client` 这些本仓库用到的入口在 2.0.21 的 `app.asar` 里都还在；
  4. 客户端 keyed 槽必须传 `options.key`、list 槽必须传 `options.id`（同 key/id 同 priority 再注册会 throw）——本仓库所有注册点都已满足。
`dsh-purge` 的宿主文件补丁库已在 0.2.2-alpha.2 宿主（asar 解包树）上逐条核对：82 条中 7 条补了 0.2.2 锚点/路径，桌面壳 3 条因 2.0.21 架构重写标 optional，其余命中或既有失效（逐条矩阵见 `packages/dsh-purge/docs/host-patch-audit-0.2.2.md`）；插件保持未挂载（asar 解包→重启→宿主自检链路未验证）。

2026-11-05 复核（桌面端 0.2.2-rc.1，2026-11-04 17:30 安装；内核包 `@deepseek-ai/dsh-*` 0.2.2-rc.1、Cordis 4.1.0、Schemastery 3.19.0、Cosmokit 1.9.0；数据来自 app.asar 内 331 个内核包的 package.json）：
`dsh-memories` 的 devDependencies 钉到 0.2.2-rc.1 / Cordis 4.1.0 / Schemastery 3.19.0，`dsh-rtk-slim` 的 devDependencies 钉到 0.2.2-rc.1；peer 区间未改（`^0.2.1-rc.2 || ^0.2.2-alpha.2` 在 semver 预发布规则下仍满足 0.2.2-rc.1，Cordis `^4.0.5`、Schemastery `^3.18.5` 同理）。当版破坏面在本仓库的落点：
  1. `dsh-llm` 的 `GenerateOptions.purpose` 从 `'compaction' | 'session-title'` 改成 `LlmRequestPurpose`（由内核留空的 `LlmRequestPurposeMap` 派生，注释写明"declared by their producer packages"）——唯一真实类型破坏，运行时零 diff。`dsh-memories/src/types.ts` 用 `declare module` 增补 `compaction: true`，保住 DeepSeek 适配器按 `purpose === 'compaction'` 加的 `x-deepseek-harness-compact: 1` 头；
  2. Cordis 4.1.0 的实质重构（`internal/config|update` 签名、`EventsService.register/unregister` 转 private、`Fiber.store→committed`、**`LoggerLevel` 里 INFO 与 WARN 数值互换**）本仓库零处使用；`activation-smoke.mjs` 改读 `fiber.effectiveConfig`（4.1.0 把 raw 输入留在 `fiber.config`，解析后、volatile 仍是 live 引用的那份在公开 getter 里）；
  3. `dsh-agent` / `dsh-tools` / `dsh-session` / `dsh-home-paths` / `dsh-agent-preset` / `dsh-typert-protocol` 的 `.d.ts` 在 alpha.2↔rc.1 逐字节相同；`schemastery` / `cosmokit` 的 `lib/` 逐文件哈希相同；客户端 `slots` / `settings` / `locale` / `conversation` / `sidebar-right` / plugin-manager 的槽契约只有加法（`settings.section.icon`、`destination`/`flashes`/`menuTabs`、Menu 新 props），`keyed slot … requires options.key` 语义未变；
  4. 各包复跑：`dsh-memories` tsc 0 错 + 424 pass（含远端新增的 e2e 用例）+ activation smoke OK；`dsh-session-toolbox` 68、`dsh-session-store` 41、`dsh-folder-path` 28、`dsh-open-in-dsh` 39、`dsh-rtk-slim` 54 + typecheck；`dsh-purge` build-client 产物与提交版一致、smoke 27/27（顺带修掉 Windows 上 `node scripts/smoke.mjs` 用 ESM 绝对路径 import 报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，改用 `pathToFileURL`）。
`dsh-purge` 补丁库在 0.2.2-rc.1 asar 上重核：82 条里只有 #17 `FS_OBSERVATION_INTENT_FREE` 真失配（rc.1 的 `editIntent` 改委托 `requirePresent(target, actor, "edit")`，旧锚点只命中 writeIntent，状态会从 pending 变 skipped 的假阳性），已补 rc.1 锚点变体并保留旧回退；桌面壳 #45/#83 因 rc.1 恢复 electron-updater / DesktopHostProcess close 处理而重新命中，#82 `DSH_PROFILE` 兜底机制在 rc.1 已消失、建议上游退役。全量 apply 模拟：59 条规则 / 50 个文件 / 83 处，与 alpha.2 基线一致，apply 后 0 pending（逐条矩阵见 `packages/dsh-purge/docs/host-patch-audit-0.2.2-rc.1.md`）。
另修一处**非 rc.1 引入**的旧缺陷：`dsh-session-toolbox` 客户端把 `ctx.slots.inject()` 的返回值当 `{ dispose }` 调用（该 API 返回的是 disposer 函数），真卸载/换注册路径上是空操作；已改成直接调用函数（`Fiber.dispose` 的 `nativeTabDispose` 保持原样）。
客户端 UI 的**实际渲染**本轮只做了契约核对与宿主日志实测（memories remote namespace、session-toolbox 两条 HTTP 路由、easyrewrite 浏览器半边在 rc.1 下都起来了），没有在浏览器里逐页点；profile 里的第三方插件保持现有版本（`dsh-easyrewrite` 不要升 3.x：现有补丁对 3.0.0 的 `lib/client.js` 失配且会触发 `ERR_PNPM_UNUSED_PATCH`）。
