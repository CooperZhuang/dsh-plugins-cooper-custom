# dsh-open-in-dsh

在 Windows 资源管理器或 macOS Finder 里右键一个文件夹，选「通过 DSH 打开」，DSH 就把该目录作为工作区切入，并进到里面的一个空白会话。

- 已登记过的工作区：直接切过去。
- 没登记过的工作区：自动新建。
- 默认复用该工作区已有的空白会话，不会每点一次就堆一个空会话；`alwaysNewSession: true` 时改为每次新建。
- 不闪控制台窗口，也不多开浏览器。
- 桌面版：DSH 没开就把它启动起来；开着但被挡住或缩在托盘里就把它提到最前。

反方向也有入口：DSH 的文件/目录右键菜单提供「用 QSpace Pro / Finder / VS Code / Warp / Terminal 打开」（Windows 是资源管理器）；会话行菜单与右侧文档预览提供「用 QSpace 打开」。见下文「DSH 右键菜单」。

## 平台要求

| 平台 | 系统集成 | 需要什么 |
|---|---|---|
| Windows 10/11 | 资源管理器右键动词（文件夹 / 文件夹空白处） | `wscript.exe` + PowerShell（安装脚本用 `pwsh` 运行；动词运行时优先 `pwsh`，没有则回退 Windows PowerShell）。写 HKCU，不需要管理员权限 |
| macOS | Finder 快速操作 + 终端命令 `dsh-open` | 系统自带 Automator 服务、`curl`、`osascript`；可写入 `~/Library/Services` 与 `~/bin` |
| macOS（可选） | QSpace Pro 的「服务」子菜单 | 只有装了 QSpace Pro 才有意义，安装器会自动检测，也可用 `--qspace` 控制 |

DSH 侧：桌面版或 `dsh web` 都可以；声明的内核区间见「兼容性」。

## 安装

### 1. 安装插件

```sh
dsh plugin --profile <profile> add dsh-open-in-dsh
```

把 `<profile>` 换成目标 profile（桌面版 `desktop`、`dsh web` 用 `web`）。从源码安装时把最后一项换成 checkout 里的 `packages/dsh-open-in-dsh` 路径。

装完刷新页面。改宿主半边（`src/index.ts`，重新 `npm run build` 后）必须重启宿主：桌面版要完全退出应用再打开（关窗口只是缩进托盘），否则运行中的进程还在用模块缓存里的旧代码。

### 2. 注册系统右键菜单

菜单脚本装在插件包目录里（用 `dsh plugin add` 安装时是 `~/.dsh/profiles/<profile>/node_modules/dsh-open-in-dsh/scripts/`；源码安装则在 checkout 内）。装插件本身不会改系统菜单，需要跑一次安装脚本。

**Windows**

```powershell
pwsh -File "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-open-in-dsh\scripts\install-menu.ps1" -Action install
```

- `-Action status`：只查看当前注册与解析结果；`-Action uninstall`：移除。
- 不带 `-Port` / `-App` 就是自动：检测到桌面版就注册桌面版端口与应用，否则退回 `dsh web` + 浏览器 URL。也可以显式钉住：`-Port 3080 -App <exe 路径>`。
- 写入两个 HKCU 动词：`Directory\shell\DSHOpen`（右键文件夹）与 `Directory\Background\shell\DSHOpen`（右键文件夹空白处）。
- 装完重启一次资源管理器：Explorer 按进程缓存右键菜单，不重启看不到新条目。

**macOS**

```sh
sh ~/.dsh/profiles/<profile>/node_modules/dsh-open-in-dsh/scripts/macos/install-macos.sh install
# 查看状态：… status      卸载：… uninstall
```

安装后会得到：

| 位置 | 是什么 |
|---|---|
| `~/Library/Services/通过 DSH 打开.workflow` | Finder 快速操作，只收文件夹；右键文件夹 → **快速操作** → 通过 DSH 打开，支持多选 |
| `~/Library/Services/通过 DSH 打开 (QSpace).workflow` | 同一个标签/脚本，作用域是 QSpace Pro（装了才生成） |
| `~/bin/dsh-open` | 终端命令；不带参数就是当前目录 |

第一次安装后如果菜单没出现：`killall Finder` 或注销重登；菜单项/快捷键在系统设置 → 键盘 → 键盘快捷键 → 服务。

## 卸载

```sh
# 1) 系统菜单
pwsh -File …/scripts/install-menu.ps1 -Action uninstall          # Windows
sh …/scripts/macos/install-macos.sh uninstall                    # macOS（同时删 ~/bin/dsh-open）
# 2) 插件
dsh plugin --profile <profile> remove dsh-open-in-dsh
```

之后重启一次宿主。

## 配置

bundle 自带的 `cordis.patch.yml` 只是默认值；覆盖写在 profile 的 `cordis.patch.yml`（或 `$DSH_HOME/settings.yaml` 的同名段），整行替换 `config`，所以要写全：

```yaml
- id: open-in-dsh
  config:
    enabled: true
    alwaysNewSession: false    # 复用已存在的空白会话
    allowNonLoopback: false    # 只接受回环来源
    backlogTtlMs: 60000        # 冷启动补收的时间窗
    socketPath: /path/to/run/dsh-open-in-dsh.sock   # macOS 交接套接字；空串 = 不监听
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后连路由都不注册 |
| `alwaysNewSession` | `false` | `true` = 每次右键都新建空白会话（同一文件夹点几次就堆几个，不建议） |
| `allowNonLoopback` | `false` | 是否接受非回环来源；这条路由等同于代码执行入口，不要轻易打开 |
| `backlogTtlMs` | `60000` | 页面没开着时，请求在这段时间内仍可被补收 |
| `socketPath` | `~/.dsh/run/dsh-open-in-dsh.sock` | macOS 交接套接字路径；空串表示不监听 |

`Config` schema 的作用是让这一行的 `config` 在加载时被校验并补上默认值，并让 `Config.listConfigs` 读得到键名；它不会长出一个可编辑表单。「设置 → 插件」是只读清单，开关插件请用侧边栏「插件」页。

## 工作方式

### Windows

右键动词是独立进程，浏览器的页面拿不到「用户刚右键了哪个目录」，所以两边通过宿主碰头：

| 步骤 | 谁 | 做什么 |
|---|---|---|
| 1 | 菜单动词 | `open-in-dsh.vbs` 用环境变量把 `%V` 交给 `open-in-dsh.ps1`，后者解析端口/应用并 POST 到 `127.0.0.1:<port>/dsh-open-in-dsh/api/v1/open`；没人应答就先把桌面版启动起来再重投 |
| 2 | 宿主半边 | 校验路径（必须存在且是目录、只接受回环来源），入队并广播 |
| 3 | 页面 | 通过 SSE 收到请求：`alwaysNewSession` 为 `false` 时走 `workspaces.create({ path })` + `uiWorkspace.openWorkspace(id)`；为 `true` 时走 `workspaces.create({ path })` + `sessions.create({ workspaceId })` + `uiWorkspace.openSession(id)` |
| 4 | 启动器 | 桌面版：再启动一次应用把窗口提到最前（单实例锁 → `second-instance` → 聚焦）；`dsh web`：没人跟随时打开浏览器 URL |

动词指向 `wscript.exe` 而不是 PowerShell，路径通过进程环境变量传：GUI 子系统的 wscript 不会创建控制台窗口，因此右键不会闪窗；`%V` 里的空格、单引号、盘符根目录的结尾反斜杠也不经过引号转义。

### macOS

桌面外壳从 2.0.19 起不再接受 `--dsh-desktop-workspace` 启动参数（Chromium 选项解析会直接 `bad option` 退出），所以快速操作走插件自己的 Unix 域套接字（默认 `~/.dsh/run/dsh-open-in-dsh.sock`，权限 0600）：启动器把同样的 JSON 打到套接字上，与 Windows 那条 HTTP 路由共用同一个 handler；就绪探测走套接字上的 status 路由。macOS 桌面版端口不固定（默认 43120，被占用自动 +1），而且外壳在进路由前就把非 Electron renderer 的请求拒成 403，所以这条链路只能走套接字，不能走浏览器 URL。

启动器（`scripts/macos/open-in-dsh`）把路径规范化（软链、相对路径、结尾斜杠、空格与引号）→ 找 app（先看正在跑的那个，再看 `/Applications` 与 `~/Applications`，最后按 bundle ID 走 Spotlight）：

- 已经开着：`curl --unix-socket <socket>` 投路径，然后不带参数再执行一次 app 可执行文件把窗口提到最前。
- 没开：`open -a "<app>"` 起应用，等宿主把套接字绑上（默认最多 30 s，`DSH_OPEN_WAIT` 可改）再投递。
- 没装桌面版：回落到同一条路由的 TCP 版（`dsh web`，默认 3080；`--port` 或 `DSH_OPEN_PORT` 可改）。

### HTTP 路由

所有路由都以 `/dsh-open-in-dsh/api/v1` 开头，成功时返回：

| 路由 | 用途 |
|---|---|
| `POST /open` | 启动器提交目录；返回 `{ok, seq, path, clients, recent}` |
| `GET /events` | 页面跟随请求（SSE，带 `hello` 与回放） |
| `GET /status` | 只报当前跟随的页面数与序号，无副作用；返回 `{ok, clients, seq, recent}` |
| `GET /apps` | 菜单先问本平台有哪些白名单 app 真的装了；返回 `{ok, platform, apps}` |
| `POST /open-with` | 菜单把已存在的文件/目录交给白名单 app；返回 `{ok, app, path, directory}` |
| `POST /open-session` | 会话行菜单提交会话 ID，宿主解析出 cwd 后用同一套白名单 argv 打开；返回 `{ok, app, sessionId, path, directory}` |

### DSH 右键菜单

文件/目录的右键菜单通过内核的 `@deepseek-ai/dsh-client-ui-context-menu` 注册（客户端 `dsh.client.inject` 声明依赖），点开后按宿主报告的可用 app 列动作：

| 平台 | 动作 |
|---|---|
| macOS | QSpace Pro、Finder、VS Code、Warp、Terminal（装了才出现） |
| Windows | 资源管理器（目录直接打开，文件用 `/select,` 定位） |

会话行菜单注册在同一套右键菜单机制上，只提供「在 QSpace 中显示」一项：`qspace` 不可用时整项不出现；会话没有 cwd 时给一条禁用的「会话没有工作目录」。会话行菜单只把会话 ID 交给宿主，目录由宿主从会话头解析。右侧文档预览的 `sidebar.right.tab.document.actions` 另有一个「用 QSpace 打开所在目录」的按钮，走 `/open-with`，传的是当前文件所在目录的绝对路径。

### 为什么用 SSE 而不是轮询

Chrome 会把后台页面的定时器节流到每分钟一次，而刚点完右键时 DSH 窗口正好被资源管理器盖住（就是后台页面）。SSE 是网络事件，后台窗口照样立刻收到。

## 安全边界

这条路由的作用是让浏览器把任意本地目录当成工作区打开，而工作区里会跑命令，所以它等同于一个代码执行入口：

- 只接受回环来源。内核 0.2.1 起 webserver 不再接受通配地址（`0.0.0.0` / `::` 加载即报错），但仍可以钉到某个具体接口地址（比如本机的局域网 IP），那依旧是网络可达的——回环检查不能省。
- 带 `Origin` 的请求必须同源。另一个网页即使能连到端口，也不能在背后点火。
- 启动器（wscript / PowerShell）不带 `Origin`，只靠回环这一条通过。
- 「打开方式」的 app 必须是白名单 ID，路径必须是已存在的绝对路径；命令由白名单表拼成 argv、用 `execFile` 直接执行，不经过 shell。
- `/open-session` 只收会话 ID 与白名单 app ID，目录由宿主从会话头解析；路径不出现在请求里，伪造请求无法用它打开任意目录。

## 已知限制

- 只注册了「文件夹」和「文件夹空白处」。右键盘符（如 `D:\`）需要再注册 `Drive\shell\DSHOpen`，路径规范化已支持盘符根目录。
- 桌面版提窗口靠「再启动一次应用」（每次多一个立即退出的短进程）。能不能真的抢到前台取决于 Windows 的前台权限策略；应用没开时走冷启动，窗口必然起来。
- 桌面版登录页出现时页面还没跑起来：请求会待在回放窗口里，登录进去、页面加载后才落地，超过 `backlogTtlMs` 就过期，需要重按一次。
- 宿主半边改代码要重启宿主才生效；桌面版必须整个退出再打开。
- macOS：快速操作在子菜单里，不是顶层条目（顶层需要 Finder Sync 扩展 + Xcode 工程 + 签名）；右键文件夹空白处没有入口（服务总要有选中项）；移动 checkout 后启动器绝对路径会失效，重跑一次 `install-macos.sh install`——`status` 会打印 `STALE` 并以非 0 退出。
- 宿主重启后插件重新绑定套接字/路由；套接字不在时启动器明确报错并写日志，不会假装成功。

## 验证（开发）

```sh
npm test                            # 82 个测试（含客户端构建与语法检查）
node --test test/macos.test.ts     # macOS 启动器/安装器 17 个测试
```

`npm test` 覆盖宿主路由与回放、`%V` 的各种形态、脚本镜像（路由路径/端口/`-Probe` 一致）、白名单与「打开方式」策略、会话定位，以及真实 `node:http` 上的集成路由（含跨域拒绝）。

## 兼容性

- **DSH**：`engines.dsh: ^0.2.1-rc.2 || ^0.2.2-alpha.2`；Node.js `>=24`。
- **会话存储**：宿主半边通过 `dsh-session-ops/store` 读会话头（peer 依赖，`dsh-session-ops >= 0.1.0`），与 `dsh-session-ops` 共用同一份存储格式。
- 本插件不 import 任何内核包，只使用内核提供的服务（`webServer`、`workspaces`、`sessions`、`uiWorkspace`、客户端模块系统）；接口变化时最坏结果是某个入口失效，不会影响 DSH 本身。
- DSH 侧「打开方式」菜单依赖内核的 `@deepseek-ai/dsh-client-ui-context-menu` 客户端包。

## License

MIT
