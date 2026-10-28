# dsh-plugins-cooper-custom

DeepSeek Harness 自研插件集合。每个插件仍是独立的 npm 包（各自带 `package.json` / `cordis.patch.yml` / `lib` / 测试），只是开发与版本管理集中在一个 monorepo。

## 插件索引

| 包 | 用途 | 内核基线 |
|---|---|---|
| `packages/dsh-memories` | 跨会话记忆：抽取、召回、反思层、persona、承诺台账、桌宠通知通道 | 0.2.1-rc.2 |
| `packages/dsh-rtk-slim` | 工具输出瘦身（长输出压缩进 spill，按需取回） | 0.2.1-rc.2 |
| `packages/dsh-purge` | 破甲 / 红队补丁（宿主文件补丁 + 预设 + Drill 控制台）；**未挂载**，启用要点 Apply | 0.2.1-rc.2（`dshTarget`） |
| `packages/dsh-session-toolbox` | 会话删除 + 会话归位（右栏两个页签 + `session_admin` / `session_move` 工具） | 0.2.1-rc.2 / rc.3 |
| `packages/dsh-session-store` | 会话存储共享库（项目目录 key 编解码、jsonl.zstd 帧、workspace registry）；被 toolbox 依赖 | 内核无关 |
| `packages/dsh-folder-path` | 粘贴文件夹路径而不是尝试上传（功能仅 Windows） | 0.2.1-rc.2 |
| `packages/dsh-open-in-dsh` | 「通过 DSH 打开」：Windows 资源管理器右键动词；macOS 是 Finder 快速操作 + QSpace「服务」项 + `dsh-open`（桌面外壳启动参数交接，不经插件 HTTP 路由） | 0.2.1-rc.2 |

## 目录与历史

`packages/<name>` 分别由原独立仓库用 `git subtree` 导入，**每个子目录保留原仓库的完整 git 历史**。注意 subtree 的语义：原仓库历史作为「导入提交」的祖先保留在提交图里（`git log --graph`、`git log <导入提交>^2` 可查），但 `git log -- packages/dsh-memories` 只显示导入那一笔——这是 subtree 已知限制，不是丢历史。原独立仓库已在迁移后删除，旧仓库源码另存于迁移机的 `~/.dsh/backups/old-dsh-repos-20261026.tgz`。

## 如何装进 DSH profile

开发机本地消费（推荐，保留热改 / HMR）。两台机器都用 `file:` 指到本仓库的包目录：

```bash
# macOS（pnpm 11.8：file: 目录是硬链接副本，构建会写穿到 installed 目录）
pnpm --dir ~/.dsh/profiles/desktop add --ignore-scripts \
  "file:/Users/example/Documents/Code/dsh-plugins-cooper-custom/packages/dsh-memories"

# Windows（pnpm 11.28：file: 目录建的是符号链接，指向仓库真实目录 → 编辑/构建直接生效）
pnpm --dir "$env:USERPROFILE\.dsh\profiles\desktop" add --ignore-scripts \
  "file:C:/code/dsh-plugins-cooper-custom/packages/dsh-memories"
```

**Windows 额外一步**：符号链接指向仓库真实目录，依赖解析也从那里向上找，所以必须先在本仓库根跑一次 `pnpm install`（`autoInstallPeers: false`；`dsh-session-store` 由根 devDependencies 的 `link:` 提供），否则 `dsh-session-store` / `@deepseek-ai/schemastery` 解析不到。

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
