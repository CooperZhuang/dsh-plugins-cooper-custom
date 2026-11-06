# 通过 DSH 打开

把「用 DSH 打开」接到系统文件管理器与 DSH 的右键菜单上。

## 两个方向

- 系统侧：Windows 资源管理器右键「通过 DSH 打开」；macOS 提供 Finder 快速操作、QSpace Pro 服务项，以及终端命令 `dsh-open`。
- DSH 侧：文件/目录右键菜单提供「用 QSpace Pro / Finder / VS Code / Warp / Terminal 打开」；会话行菜单与右侧文档预览提供「用 QSpace 打开」。

## 路由

宿主的六条精确匹配路由都在 `/dsh-open-in-dsh/api/v1` 下，应用名走白名单 ID，路径由宿主校验，`execFile` 直接执行，不经过 shell：

- `POST /open`：启动器提交目录，返回 `{ok, seq, path, clients, recent}`。
- `GET /events`：页面跟随请求（SSE，先发 `hello`，再回放 `since` 之后的请求）。
- `GET /status`：只报当前跟随的页面数与序号，无副作用。
- `GET /apps`：本平台实际可用的白名单 app，返回 `{ok, platform, apps}`。
- `POST /open-with`：把已存在的文件/目录交给白名单 app，返回 `{ok, app, path, directory}`。
- `POST /open-session`：会话行菜单提交会话 ID，宿主解析出 cwd 后用同一套 argv 打开，返回 `{ok, app, sessionId, path, directory}`。

## 交接通道

- macOS：插件自己的 Unix 域套接字（默认 `~/.dsh/run/dsh-open-in-dsh.sock`，权限 0600），与 HTTP 的 open 路由共用同一个 handler；就绪探测走套接字上的 status 路由。
- Windows：回环 HTTP 路由，由 `wscript.exe` 启动的 PowerShell 启动器投递。

## 注意

- 菜单化后不再依赖对 app.asar 打补丁。
