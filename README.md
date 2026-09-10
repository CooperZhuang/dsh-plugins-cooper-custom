# dsh-folder-path

DSH（DeepSeek Harness）Web 插件：在输入框里 **Ctrl+V 粘贴一个从资源管理器复制来的文件夹**时，
不再尝试把它当成附件上传（原版会显示「上传失败，点击重试」），而是把它的**完整路径**作为文本插进输入框。

- 复制一个文件夹 → `Ctrl+V` → 输入框出现 `D:\项目\数据\2026Q1`
- 复制多个文件夹 → 每行一条
- 普通文本、图片、真实文件的粘贴**完全不受影响**（插件只在粘贴载荷里出现目录时才接管）

## 它解决的是什么问题
## 它解决的是什么问题

浏览器是沙盒：网页 JavaScript 拿不到本地文件的磁盘路径。把一个文件夹粘进网页时，
浏览器交出的是一个 `size: 0`、`type: ''` 的 `File`——字节不可读，因此 DSH 原版的上传链路必然失败；
而路径也根本不在粘贴载荷里（`File.name` 只有文件夹名）。

但剪贴板是**进程级**的：运行 `dsh web` 的那台机器上，剪贴板里此刻装的正是你刚复制的那份文件列表。
所以本插件由**宿主半边**去读 Windows 剪贴板的文件列表（CF_HDROP），把真实全路径交回浏览器半边。

## 安装

```sh
dsh plugin --profile web add C:\CodeRepository\dsh-folder-path    # 本地路径
# dsh plugin --profile web add dsh-folder-path                    # 未来的 npm 版本
```

安装后**重启 `dsh web` 并刷新页面**（新增 bundle 行不会被热加载）。

验证是否挂上：`dsh --profile web --dump-config` 里应出现 `# == dsh-folder-path` 层。

## 使用

1. 在资源管理器里选中一个或多个文件夹，`Ctrl+C`
2. 回到 DSH Web 输入框，`Ctrl+V`
3. 路径作为文本出现在草稿里；解析失败时右下角出现一条提示，草稿不动

## 工作原理

| 半边 | 位置 | 职责 |
|---|---|---|
| Host 半 `lib/index.js` | 宿主进程（`webServer` 服务） | 精确路由 `POST /dsh-folder-path/api/v1/clipboard-paths`：读 Windows 剪贴板文件列表、按浏览器报来的文件夹名匹配、返回真实全路径 |
| Client 半 `lib/client.js` | 浏览器（`__ModuleLoader__` bundle） | document 捕获阶段拦截 `paste`，只有载荷里含**目录**时才接管；向宿主取路径，再把文本按 DSH 自己的粘贴通路插进 composer |

插入不是直接改 DOM：客户端补发一个只带 `text/plain` 的合成 `paste` 事件，
走的是 DSH 编辑器**原生的文本粘贴命令**（草稿状态、命令菜单、撤销历史、已有 chip 都不受影响）；
引擎不允许构造带数据的 `ClipboardEvent` 时，退化为 `document.execCommand('insertText')`。

宿主用 PowerShell 读剪贴板（`System.Windows.Forms.Clipboard`），输出 **base64(UTF-8 JSON)**，
所以中文/空格路径不会被重定向进程的代码页破坏。同一时刻的多次粘贴会合并成一次探测。

## 配置

插件的配置写在 profile 的补丁层里（`~/.dsh/profiles/web/cordis.patch.yml` 或本包自带的
`cordis.patch.yml` 会被 `dsh plugin add` 接入），全部可选：

```yaml
- insert:
    - id: folder-path
      name: dsh-folder-path
      config:
        enabled: true          # false = 宿主半边空转（客户端因此不再接管，行为退回原版）
        timeoutMs: 5000        # 单次剪贴板探测预算
        powershell: powershell.exe   # 也可用环境变量 DSH_FOLDER_PATH_POWERSHELL 覆盖
        allowNonLoopback: false      # true = 允许远程浏览器读取宿主机剪贴板（见下）
```

## 安全边界

- **只读**：路由只读剪贴板，从不打开、复制或上传文件
- **只接受环回**：默认拒绝非环回对端（`remote-not-supported`）——否则远程浏览器会被喂**宿主机**的路径
- **同源**：带 `Origin` 的请求必须与 `Host` 一致，否则 403
- **不猜路径**：宿主报回的文件夹名必须与剪贴板条目对上；对不上就明确失败，绝不返回一个"看起来像"的路径
- **不缓存**：响应 `cache-control: no-store`

## 已知限制

- **仅 Windows**。其它平台宿主返回 `unsupported-platform`，客户端给出提示，行为退回原版。
- **只处理粘贴，不处理拖放**。浏览器拖放载荷里同样没有磁盘路径，本插件不猜；把文件夹拖进窗口仍是原版行为。
- **远程访问时读不到你的剪贴板**。通过局域网 IP、端口转发或跳板机访问 `dsh web` 时，剪贴板属于**运行宿主的那台机器**。
  默认直接拒绝；`allowNonLoopback: true` 会读宿主机的剪贴板（只有"浏览器和宿主在同一台机器、但用局域网 IP 打开"时才该打开它）。
- 依赖 Windows PowerShell 5.1 的 `System.Windows.Forms`；若被安全策略挡住，会返回 `clipboard-error` 并提示。

## 开发

```sh
npm run build   # client/index.js -> lib/client.js（把浏览器半边包成 __ModuleLoader__ bundle）
npm test        # 语法检查 + 宿主路由行为测试（node --test，无需 DSH 服务器）
```

浏览器侧调试钩子（devtools 控制台）：

```js
await __dshFolderPath.probe(['文件夹名'])   // 直接问宿主要路径
__dshFolderPath.insert(document.querySelector('[contenteditable]'), '文本')   // 直接试插入
```

改客户端半边后：`npm run build`，然后**重启 `dsh web`** 并刷新页面
（bundle 在宿主发布时被快照，重载页面只会取到同一个 revision）。

## 致谢

架构参考了同类的 macOS 插件 [jhuanxx44/dsh-paste-path](https://github.com/jhuanxx44/dsh-paste-path)
（Finder 复制 → 宿主读粘贴板 → Ctrl+V 插路径）：环回/同源校验、宿主侧读取系统剪贴板、
"宿主属于运行 dsh 的那台机器"这条边界都沿用它的判断；本插件把同一思路落到 Windows 剪贴板，
并把触发方式改为**粘贴事件驱动的目录识别**（Windows 上无粘贴板变更计数可供廉价轮询）。

## License

MIT
