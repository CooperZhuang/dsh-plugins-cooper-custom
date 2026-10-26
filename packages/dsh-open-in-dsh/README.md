# dsh-open-in-dsh

在 Windows 资源管理器里**右键一个文件夹**（或文件夹里的**空白处**）→「**通过 DSH 打开**」，
DSH 就把这个目录作为工作区切入，并进到里面的一个空白会话。

- 已经登记过的工作区 → 直接切过去
- 没登记过 → 自动新建对应工作区
- **复用**该工作区已有的空白会话（不会每点一次就堆一个空会话）
- **不会闪任何窗口**——没有控制台窗口，也不会多开浏览器
- **桌面版**：DSH 没开就把它启动起来，开着却被挡住或缩在托盘里就把它提到最前

## 装在哪个 DSH 上

同一台机器上可能有两个宿主，本插件两个都支持，靠**这台机器装没装桌面版**来分辨：

| | DSH 桌面版（Electron） | `dsh web`（node） |
|---|---|---|
| profile | `desktop` | `web` 或默认 |
| 宿主是谁 | **就是那个应用**（`dsh-desktop-host` 是它的子进程） | 一个独立的 node 服务 |
| 端口 | **19387**（写死在 `dsh-desktop-host` 里，随应用启动） | 3080（本仓库一直以来的约定） |
| 冷启动 | 启动应用，等它起来再把目录投递进去 | 打开浏览器 URL |
| 把窗口提到最前 | 再启动一次应用（见下） | 页面自己 `window.focus()`，基本无效 |

判断逻辑只有一处实现，就在每次点击都会跑的那个脚本里；装菜单时用
`-Probe` 问它一次，把结果写进注册表：

```powershell
pwsh -NoProfile -File scripts\open-in-dsh.ps1 -Probe
# {"port":19387,"app":"C:\\Users\\…\\DeepSeek Harness.exe","mode":"desktop","host":true,"clients":1}
```

`-Probe` 只读：不投递、不启动、不弹窗。

**桌面版没有"打开浏览器"这条退路。** 桌面宿主每个页面都只认 Electron 外壳手里的
authenticated URL；直接开 `http://127.0.0.1:19387/` 得到的是
`401 dsh web authentication required; reopen the URL printed by dsh web`。
所以桌面版模式下的冷启动只能是**启动应用本身**，不能是打开一个 URL。

显式钉住端口就按端口走：`-Port 3080` 即使在装了桌面版的机器上也保持 `dsh web` 的行为。

## 内核版本（DSH 0.2.1-rc.2）

本插件**不引用任何内核包**，只用内核提供的一小组服务，所以换内核不需要改代码——
但用到的每一个符号都对着 0.2.1-rc.2 核过一遍：

| 用到的符号 | 来自 | 0.2.1-rc.2 现状 |
|---|---|---|
| `z.object` / `.default()` | `@deepseek-ai/schemastery` | 不变（内核自己用 `~3.18.5`） |
| `webServer.register({kind:'exact', path, handler})` | `@deepseek-ai/dsh-host-webserver` | 不变 |
| `ctx.inject(['webServer'])` / `ctx.effect()` | `@deepseek-ai/cordis` 4.0.5 | 不变 |
| `ctx.workspaces.create({path})` | `@deepseek-ai/dsh-api-workspace-controller` | 不变 |
| `ctx.sessions.create({workspaceId})` | `@deepseek-ai/dsh-api-session-controller` | 不变（只多了一个可选的 `agentPreset`） |
| `ctx.uiWorkspace.openWorkspace/openSession` | `@deepseek-ai/dsh-client-ui-workspace` | 不变（`openWorkspace` 多了一个可选参数） |
| `window.__ModuleLoader__.load({id, factory})` | `@deepseek-ai/dsh-client-modules` | 不变 |
| 补丁行 `insert: [{id, name, config}]` | `@deepseek-ai/cordis-plugin-include` | 不变 |

两件和 0.2.1-rc.2 有关、但**不影响功能**的事：

- **webserver 不再接受通配地址**（`0.0.0.0` / `::` 加载即报错）。本插件自己的路由只服务
  回环，这条检查照旧；本仓库里那些"Web profile 绑 0.0.0.0"的说法已经改成"可以钉到
  某个具体接口地址"。
- **子代理约定变了**（`start(name, request)` → `startActivation({provider, request})`，
  `toolFilter` / `persona` 被删）。本插件**不派生任何子代理**，所以不涉及。

唯一的依赖改动：`lib/index.js` 一直在 import `@deepseek-ai/schemastery`，但 `package.json`
从来没声明过它——本仓库自己的 `npm test` 因此连 `lib/index.js` 都 import 不进来。
现在按同族仓库（`dsh-rtk-slim` / `dsh-memories`）的写法显式声明
`"@deepseek-ai/schemastery": "^3.18.5"`，与内核 0.2.1-rc.2 带的 `~3.18.5` 对齐。

## 安装

### 1. 插件（宿主 + 浏览器两半边）

本机装在**桌面版**的 profile 里：`~\.dsh\profiles\desktop\package.json` 的 `dependencies`
有 `"dsh-open-in-dsh": "link:C:/CodeRepository/dsh-open-in-dsh"`，`dsh.profile.bundles` 里也有它。
改完客户端源码要重建产物并刷新页面：

```powershell
node scripts/build-client.mjs     # client/index.js -> lib/client.js
```

> **注意：改宿主半边（`lib/index.js`）后必须重启宿主。** 桌面版的宿主进程是应用的子进程，
> 所以是**退出桌面版再打开**（不是关窗口——关窗口只是缩进托盘）。
> 运行中的宿主已经 `import` 过这个模块，热重载补丁层只会拿**缓存里的旧模块**重新执行一遍
> `apply()`——配置会生效，代码不会。这不是本插件的毛病，是新代码在旧进程里验不了的通用事实，
> 所以 `test/routes.test.mjs` 用真实 `node:http` 把新代码挂起来单独验。

### 2. 右键菜单

```powershell
pwsh -File scripts\install-menu.ps1 -Action install
# 卸载：-Action uninstall     查看当前注册：-Action status
```

不带 `-Port` / `-App` 就是自动：解析出桌面版就写 `19387`
和 `…\DeepSeek Harness.exe`，解析不出来就退回 `3080` + 浏览器 URL。
`-Action status` 除了打印两条注册表命令，还会跑一次 `-Probe`，报出「现在点一下会发生什么」。

写入两个 HKCU 动词：`Directory\shell\DSHOpen`（右键文件夹）和
`Directory\Background\shell\DSHOpen`（右键空白处）。HKCU 不需要管理员权限。

**装完要重启一次资源管理器**——Explorer 按进程缓存右键菜单，不重启看不到新条目。
菜单本身**就在 Windows 11 的顶层菜单里**（实测 build 26200，和 PowerShell 7、通过 Code 打开并列），
不用点「显示更多选项」。

## 桌面版怎么把窗口提到最前

页面里的 `window.focus()` 对 Electron 窗口基本无效：它只动页面自己的焦点，不动 OS 层的
窗口；而外壳**没有**给产品页面暴露任何"显示窗口"的 IPC——`window.dshDesktop` 上只有
`browser` / `deviceInfo` / `keyboard` / `shortcuts` / `updates`（目录选择是另一个全局
`__DSH_DIRECTORY_PICKER__`）。

外壳自己有一个：**再启动一次应用**会撞上 `requestSingleInstanceLock()`，已经运行的实例收到
`second-instance` 事件，回调就是 `focusPrimaryWindow()`——`restore()`（从最小化恢复）+
`show()` + `focus()`。所以右键之后启动器就再启动一次应用：几百毫秒、GUI 子系统没有闪窗、
立即退出，窗口被合法地提到最前。冷启动那一次已经启动过，就不再补这一下。

应用还注册了 `dsh://` 协议（`setAsDefaultProtocolClient`），`dsh://open` 是同一手法的
规范化入口；一旦 `DeepSeek Harness.exe` 不在预期位置，启动器会自动退到它：

```
%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe
%ProgramFiles%\DeepSeek Harness\DeepSeek Harness.exe
开始菜单\Programs\DeepSeek Harness.lnk
dsh://open
```

注册表里存的是**当时解析出的那一个**；它以后消失了，启动器会重新解析，不会因为一次应用
更新就把动词弄坏。

### 这一段实测到哪一步（2026-10-05，桌面版 0.2.0-rc.2）

- **单实例锁确实生效**：应用已经在跑时再启动一次，第二个进程 **0.22 秒**退出（exit 0），
  进程数不变——不会开出第二个窗口，也不会把宿主重启。
- **"窗口被恢复到最前"这一步没能在这个会话里验完。** 合成手段全都会撞上同一堵墙：
  Electron 把窗口显示状态缓存在自己那边，外部用 `ShowWindow` 隐藏或最小化，它并不知道，
  于是 `restore()` / `show()` 成了空操作（这就是为什么"隐藏后重启动没回来"和
  "最小化后重启动没恢复"两次实测都是假阴性）；而真正算数的验证——退出应用再右键一次，
  或者真的右键一次——在这个会话里分别会**杀掉正在跑这个 agent 的宿主**、和**把用户的窗口
  切到别的工作区**。
- 所以提窗口这一段是**照外壳源码写的**：托盘隐藏是外壳自己 `window.hide()` 的、最小化也是
  它自己记的，这两种状态下 `focusPrimaryWindow()` 里的 `restore()` / `show()` 才对得上号。
- **前台激活可能被系统拒绝。** 实测：当前台是记事本时，重启一次应用并没有把 DSH 抢到前台
  （那次启动来自一个没有用户输入的后台进程，Windows 直接拒绝）。真实路径不同：右键发生在
  资源管理器里，进程链是资源管理器 → wscript → PowerShell → Electron，Windows 通常会把
  前台权限给这条链。但"能不能真的跳到最前"取决于这一点，而"窗口会不会出现"不取决于它。

## 为什么不闪窗

这是本插件唯一有点绕的地方，两个坑叠在一起。

**其一，动词不能直接指向 PowerShell。** 控制台程序的控制台窗口是 Windows 在进程启动**之前**
就创建好的，所以 `-WindowStyle Hidden` 只能「晚一步」把它藏起来——那晚的一步就是你看到的闪窗。
而且本机默认终端是 Windows Terminal，控制台会被交给它，隐藏更不可靠。实测（见下）旧写法每次
一定会闪出一个窗口。

**其二，路径不能走命令行。** `%V` 里可能有空格、单引号、以及盘符根目录那种结尾反斜杠，
要塞进层层引号里很容易被吃掉。

所以动词指向 **`wscript.exe`**：它是 GUI 子系统程序，Windows 根本不会为它创建控制台；
它再用 `Shell.Run(cmd, 0, False)` 以 `SW_HIDE` 启动 PowerShell，控制台从创建起就是隐藏的。
路径则通过**进程环境变量**传（`DSH_OPEN_PATH` / `DSH_OPEN_PORT` / `DSH_OPEN_APP`），
一个引号都不用转义——单引号目录名、`D:\` 这类边界情况于是自然消失。

## 它怎么工作

右键动词是个独立进程，浏览器拿不到「用户刚才右键了哪个目录」，中间必须有碰头点，
而 DSH 宿主本来就在跑，就用它：

| 步骤 | 谁 | 做什么 |
|---|---|---|
| 1 | 菜单动词 | `open-in-dsh.vbs` 用环境变量把 `%V` 交给 `open-in-dsh.ps1`，后者解析出端口和应用，POST 到 `127.0.0.1:<port>/dsh-open-in-dsh/api/v1/open`；没人应答就先把桌面版启动起来再重投 |
| 2 | 宿主半边 | 校验路径（必须存在且是目录、只接受回环来源），入队并广播 |
| 3 | 页面 | 通过 SSE 收到请求，调客户端自己的服务完成跳转 |
| 4 | 启动器 | 桌面版：再启动一次应用把窗口提到最前。`dsh web`：没人跟随时开浏览器 URL |

第 3 步用的是 DSH 客户端**自己的服务**，和侧边栏点击走同一套逻辑：

```js
const ws = await ctx.workspaces.create({ path })          // 已登记就复用，没有就新建
await ctx.uiWorkspace.openWorkspace(ws.workspaceId)       // 连接并打开它的会话
```

`openWorkspace` 内部就是 `reuseOrCreateBlank`：**有空白会话就复用，没有才建**——
这正是「不要堆多余的窗口」想要的行为。

### 三条路由

| 路由 | 用途 |
|---|---|
| `POST /open` | 启动器提交目录；返回 `{seq, clients, recent}` |
| `GET /events` | 页面跟随请求（SSE，带 `hello` 与回放） |
| `GET /status` | 只报「有几个页面在跟」，无副作用 |

`clients` 与 `recent` 一起决定**冷启动**：没人跟随、而且最近也没人跟随过，才是真的
「DSH 没开」。页面只是**正在重连**（插件重挂载、刷新页面）时 `recent` 为真，`dsh web`
模式下启动器会等它几秒，而不是弹一个你没要的浏览器窗口。

### 为什么用 SSE 而不是轮询

Chrome 会把**后台页面**的定时器节流到每分钟一次——而刚点完右键的那一刻，
DSH 窗口正好被资源管理器盖住，就是后台页面。SSE 是网络事件，后台窗口照样立刻执行。

### 冷启动

**`dsh web`**：DSH 窗口压根没开时，启动器会再打开 DSH，页面加载时补收这条请求。
它优先唤起配置的 `-App`，没配就打开 `http://127.0.0.1:<port>/`。

**桌面版**：宿主和窗口是同一个东西，所以「没人应答」= 应用没开。启动器启动应用，
然后每 700ms 重投一次目录（默认最多 30 秒），直到宿主的 webServer 起来。
投进去以后请求要么被页面**当场**收到，要么待在回放窗口里（`backlogTtlMs`，默认 60 秒）
等页面加载完自己来取。两条路都通向同一个结果，所以不需要去猜页面什么时候加载完。

## 配置

bundle 自带的 `cordis.patch.yml` 是默认值；profile 的 `cordis.patch.yml`
（本机桌面版：`~\.dsh\profiles\desktop\cordis.patch.yml`）里有一条覆盖行
（**整行替换 config，所以要写全**）：

```yaml
- id: open-in-dsh
  config:
    enabled: true
    allowNonLoopback: false   # 只接受回环来源，见下
    alwaysNewSession: false    # 复用已存在的空白会话
    backlogTtlMs: 60000        # 冷启动补收的时间窗
```

`alwaysNewSession: true` 会改成每次右键都新建一个空白会话——同一个文件夹点几次就堆几个空会话，
不建议。

浏览器半边拿不到这个 config（客户端插件是 `apply(ctx)`，没有 config 参数），
所以它是通过 `GET /dsh-open-in-dsh/api/v1/events` 的 `hello` 帧从宿主读回来的。

### 那「设置里的配置菜单」呢？

**DSH 的「设置 → 插件」是只读清单**，它按设计只做检视、不做修改
（上游原话：*inspect plugins without changing their configuration*）。侧边栏的
**「插件」页**才是开关插件、看详情、装/卸 bundle 的地方；那页里**可编辑的配置区域**
要由插件自己注册一个配置页——官方插件是用配套 UI 包做的。本插件只有四个开关，
不值得为它单开一页，所以配置就写在 YAML 里（上面那份，或 `$DSH_HOME/settings.yaml`
同名的段）。

那 `Config` 是干什么的？它让这一行的 `config` 在加载时**被校验并补上默认值**，
并且让 `Config.listConfigs` 读得到 schema——写配置的人（或 agent）不用猜键名，
不用翻源码。**它不会凭空长出一个表单。**

至于清单卡片上显示的**中文标题、描述和图标**，来自 `locale/en.json`、`locale/zh.json`
里的 `meta` 和 `package.json` 的 `icon`（侧边栏「插件」页按这两处渲染卡片）。
没有它们，卡片就只剩一个包名——插件其实在跑，但看起来像没注册。

## 安全边界

这条路由的作用是**让浏览器把任意本地目录当成工作区打开**，而工作区里会跑命令，
所以它等同于一个代码执行入口：

- **只接受回环来源**。内核 0.2.1 起 webserver **不再接受通配地址**（`0.0.0.0` / `::`
  在加载时直接报错），但仍然可以钉到某个**具体接口地址**（比如本机的局域网 IP），
  那依旧是网络可达的——所以这条回环检查照旧不能省：局域网上的机器不能驱动这台机器。
  `allowNonLoopback` 默认 `false`。
- **带 `Origin` 的请求必须同源**。另一个网页即使能连到端口，也不能在背后点火。
- 启动器（wscript / PowerShell）不带 `Origin`，只靠回环这一条通过。

> 桌面版页面的来源是 `dsh-app://app`（外壳自己的协议：前端静态资源由外壳发，其它请求
> 带上外壳持有的 host cookie 转发到 19387——这也正是裸浏览器吃 401、而应用里一切正常的原因），
> 同源 GET 不带 `Origin`，所以 SSE 正常通过；这条检查拦的是别的东西，不是它。

## 已知限制

- 只注册了「文件夹」和「文件夹空白处」。右键**盘符**（如 `D:\`）需要再加一个
  `Drive\shell\DSHOpen`，路径规范化已经支持盘符根目录。
- 桌面版提窗口靠「再启动一次应用」，代价是每次右键多一个两百来毫秒的进程（立即退出）。
  这是外壳唯一暴露给外部的提窗口手段。**它到底有没有把窗口提起来，本机没有端到端实测**
  （见上）；想 100% 确认，退出桌面版再右键一次——应用没开时走的是冷启动，窗口必然起来。
- 桌面版**登录页（welcome 窗口）**出现时页面还没跑起来：请求会待在回放窗口里，
  等你登录进去、页面加载后才落地；超过 `backlogTtlMs` 就过期了，需要重按一次。
- 宿主半边改代码要重启宿主才生效（见上，模块缓存）；桌面版必须整个退出再打开。

## 验证

```powershell
npm test        # 24 个测试
```

- `test/host.test.mjs`：序号/回放/宿主重启回退 + `%V` 的各种形态。
- `test/routes.test.mjs`：三条路由挂到真实 `node:http` 上的集成测试（含跨域拒绝）。
- `test/scripts.test.mjs`：脚本之间的**镜像**——路由路径与 `lib/index.js` 的导出一致、
  三个文件里的端口一致、安装器走 `-Probe` 而不是自己猜；最后几条用真实 `pwsh` 跑
  `-Probe`，验证解析矩阵（桌面版 / 钉住 3080 / 没有应用 / 应用路径失效）。

> 镜像测试不是凑数：本机同时跑着 3080 的 `dsh web` 和 19387 的桌面版，
> 而注册表里的动词曾经指向 3080——右键会把目录开进**另一个** DSH，而两边看起来都对。

真机验证过的部分：

- **不闪窗**：`output\verify\measure-flash.ps1` 把「启动期间新出现的可见顶层窗口」按句柄做差集。
  对照 C（故意显示控制台）能看到 1 个窗口，证明探测器有效；**旧写法 A 闪 1 个，新写法 B 闪 0 个**。
- **复用会话**：用真动词（`InvokeVerb('DSHOpen')`，规范名，显示名会被静默忽略）
  对同一个目录连点两次 → 会话列表里**只有 1 个**。
- **菜单渲染**：真实资源管理器截图确认顶层菜单出现条目；`Shell.Application` 的 `Verbs()` 枚举确认
  shell 认识这个动词。
- **路由**：`npm test` 里的集成测试把新代码挂到真实 `node:http` 上跑通（含跨域拒绝）。
- **桌面版宿主**：`-Probe` 打到 19387 返回 `clients: 1`，说明桌面版页面上的浏览器半边
  确实连着这条 SSE；`install-menu.ps1 -Action status` 打印的注册命令是
  `… "%V" 19387 "…\DeepSeek Harness.exe"`。
- **动词宿主交接**（2026-10-05）：把 `open-in-dsh.vbs` 和一个只记录环境变量的桩脚本放一起，
  用带空格、单引号、结尾反斜杠的路径真跑一次 `wscript`，环境里 `DSH_OPEN_PATH` /
  `DSH_OPEN_PORT` / `DSH_OPEN_APP` 三个值逐字落地——路径没被引号吃掉。
- **单实例**：应用已在跑时再启动一次，0.22 秒退出（exit 0）、进程数不变。

> 排查记录：`MultiSelectModel=Single` 会让动词**从「空白处」菜单里彻底消失**
> （它的语义是「恰好选中一个项目」，而空白处没有选中项）。
> 另外 `EnumWindows` 的回调在 PowerShell 里**不捕获外层局部变量**，
> 第一版探测器因此静默报 0——用 `$global:` 并加一个「必然可见」的对照组才发现。
> 桌面版这边：`http://127.0.0.1:19387/` 在没有 cookie 时是 **401**，看上去像"服务没起"，
> 其实宿主好好的——别拿浏览器能不能打开当健康检查，用 `-Probe`。
