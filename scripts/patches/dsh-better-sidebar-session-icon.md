# dsh-better-sidebar 0.30.0：会话行尾图标（本地补丁）

## 做了什么

给 `dsh-better-sidebar@0.30.0` 的客户端产物 `lib/client.js` 注入一处 slot 注册：

- slot：`sidebar.session.row.trailing`（DSH 0.2.2 起由 `@deepseek-ai/dsh-client-ui-workspace` 为每个 Session 行声明；list、root scope、只收 `sessionId`、非交互、按 `order` 升序，位置在时间标签之后、置顶标记之前）
- 注册：`ctx.slots.inject(...)` + `ctx.slots.register({ name, id: 'dsh-better-sidebar:session-row-tabs', order: 10 }, sessionRowTabsIcon)`
- 图标：14px 内联 SVG（分栏面板形），`opacity: .6`，带 `data-better-sidebar-row-tabs=""` 便于以后无头验证；没有 onClick/tabIndex，遵守非交互约定

### 宿主渲染契约（这次核对过，决定了注入写法）

从已安装宿主（桌面 2.0.22-beta.1 / 内核 0.2.2-rc.1）的 `ui-renderer` 里确认：

- `runInject(entry, binding, actions)` 只在有 scope binding 时才把 `binding.key` 当第一个参数；**root-scope 条目调用 `inject()` 无参且按条目缓存一次**（`cachedRootInject`）
- 渲染时 props 合并顺序是 `{ ...kit, ...injected, ...slotInjected.props, ...ownerProps }`，**ownerProps 最后覆盖**
- 该 slot 的 ownerProps 类型是 `{ readonly sessionId: SessionId }`（宿主行渲染 `renderSlot('sidebar.session.row.trailing', { sessionId: node.id })`）

所以：sessionId 走组件 prop，**不要**从 `inject(sessionId)` 拿；store 通过 apply 里创建的组件包装器传入。注册里不放 `inject`：root 条目的 inject face 无参且按条目缓存一次，同 slot 的 `forge-panel.row` 传的无参 inject 只能放跨行共享的 state，无法区分 session（slot 目录里该 slot 的 `slotInject` 也是空）。

## 显示条件（语义）

仅当该会话在 better-sidebar 的持久化布局里**还有打开的页签**：

- 已在本 run 加载进 store 的会话：`store.getSessionState(sessionId)` 的 `bottomSplits` 叶子 `tabs.length > 0`，跟随 store 通知即时变化
- 其余会话：读 `localStorage['dsh-sidebar:v1:' + sessionId]` 并解析 `bottomSplits`；按原始字符串做上限 512 条的 memo，只有 raw 变化才重新 JSON.parse
- 只展开过目录、或开过底部面板但没有页签：不显示
- 带 `?dsh-sidebar-reset` 的页面加载中不显示（与上游重置逃生口一致）
- 读不到存储 / JSON 损坏 / 缺 sessionId：不显示，不抛

如果要改成“只要有持久化状态就显示”（含仅展开目录），把 `countSessionRowTabs(...) > 0` 换成 `raw !== null` 即可。

## 补丁的 3 处改动（只动 lib/client.js）

1. `zh` / `en` 字典各加 `sessionRowTabsTitle`（tooltip 文案：此会话有侧栏页签 / This session has sidebar tabs；其它语言回退 en）
2. 模块作用域：helper + `SessionRowTabsIcon(props, store)` 组件，标记 `[local-patch:session-row-icon-helpers]`
3. `apply()` 里 `ctx.provide("betterSidebar", service)` 之后：商店包装组件 + slot 注册，标记 `[local-patch:session-row-icon-register]`

发布包里的 `src/` 是不参与构建的 TypeScript 源码；补丁只改运行产物，不改 `src/`。

## 生成方式

- 基线：0.30.0 的 `lib/client.js` sha256 `75e62ed70aacabca4da68cb0048dd8e078c6fcdf81e2cf58fc1db7cec90d2575`
- 打完：`30173b2f2bcc385e0a5792a4fd7cef2f12deeee2876fe92482dc9c2a4dd05017`
- 补丁文件 sha256：`cc620d8de0ed6d7120930f9a660160c787383bea884d39d3bda0844b75d4eee5`

```sh
# 修改副本（git init 后改，diff 基准就是包根）
rsync -a "$PROFILE/node_modules/dsh-better-sidebar/" /tmp/bs/pkg/
cd /tmp/bs/pkg && git init -q && git add -A && git commit -qm base
# ……改 lib/client.js 的三处……
node --check lib/client.js
git diff --no-color > dsh-better-sidebar-session-icon.patch
```

等价的 `git diff --no-index` 写法（两条路径产出逐字节相同）：

```sh
# a/lib/client.js = 原文件，b/lib/client.js = 改后文件
git diff --no-index --no-color a b |
  sed -e 's|^diff --git a/a/\(.*\) b/b/\(.*\)$|diff --git a/\1 b/\2|' \
      -e 's|^--- a/a/|--- a/|' -e 's|^+++ b/b/|+++ b/|'
```

补丁以包根为基准，文件头是 `a/lib/client.js` / `b/lib/client.js`。

## 应用到 profile（由 Lead 执行；本会话未改 profile）

```sh
cp dsh-better-sidebar-session-icon.patch ~/.dsh/profiles/desktop/patches/
```

`~/.dsh/profiles/desktop/pnpm-workspace.yaml`：

```yaml
patchedDependencies:
  'dsh-better-sidebar@0.30.0': patches/dsh-better-sidebar-session-icon.patch
```

然后在 profile 目录 `pnpm install`（本 profile 是 pnpm 11 store；版本不匹配会 ERR_PNPM_UNEXPECTED_STORE）。装完核实：

```sh
shasum -a 256 ~/.dsh/profiles/desktop/node_modules/dsh-better-sidebar/lib/client.js
# 期望 30173b2f2bcc385e0a5792a4fd7cef2f12deeee2876fe92482dc9c2a4dd05017
node --check ~/.dsh/profiles/desktop/node_modules/dsh-better-sidebar/lib/client.js
```

应用补丁会重写 node_modules 里的包文件；按约定本会话没有执行。装完后页面只需刷新还是需要重启宿主**未验证**：客户端 bundle 由宿主按包路径读取，可能受模块缓存影响。

## 回滚

删掉 `patchedDependencies` 那一行和补丁文件，再 `pnpm install`（必要时 `--force`），node_modules 回到 registry 版本。

## 已验证 / 未验证

已验证：

- `node --check lib/client.js` 通过
- `git apply --check` 对全新解包副本通过；应用后 `git status --porcelain` 只有 `M lib/client.js`，结果 sha256 与预期一致
- `git diff` 与 `git diff --no-index` 两条生成路径产出逐字节相同的补丁
- 静态（12/12）：从补丁后的文件反向剥掉注入块能逐字节还原 0.30.0 原文件；`exports.apply` / `exports.inject` / `window.__ModuleLoader__.load` 入口不变；`slots.inject` 调用点 6 → 7；注册使用 `id`/`order`、不经 inject、store 经包装组件绑定
- 逻辑单测（13/13）：从补丁后 bundle 按标记提取注入块，stub React 直接调用组件 —— 嵌套 split 页签计数、缓存命中/空（缓存优先于旧 localStorage）/无存储/坏 JSON/reset、图标尺寸与无交互属性、订阅 store、缺 sessionId 返回 null、元素类型合法
- 宿主契约核对：见上文“宿主渲染契约”，来自 app.asar 里 ui-renderer 的实现与 slot 目录条目

未验证：

- **未做页面级验证**：没有装补丁、没有刷新页面，行尾图标的实际位置、间距、主题色观感都没有截图证据
- 没有在真实宿主里调用该注册（slot 声明存在性已在 app.asar 中确认）
- better-locale 其它语言下的 tooltip：新 key 只进 zh/en，其余回退 en

## 风险

- 版本钉死：升级 dsh-better-sidebar 后 `pnpm install` 会 `ERR_PNPM_PATCH_FAILED`，必须按新版本重做并重新生成；升级前先确认上游是否已自带行尾图标
- 客户端 bundle 补丁不受上游类型检查/测试覆盖；若上游改 `apply` 结构或把该 slot 改成 keyed，注册可能失效。`slots.inject` 会等声明，通常表现为静默不显示，不应影响侧栏本体
- 图标数据源是 localStorage 的布局副本：其它标签页对本页未加载会话的写入不会即时反映到本页图标，下一次渲染或切到该会话后一致
- 每行一次 `localStorage.getItem`，解析有 memo；会话列表很长时开销可忽略但非零
- 宿主 hover 时整块 `.rowResting`（时间 + 行尾图标 + 置顶标）被操作按钮替换，图标随隐藏，这是宿主既有行为
