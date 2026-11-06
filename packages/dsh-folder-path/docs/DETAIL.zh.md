# 粘贴文件夹路径

浏览器里往输入框粘贴文件夹时，默认行为是尝试上传；文件夹无法上传，只会失败。本插件改为读取系统剪贴板里的文件夹路径，把路径作为文本插入输入框。

## 行为

- 仅 Windows 与 macOS 生效；其它平台返回 `unsupported-platform`。
- 浏览器半边在捕获阶段拦截粘贴事件，只在载荷含目录时接管。
- 宿主半边读系统剪贴板拿路径（Windows 走 CF_HDROP，macOS 走 NSPasteboard），按浏览器报来的文件夹名匹配后返回。

## 注意

- 默认只接受环回请求；非环回对端返回 `remote-not-supported`。带 `Origin` 的请求必须与 `Host` 一致，否则 403。
- 其它平台返回 `unsupported-platform`，读剪贴板失败返回 `clipboard-error`，文件夹名对不上返回 `no-match`；这几种情况下客户端提示，路径不插入。
- 响应 `cache-control: no-store`；路由只读剪贴板，不打开、复制或上传文件。
