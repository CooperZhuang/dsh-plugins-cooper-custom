# 工具输出瘦身

对过长的工具输出做压缩：模型先看到摘要与字节数，完整原文写进 spill 存储，需要时按路径取回。

## 工作方式
  - 挂在 tools/post-execute waterfall 上，native 与 PTC 执行路径共用这条流水线。
  - 按内容类型挑选压缩器（行数/字节阈值、format 提示），输出 rtk condensed 通知。
  - 原文写入 spill（目录由 profile 的 spill-local 行固定），可随时取回。

## 口径
  - native 模式：压缩直接影响模型可见输出。
  - PTC 模式：压缩只作用于会话日志里的 dispatch content，模型拿到的是程序返回值，上下文大小不变。
