# dsh-workspace-sort

DSH（DeepSeek Harness）Web 插件：给左侧「工作区」那一层补排序能力——按最近一次人工提问自动排、置顶几个常驻、运行中的排前面，并提供一个只看排序的小面板。

官方侧栏的「视图选项 → 最近更新」排的是**每个工作区内部的会话**，从不排工作区本身；工作区顺序只由宿主保存的拖拽顺序决定。所以那个选项看起来「没生效」——它本来就不管工作区。

本插件仿的是社区插件 `@aeroscis/dsh-workspace-manager` 的**排序部分**，只保留安全功能：不搬目录、不改路径、不删工作区、不迁移会话、不起子进程。

## 功能

- **按最近提问自动排序**：每个工作区取最新一条「你发出的提问」的时间（会话摘要的 `updatedAt`）。打开会话、助手回复、后台任务跑完都不算活动，不会让顺序跳动。
- **容器目录按子树汇总**：`~/Documents/Code/Mubea` 这类只用来分组的目录自己没有会话，按整个子树的最新活动参与排序，否则这个分组会沉到底部。
- **置顶**：把几个常驻工作区钉在列表最前，按你钉的顺序排列，不参与活动排序。
- **运行中的排前面**：可选。某个工作区里有会话正在跑，就排在未置顶区的前面，长任务不会沉出视野。
- **面板**（侧栏底部 Settings 旁边多一个图标）：列出全部工作区，显示会话数、运行中会话数、最近活动相对时间；支持按名称筛选、点图钉置顶、开关上面两条规则、点「立即整理」立刻重排一次。
- **手动拖拽优先**：你用鼠标拖过之后，插件停手，直到下一次提问或你点「立即整理」。
- **无变化不写盘**：算出来的顺序和当前一致时，一个字节都不写。

## 实现要点

- 顺序只通过官方 `workspaces.insertBefore` 写入（与拖拽同一个命令），落在 `$DSH_HOME/storages/workspace.json` 的持久顺序里，刷新、换窗口、重启都保留。
- 置顶与两个开关存在宿主侧 `$DSH_HOME/workspace-sort/prefs.json`（原子写：tmp 后 rename）。**不用 localStorage**：桌面端 Web 服务绑定的是随机端口（`port: 0`），页面 origin 每次重启都变，localStorage 会跟着丢。
- 宿主半边只有两条回环路由：`GET /dsh-workspace-sort/api/state`（配置 + 位置 + 最后一次重排决策）和 `POST /dsh-workspace-sort/api/prefs`（保存置顶与开关）。没有文件系统操作、没有子进程、没有会话操作。
- 面板与入口都用官方 Slot：`sidebar.footer.action`（按钮）和 `shell.overlay`（面板），不查 DOM 类名。

## 安装

```sh
dsh plugin --profile desktop add /path/to/packages/dsh-workspace-sort
```

生效条件：

- 第一次安装 / 改了 `index.js`（宿主半边）：重启一次宿主。
- 只改了浏览器半边：菜单「DSH Desktop Beta → 重新加载界面」重载页面即可。

## 配置

配置在插件的 load 行（profile 的 `cordis.patch.yml`）里：

```yaml
- id: workspace-sort
  config:
    enabled: true        # false = 宿主半边不挂路由，浏览器半边静默，顺序不动
    aggregate: true      # false = 容器目录只按自己的会话算（不含子树）
    initialSort: true    # false = 页面加载时不排，等下一次提问或手动整理
```

置顶与「运行中优先」不在这里，它们在面板里改、存 `prefs.json`。整行 `disabled: true` 是彻底回退。

## 数据与副作用

- 顺序是**宿主持久状态**，写在 `$DSH_HOME/storages/workspace.json` 的 `global.workspaceIds`，和其他窗口一致。
- 活动来自会话列表的 `updatedAt`（持久化的最后一条人类提问时间）；空白新会话（草稿）与子代理会话不计入。
- 每次实际重排宿主写一行日志；`GET /dsh-workspace-sort/api/state` 返回最后一次重排的 `current` / `desired` / `moves` / `newest`。
- 不联网（除了本机回环路由），不读写你的项目文件。

## 与社区插件的差别

| 能力 | 本插件 | 社区 `dsh-workspace-manager` |
|---|---|---|
| 按活动排序 / 置顶 / 面板 | 有 | 有（活动规则是「升到第一个非运行工作区之上」） |
| 入口位置 | 侧栏底部 Slot（官方分配位置） | 侧栏标题行插 DOM（依赖 CSS Module 类名） |
| 路径迁移（改登记 / 搬目录 / 迁会话） | **没有** | 有（`rename` / `cp` / `rm` + 会话 fork） |
| 移除工作区 / 清理空工作区 | **没有** | 有（删注册表项，会话进「未分组」） |
| 打开工作区目录 | **没有** | 有（宿主起系统命令） |

## 已知限制

- 置顶存在本机 `prefs.json`，不随 DSH 跨机同步。
- 「按工作区」（非树形）分组下，容器空行会浮在它最活跃的子项目上方；不想要就把 `aggregate` 设成 `false`。
- 依赖客户端服务的内部形状（`ctx.workspaces.list`、`ctx.sessions.list.byId` 的 `updatedAt` / `running` / `blank`）。DSH 改这两处时插件要跟着改，`engines.dsh` 只声明到 0.2.x 就是这个意思。
- 顺序写进宿主，是全局行为，不是某个窗口的视图偏好。

## 开发

```sh
npm run build   # src/sort.js 内联进 src/client.js → lib/client.js
npm test        # node --test：父级推导、活动聚合、置顶、运行中优先、目标顺序、move 计划（11 例）
```

`src/sort.js` 是纯函数（可测）；`src/client.js` 是浏览器半边（引擎 + 两个 Slot 组件）；`index.js` 是宿主半边（配置、prefs 文件、两条路由、日志）。没有打包器。

## 许可

[MIT](LICENSE)
