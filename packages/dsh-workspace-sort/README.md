# dsh-workspace-sort

DSH（DeepSeek Harness）Web 插件：把左侧「工作区」按**最近一次人工提问**的时间排序，最近用过的项目排在前面。

官方侧栏的「视图选项 → 最近更新」排的是**每个工作区内部的会话**，从不排工作区本身；工作区顺序只由宿主保存的拖拽顺序决定。所以那个选项看起来「没生效」——它本来就不管工作区。本插件补的就是这一层。

## 行为

- **排序依据**：每个工作区里最新一条「你发出的提问」的时间（会话摘要的 `updatedAt`，也就是列表行上显示的那个时间）。打开会话、助手回复、后台任务跑完都不算活动，不会让顺序跳动。
- **容器目录按子树汇总**：`~/Documents/Code/Mubea` 这类只用来分组的目录自己往往没有会话。它按整个子树的最新活动参与排序，否则这个分组会沉到底部。
- **树形分组下同时排两级**：侧栏是「按工作区树」时，根分组之间、同级子项之间都按活动排——因为树是按路径推导出来的，排的是宿主持久化的平铺顺序。
- **写进宿主**：顺序通过官方的 `workspaces.insertBefore`（与拖拽同一个命令）写入 `$DSH_HOME/storages/workspace.json`，刷新页面、换窗口、重启都保留。
- **手动拖拽优先**：你用鼠标拖过之后，插件停手，直到下一次人工提问再按活动重排。不会在你拖着的时候把行抢走。
- **无变化不写盘**：算出来的顺序和当前一致时，一个字节都不写。
- **装完立刻排一次**：第一次装载（或每次页面加载，`initialSort: true`）就按当前活动排一次；之后只在有新提问时动。

## 安装

```sh
dsh plugin --profile desktop add /path/to/packages/dsh-workspace-sort
```

装完不用重启宿主：客户端半边会随插件图一起加载；如果页面没自动更新，用菜单「DSH Desktop Beta → 重新加载界面」重载一次页面即可（关掉再开不算重启宿主）。改了 `index.js`（宿主半边）才需要重启宿主。

## 配置

配置在插件的 load 行（profile 的 `cordis.patch.yml`）里，三项都可选：

```yaml
- id: workspace-sort
  config:
    enabled: true        # false = 宿主半边不挂路由，浏览器半边保持静默，顺序不动
    aggregate: true      # false = 容器目录只按自己的会话算（不含子树）
    initialSort: true    # false = 不在页面加载时排，等下一次提问
```

把整行 `disabled: true` 是更彻底的回退：两个半边都不挂载。

## 回退

1. 关掉：把 load 行的 `config.enabled` 设成 `false`（宿主半边不挂路由，浏览器半边静默），或整行 `disabled: true`。
2. 彻底卸载：插件管理器里移除 `dsh-workspace-sort` 这个 bundle，或 `dsh plugin --profile desktop remove dsh-workspace-sort`。
3. 已经写进宿主的顺序**不会**自动回到装插件之前——那是宿主状态，和手动拖拽的结果一样。要恢复成你的手动顺序，关掉插件后自己拖一遍即可；装之前我只留了前 5 条 id 的快照，没有完整备份。

## 数据与副作用

- 顺序是**宿主持久状态**：写在 `$DSH_HOME/storages/workspace.json` 的 `global.workspaceIds` 里，和其他窗口、其他浏览器一致。
- 活动取自会话列表的 `updatedAt`（持久化的最后一条人类提问时间）；空白新会话（草稿）与子代理会话不计入。
- 每次实际重排，宿主半边写一行日志（`dsh-workspace-sort: reordered N workspace(s), newest activity ...`）。
- 诊断：`GET http://127.0.0.1:<端口>/dsh-workspace-sort/api/state` 返回当前生效的配置与**最后一次重排决策**（`current` / `desired` / `moves` / `newest`）。想知道「我的列表为什么动了」，看这一个响应就够。
- 插件不落任何浏览器存储，不联网，不读写你的文件。

## 已知限制

- 只按「最近一次提问」排，没有置顶、没有「运行中的工作区优先」；需要这些请装社区插件 `@aeroscis/dsh-workspace-manager`（它做活动上浮 + 置顶 + 拖拽面板 + 一键整理）。
- 顺序写在宿主里，所以**是全局的**，不是某个浏览器窗口的视图偏好。
- 依赖客户端服务的内部形状（`ctx.workspaces.list`、`ctx.sessions.list` 的 `updatedAt`）。DSH 改这两处结构时插件需要跟着改；`engines.dsh` 只声明到 0.2.x 就是这条限制的体现。
- 「按工作区」（非树形）分组下，容器目录照样按子树参与排序：`Code/Mubea` 这类没有会话的分组会浮在它最活跃的子项目正上方。如果你在扁平分组下不想看到这条空行浮上来，把 `aggregate` 设成 `false`（容器只按自己的会话算，自然沉底）。

## 开发

```sh
npm run build   # src/sort.js 内联进 src/client.js → lib/client.js
npm test        # node --test：改写的纯规则（父级推导、活动聚合、目标顺序、move 计划）
```

`src/sort.js` 是纯函数（可测）；`src/client.js` 是浏览器半边（组装、订阅、写盘）；`index.js` 是宿主半边（配置 + 诊断路由 + 日志）。客户端 bundle 是手写经典脚本 + 15 行拼装，不走打包器。

## 许可

[MIT](LICENSE)
