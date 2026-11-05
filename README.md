# DSH 插件集合

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的自研插件 monorepo。每个插件是独立的 npm 包，带自己的 `package.json`、`cordis.patch.yml`、`lib` 与测试，只是开发与版本管理集中在一个仓库。

## 插件

| 包 | 用途 | 平台 |
|---|---|---|
| [`dsh-cross-memory`](packages/dsh-cross-memory) | 跨会话记忆：后台抽取、按需召回、反思层、persona、承诺台账。记忆与 `~/.dsh` 会话日志都只在本机读取，同步仓库由使用者自行配置 | 全平台 |
| [`dsh-session-ops`](packages/dsh-session-ops) | 会话运维：会话删除、会话归位（跨工作区搬迁）、会话日志帧修复；含共享的会话存储知识库 | 全平台 |
| [`dsh-rtk-slim`](packages/dsh-rtk-slim) | 工具输出瘦身：把超大 `bash` / `job_output` 文本压缩进 spill 文件，原文按需取回（调用外部 `rtk` 二进制） | 全平台 |
| [`dsh-folder-path`](packages/dsh-folder-path) | 粘贴复制来的文件夹时插入完整路径，而不是尝试上传 | Windows / macOS |
| [`dsh-open-in-dsh`](packages/dsh-open-in-dsh) | 「通过 DSH 打开」：Windows 资源管理器右键动词；macOS Finder 快速操作、QSpace 服务项与 `dsh-open` 启动器 | Windows / macOS |

## 环境要求

- **DSH**：0.2.2-rc.1（Cordis 4.1.0 / Schemastery 3.19.0）为当前基线；各包 `engines.dsh` 声明了兼容区间（peers 同时覆盖 0.2.1-rc.x）。
- **Node.js**：`>=24`（与 DSH 宿主自带运行时一致；插件不另装内核包，宿主提供 `@deepseek-ai/*`）。
- **pnpm**：从源码安装插件时需要（DSH 插件管理器会调用 profile 自己的 pnpm）。

## 安装

### 从 npm（发布后）

在 DSH 的「插件」页搜索包名，或：

```bash
dsh plugin --profile <profile> add dsh-cross-memory
# 其他包同理：dsh-session-ops / dsh-folder-path / dsh-rtk-slim / dsh-open-in-dsh
```

安装完成后在 profile 的 `dsh.profile.bundles` 里启用（插件管理器会自动处理）；是否要重启宿主见各包 README。

### 从源码（开发）

```bash
git clone https://github.com/CooperZhuang/dsh-plugins-cooper-custom.git
cd dsh-plugins-cooper-custom
pnpm install                      # workspace 依赖（autoInstallPeers=false）
pnpm --dir packages/dsh-cross-memory build   # 该包 lib/ 是构建产物，不入库

pnpm --dir ~/.dsh/profiles/desktop add --ignore-scripts \
  "file:$PWD/packages/dsh-cross-memory"
```

装完把包名加进 profile 的 `dsh.profile.bundles`。macOS 上 `file:` 是**硬链接副本**：`pnpm build` 会写穿已存在的文件，但新增文件或 `git checkout`/`merge` 之后链接会断，跑 `pnpm verify:profile` 自查（`--fix` 补链接）。Windows 上 `file:` 是符号链接，没有这个问题。

## 开发与测试

```bash
pnpm run test                 # 全部包的测试
pnpm run test:cross-memory    # 单包（其他包同名脚本）
pnpm run verify:profile       # 检查 profile 里的硬链接安装是否与源码一致
```

- 改宿主半边（`lib/*.js`）后要重启 DSH 宿主；只改浏览器半边（`lib/client.js`）刷新页面即可。
- 各包 README 里有自己的配置项、数据目录与限制说明。

## 隐私与安全

- 插件不收集遥测，不向外部服务发送数据；需要网络的只有你显式配置的功能（如记忆库同步到自己的 Git 仓库、LLM 抽取走你自己的模型路由）。
- `dsh-cross-memory` 会读取本机 `~/.dsh` 下的会话日志与记忆库，数据默认只留在本机。
- `dsh-session-ops` 删除会话是**物理删除**（连同日志与工作区归属），操作前请自行备份。
- `dsh-rtk-slim` 依赖外部 `rtk` 二进制，缺失时按包内 README 的说明降级。
- 插件以宿主用户权限运行本地代码：只安装你信任来源的插件。

## 许可证

[MIT](LICENSE)
