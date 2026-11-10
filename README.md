# DSH 插件集合

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的自研插件 monorepo。每个插件都是独立发布到 npm 的包，带自己的 `package.json`、`cordis.patch.yml`、`src`/`lib` 与测试。

插件代码（宿主半边、浏览器半边、测试、构建与评测脚本）默认是 TypeScript：宿主 `src/` 经 `tsc` 编译到 `lib/`，浏览器半边在 `client/`，测试是 `test/*.test.ts`，构建脚本是 `scripts/*.mts`。只有 `lib/` 下的运行产物是 JavaScript；`dsh-open-in-dsh` 另有 PowerShell / shell / VBScript 写的系统菜单安装器。

例外：`@cooper-zhuang/dsh-workspace-sort`（目录 `packages/dsh-workspace-sort`）是手写 JavaScript + 15 行拼装脚本（`scripts/build-client.mjs`），没有 `tsc` 步骤。它只做一件事（按活动重排工作区顺序），不引内核包、不装依赖，读起来比编译产物短。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](#许可证)

| 包 | npm | 一行说明 | 平台 |
|---|---|---|---|
| [`dsh-cross-memory`](packages/dsh-cross-memory) | [![npm](https://img.shields.io/npm/v/dsh-cross-memory.svg)](https://www.npmjs.com/package/dsh-cross-memory) | 跨会话记忆：后台抽取、按需召回、反思层、persona、承诺台账 | 全平台 |
| [`dsh-session-ops`](packages/dsh-session-ops) | [![npm](https://img.shields.io/npm/v/dsh-session-ops.svg)](https://www.npmjs.com/package/dsh-session-ops) | 会话运维：真删会话、会话归位，含共享会话存储库 | 全平台 |
| [`dsh-rtk-slim`](packages/dsh-rtk-slim) | [![npm](https://img.shields.io/npm/v/dsh-rtk-slim.svg)](https://www.npmjs.com/package/dsh-rtk-slim) | 工具输出瘦身：大文本压缩进 spill，原文按路径取回 | 全平台 |
| [`dsh-folder-path`](packages/dsh-folder-path) | [![npm](https://img.shields.io/npm/v/dsh-folder-path.svg)](https://www.npmjs.com/package/dsh-folder-path) | 粘贴文件夹时插入完整路径，而不是尝试上传 | Windows / macOS |
| [`dsh-open-in-dsh`](packages/dsh-open-in-dsh) | [![npm](https://img.shields.io/npm/v/dsh-open-in-dsh.svg)](https://www.npmjs.com/package/dsh-open-in-dsh) | 从系统里用 DSH 打开文件夹（资源管理器 / Finder / QSpace） | Windows / macOS |
| [`@cooper-zhuang/dsh-workspace-sort`](packages/dsh-workspace-sort) | 已发布 npm（scoped） | 侧栏工作区按最近一次人工提问排序，顺序写进宿主 | 全平台 |

## 快速开始

在 DSH 桌面端的「插件 → 发现/插件市场」里搜索包名安装，也可以直接用 CLI：

```bash
dsh plugin --profile desktop add dsh-cross-memory
# 其他包同理：dsh-session-ops / dsh-rtk-slim / dsh-folder-path / dsh-open-in-dsh
```

安装后在 profile 的 `dsh.profile.bundles` 里启用（插件管理器通常会自动处理）；是否需要重启见各包 README。

## 环境要求

- **DSH**：0.2.2-rc.1 为当前基线（Cordis 4.1.0 / Schemastery 3.19.0）；各包 `engines.dsh` 声明为 `^0.2.1-rc.2 || ^0.2.2-alpha.2`。
- **Node.js**：`>=24`（与 DSH 宿主自带运行时一致；插件不另装内核包，`@deepseek-ai/*` 由宿主提供）。
- **pnpm**：从源码安装或本地调试时需要（DSH 插件管理器会调用 profile 自己的 pnpm）。
- 单包额外依赖：
  - `dsh-rtk-slim` 需要外部 [rtk](https://github.com/rtk-ai/rtk) 二进制在 `PATH`（缺失时插件不生效、输出保留原文）；
  - `dsh-open-in-dsh` 装完插件后需跑一次系统菜单注册脚本（Windows `install-menu.ps1`、macOS `install-macos.sh`），细节见该包 README。

## 各插件能做什么

### dsh-cross-memory

- 空闲时从会话中抽取耐久事实（决策、命令、约定、踩坑、偏好），写入项目作用域或全局记忆。
- 每次会话按需注入分层摘要与按需召回块，支持 `memory` 工具与 `/memories` 命令。
- 条目带来源会话与逐字引文，可回看证据；支持反思合并、persona 快照、承诺台账与保留策略。
- 数据默认只在本机 `~/.dsh/memories`；可选同步到自己的私有 Git 仓库（双机共享）。

### dsh-session-ops

- **真正删除**持久化会话：按未分组、临时、归档、子代理筛选，运行中会话有守卫。
- **会话归位**：在 workspace 之间搬迁会话（日志迁移、`header.cwd` 改写、workspace registry 跟随）。
- 提供右栏两个页签与 `session_admin`、`session_move` 工具，以及共享的会话存储库 `lib/store`（帧级日志读写、projectKey 编解码、registry）。
- 删除是物理删除，操作前请自行备份。

### dsh-rtk-slim

- 把超大 `bash` / `job_output` 文本交给 [rtk](https://github.com/rtk-ai/rtk) 压缩，原文写入 spill 文件，模型可按路径用 `read` 取回。
- 按家族嗅探选择 rtk 过滤器（cargo-test / pytest / git-log / grep / find），识别不出时裸 `rtk pipe` 透传。
- rtk 缺失、崩溃或超限时一律保留原文，行为与未装插件一致。

### dsh-folder-path

- 粘贴复制来的文件夹时，把完整路径作为文本插入输入框，而不是触发上传。
- 宿主半边的剪贴板探针走 PowerShell / osascript，仅 Windows 与 macOS 启用。

### dsh-open-in-dsh

- Windows：资源管理器右键动词「通过 DSH 打开」；macOS：Finder 快速操作与 QSpace Pro「服务」项，另有 `dsh-open` 启动器负责启动或交接桌面端。
- 目录作为工作区切入并可新建空白会话；交接走 macOS Unix socket 或回环 HTTP 路由。
- QSpace 为 macOS 可选集成，未安装时其余入口自动隐藏。

### @cooper-zhuang/dsh-workspace-sort

- 侧栏「视图选项 → 最近更新」只排每个工作区内部的会话；工作区本身的顺序只有拖拽。本插件补这一层：按最近一次人工提问排序、容器目录按子树汇总、可置顶、可选运行中优先。
- 排序走官方 `workspaces.insertBefore`，写进宿主持久顺序（与拖拽等价）；手动拖拽优先到下一次提问。面板挂在 `sidebar.footer.action` + `shell.overlay` 两个官方 Slot 上，不查 DOM 类名。
- 只做排序：没有路径迁移、没有移除工作区、没有打开目录、不起子进程。置顶与开关存 `$DSH_HOME/workspace-sort/prefs.json`（桌面端端口随机，localStorage 会丢）。

## 在插件市场里

- **1024Store（deepseek1024.com）**：5 个条目已收录，可在 DSH 内置 Community Market 的「发现」页浏览/搜索。
- **dshmarket / awesome-dsh-plugin 精选列表**：条目已提交，合并后随站点与市场索引生效。

## 安装方式

### 从 npm（推荐）

```bash
dsh plugin --profile <profile> add <包名>
```

### 从源码（开发）

```bash
git clone https://github.com/CooperZhuang/dsh-plugins-cooper-custom.git
cd dsh-plugins-cooper-custom
pnpm install
pnpm run build   # 编译全部 TypeScript（宿主 src/ + 浏览器 client/；dsh-cross-memory 的 lib/ 不入库，其余包产物随仓库提交）

pnpm --dir ~/.dsh/profiles/desktop add --ignore-scripts \
  "file:$PWD/packages/dsh-cross-memory"
```

装完把包名加进 profile 的 `dsh.profile.bundles`。macOS 上 `file:` 是硬链接副本：`pnpm build` 会写穿已存在的文件，但新增文件或 `git checkout` / `merge` 之后链接会断，跑 `pnpm verify:profile` 自查（`--fix` 补链接）。Windows 上 `file:` 是符号链接，没有这个问题。

## 开发与测试

```bash
pnpm run test                 # 全部包的测试
pnpm run test:cross-memory    # 单包（其他包同名脚本）
pnpm run build                # 编译全部 TypeScript（宿主 src/ + 浏览器 client/）
pnpm run verify:profile       # 校验 profile 里的硬链接安装与源码一致
```

- 改宿主半边（`src/*.ts`，重新 `pnpm run build`）后要重启 DSH 宿主；只改浏览器半边（`client/*.ts`，重新 build）刷新页面即可。
- 测试均基于 Node 内置 `node --test`（Node ≥24 直接执行 `test/*.test.ts`，类型剥离），不启动真实宿主；`dsh-cross-memory` 另有 `pnpm --dir packages/dsh-cross-memory smoke` 做激活冒烟。
- CI（GitHub Actions）在 ubuntu / macOS × Node 24 上跑全量测试，并对每个包做 `npm pack --dry-run`。

## 发布流程

每个包独立版本、独立发布，发布由 GitHub Actions 的 **npm Trusted Publishing（OIDC）** 自动完成，不需要 token，也不需要人工 2FA：

1. 改版本号（`packages/<pkg>/package.json`）并跑测试。
2. 打 tag 推送：`git tag -a <pkg>@<version> -m "<pkg> <version>" && git push origin <pkg>@<version>`。
3. Actions 自动校验 tag 与 `package.json` 版本一致 → `pnpm run build` → `pnpm run test` → `npm publish --access public --provenance`。
4. 发布后约 1–2 分钟生效；1024Store 目录会自动检测 npm 新版本。

发版工作流见 `.github/workflows/release.yml`：tag 触发是主入口，`workflow_dispatch` 保留为手动预检（dry-run 默认开）。

新增包时一次性登记 trusted publisher（本仓库 5 个包已登记，工作流文件名必须保持 `release.yml`）：

```bash
npm trust github <pkg> --file release.yml --repo CooperZhuang/dsh-plugins-cooper-custom --allow-publish -y
```

安全边界：只有 `dsh-*@*` 形式的 tag 会触发，且发布前会跑全量测试；可信发布者的配置在每个包 npm 页面的 Trusted publishers，工作流文件名必须固定为 `release.yml`。

## 隐私与安全

- 插件不收集遥测，不向外部服务发送数据；需要网络的只有你显式配置的功能（记忆库同步到自己的私有 Git 仓库、LLM 抽取走你自己的模型路由）。
- `dsh-cross-memory` 会读取本机 `~/.dsh` 下的会话日志与记忆库，数据默认只留在本机。
- `dsh-session-ops` 删除会话是**物理删除**（连同日志与工作区归属），操作前请自行备份。
- 插件以宿主用户权限运行本地代码：只安装你信任来源的插件。
- 仓库、包描述与测试夹具中不包含个人路径、机器名、私有仓库地址或客户项目名；示例统一使用 `/path/to/...`、`<you>` 等占位。

## 仓库结构

```
packages/
  dsh-cross-memory/     跨会话记忆（TS；src/ + client/ -> lib/，lib 不入库）
  dsh-session-ops/      会话运维（TS；src/ + client/ -> lib/，含 lib/store 共享库）
  dsh-rtk-slim/         工具输出瘦身（TS；src/ -> lib/）
  dsh-folder-path/      文件夹路径粘贴（TS；src/ + client/ -> lib/）
  dsh-open-in-dsh/      系统右键/服务项集成（TS；另含 PowerShell / shell / VBScript 安装器）
scripts/
  verify-profile-links.mts   profile 硬链接一致性校验
  patches/                   本地补丁与操作记录（dsh-better-sidebar 会话行尾图标）
.github/workflows/           CI 与发版
```

每个包的 README 里有自己的配置项、数据目录与限制说明。

## 许可证

[MIT](LICENSE)
