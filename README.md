# dsh-open-in-dsh

在 Windows 资源管理器里**右键一个文件夹**（或文件夹里的**空白处**）→「**通过 DSH 打开**」，
DSH 就把这个目录作为工作区切入，并进到里面的一个空白会话。

- 已经登记过的工作区 → 直接切过去
- 没登记过 → 自动新建对应工作区
- **复用**该工作区已有的空白会话（不会每点一次就堆一个空会话）
- **不会闪任何窗口**——没有控制台窗口，也不会多开浏览器

## 安装

### 1. 插件（宿主 + 浏览器两半边）

本机已经装好：`profiles\web\package.json` 的 `dependencies` 里
`"dsh-open-in-dsh": "link:C:/code/dsh-open-in-dsh"`，
`dsh.profile.bundles` 里也有它。改完客户端源码要重建产物并刷新页面：

```powershell
node scripts/build-client.mjs     # client/index.js -> lib/client.js
```

> **注意：改宿主半边（`lib/index.js`）后必须重启 `dsh web`。**
> 运行中的宿主已经 `import` 过这个模块，热重载补丁层只会拿**缓存里的旧模块**重新执行一遍
> `apply()`——配置会生效，代码不会。这不是本插件的毛病，是新代码在旧进程里验不了的通用事实，
> 所以 `test/routes.test.mjs` 用真实 `node:http` 把新代码挂起来单独验。

### 2. 右键菜单

```powershell
pwsh -File scripts\install-menu.ps1 -Action install -Port 3080
# 卸载：-Action uninstall     查看当前注册：-Action status
```

写入两个 HKCU 动词：`Directory\shell\DSHOpen`（右键文件夹）和
`Directory\Background\shell\DSHOpen`（右键空白处）。HKCU 不需要管理员权限。

**装完要重启一次资源管理器**——Explorer 按进程缓存右键菜单，不重启看不到新条目。
菜单本身**就在 Windows 11 的顶层菜单里**（实测 build 26200，和 PowerShell 7、通过 Code 打开并列），
不用点「显示更多选项」。

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
而 `dsh web` 本来就在跑，就用它：

| 步骤 | 谁 | 做什么 |
|---|---|---|
| 1 | 菜单动词 | `open-in-dsh.vbs` 用环境变量把 `%V` 交给 `open-in-dsh.ps1`，后者 POST 到 `127.0.0.1:3080/dsh-open-in-dsh/api/v1/open` |
| 2 | 宿主半边 | 校验路径（必须存在且是目录、只接受回环来源），入队并广播 |
| 3 | 页面 | 通过 SSE 收到请求，调客户端自己的服务完成跳转 |

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
「DSH 没开」，启动器才去开窗口。页面只是**正在重连**（插件重挂载、刷新页面）时
`recent` 为真，启动器会等它几秒，而不是弹一个你没要的浏览器窗口。

### 为什么用 SSE 而不是轮询

Chrome 会把**后台页面**的定时器节流到每分钟一次——而刚点完右键的那一刻，
DSH 窗口正好被资源管理器盖住，就是后台页面。SSE 是网络事件，后台窗口照样立刻执行。

### 冷启动

DSH 窗口压根没开时，启动器会再打开 DSH，页面加载时补收这条请求。
它优先唤起配置的 `AppShortcut`，没配就打开 `http://127.0.0.1:<port>/`。

## 配置

bundle 自带的 `cordis.patch.yml` 是默认值；profile 的
`profiles\web\cordis.patch.yml` 里有一条覆盖行（**整行替换 config，所以要写全**）：

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

- **只接受回环来源**。本机 `dsh web` 绑的是 `0.0.0.0`（见 profile 的 `webserver` 配置），
  所以这条检查不是多余的——局域网上的机器不能驱动这台机器。`allowNonLoopback` 默认 `false`。
- **带 `Origin` 的请求必须同源**。另一个网页即使能连到端口，也不能在背后点火。
- 启动器（wscript / PowerShell）不带 `Origin`，只靠回环这一条通过。

## 已知限制

- 只注册了「文件夹」和「文件夹空白处」。右键**盘符**（如 `D:\`）需要再加一个
  `Drive\shell\DSHOpen`，路径规范化已经支持盘符根目录。
- 唤起窗口时只能 `window.focus()`，浏览器通常忽略没有用户手势的聚焦请求，
  所以 DSH 窗口可能只是被切好了工作区、但没有跳到前台。
- 宿主半边改代码要重启 `dsh web` 才生效（见上，模块缓存）。

## 验证

```powershell
npm test        # 16 个测试：序号/回放/宿主重启回退 + 三条路由的真实 HTTP 集成
```

真机验证过的部分：

- **不闪窗**：`output\verify\measure-flash.ps1` 把「启动期间新出现的可见顶层窗口」按句柄做差集。
  对照 C（故意显示控制台）能看到 1 个窗口，证明探测器有效；**旧写法 A 闪 1 个，新写法 B 闪 0 个**。
- **复用会话**：用真动词（`InvokeVerb('DSHOpen')`，规范名，显示名会被静默忽略）
  对同一个目录连点两次 → 会话列表里**只有 1 个**。
- **菜单渲染**：真实资源管理器截图确认顶层菜单出现条目；`Shell.Application` 的 `Verbs()` 枚举确认
  shell 认识这个动词。
- **路由**：`npm test` 里的集成测试把新代码挂到真实 `node:http` 上跑通（含跨域拒绝）。

> 排查记录：`MultiSelectModel=Single` 会让动词**从「空白处」菜单里彻底消失**
> （它的语义是「恰好选中一个项目」，而空白处没有选中项）。
> 另外 `EnumWindows` 的回调在 PowerShell 里**不捕获外层局部变量**，
> 第一版探测器因此静默报 0——用 `$global:` 并加一个「必然可见」的对照组才发现。
