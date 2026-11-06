# 工具输出瘦身

对过长的工具输出做压缩：模型先看到摘要与字节数，完整原文写进 spill 存储，需要时按路径取回。

## 工作方式

- 挂在 `tools/post-execute` waterfall 上（native 与 PTC 执行路径共用），不加 `prepend`（最内层），看到的是原始结果。
- 用外部 rtk 精简：按内容家族选 `-f <filter>`，认不出走裸 `rtk pipe` 透传。
- 替换前过四道闸门：标记逐字保全、失败证据保全、压缩比合理、必须严格变小；任一不过就保留原文。
- 原文写入 spill（官方 `ctx.spillStore`），替换后附一行 rtk condensed 通知。

## 口径

- 只替换模型可见的 `content`；命令、`value`、`isError` 都不动。
- `accept` 决定携带 `value` 时原样放行。
