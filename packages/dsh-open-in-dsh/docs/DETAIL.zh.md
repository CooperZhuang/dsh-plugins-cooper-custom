# 通过 DSH 打开

把「用 DSH 打开」接到系统文件管理器与 DSH 的右键菜单上。

## 两个方向
  - 系统侧：Windows 资源管理器右键「通过 DSH 打开」；macOS 提供 Finder 快速操作、QSpace 服务项，以及 dsh-open 交接。
  - DSH 侧：文件/目录右键菜单提供「用 QSpace Pro / Finder / VS Code / Warp / Terminal 打开」。

## 实现要点
  - 宿主开放 open-with 路由，应用名走白名单映射，不接受任意命令。
  - 交接走插件自己的 Unix socket（macOS）或回环 HTTP 路由（Windows），不经浏览器页面。

## 注意
  - 菜单化后不再依赖对 app.asar 打补丁。
