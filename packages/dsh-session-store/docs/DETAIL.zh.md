# 会话存储共享库

纯库：没有宿主路由与 UI，给 dsh-session-toolbox 等插件提供会话存储的共享实现。

## 提供什么
  - 项目目录 key 编解码（projectKey、encodeSegment）。
  - session.jsonl.zstd 帧扫描与 header 解析、改写。
  - 工作区注册表读取与成员操作辅助。
  - 会话写入句柄重定向（搬迁时把后续写入指到新位置）。

## 注意
  - 内核无关；v4 日志格式已在真实日志上实测。
  - 由工具箱以 dsh-session-store 依赖引入，单独挂载没有可见效果。
