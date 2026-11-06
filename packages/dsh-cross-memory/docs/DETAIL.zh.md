# 跨记忆：实现说明

dsh-cross-memory 把会话里值得长期保留的内容（偏好、决定、踩坑、承诺）抽取成条目，按 `global` 与 `project` 两个作用域存进本机记忆库；后续会话按分层预算把记忆注入上下文，模型也可以用 `memory` 工具主动读写。安装、配置项与命令清单见 [README](../README.md)，本文说明实现分层与边界。

## 作用域与条目文件

- `global` 存跨项目成立的事实，目录是 `$DSH_HOME/memories`；`project` 存只对一个工作区成立的事实，目录是 `$DSH_HOME/memories/projects/<slug>`，同一工作区的任意子目录启动的会话共用这一份。
- 条目 ID 由标题派生（`slugify(title)`），标题即身份：同名再写是更新，不是新增。
- 条目文件是 frontmatter + 正文的 Markdown；frontmatter 记 `id`、`scope`、`kind`、`title`、`tags`、`keys`、`appliesTo`、`source`、`created`/`updated`，可选 `durability: snapshot` 与 `asOf`、`pinned`、`permanent`、`voice: user`、`supersedes`、`derivedFrom`；自动抽取的条目另带 `session`（来源会话）、`quote`（逐字引文）与 `evidenceSeq`。
- 文件是唯一真相，`index.json` 只是可重建的索引缓存，手改或删除后下一次读取会自愈。

## 注入分层

每个会话按顺序拿到下面这些块，每块都有自己的预算：

1. `<persona>`：用户画像快照，预算 `personaMaxBytes`（默认 12000 字节，`0` 关闭），超长部分按行截断。旧的单文件 `persona.md` 仍会被读取，保存后写到 `persona/human.md`。
2. 记忆摘要：在 `maxSummaryBytes`（默认 4096）内分 `global` 与 `project` 两段；两段共用一个字节预算，`global` 先渲染，另有 `globalSummaryEntries` 与 `globalSummaryBytes` 限制它的大小。
3. 增量块：摘要注入之后新写入的记忆以小块补发（`injectDelta`，每会话最多两次）。
4. 标题轮转：只列摘要没提到的标题，每会话 `rotationEntries`（默认 16）条，同一个长会话里每 `rotationEveryTurns`（默认 8）个用户轮重新发一次。
5. 按需补注：当前用户轮与某条记忆的标题、`keys`、`tags`、`appliesTo` 命中足够多的实词（或整句短语命中）才会注入（`recallMinTerms` 默认 2、`recallMinScore` 默认 9、每会话最多 `recallMaxPerConversation` 条）；在单个作用域里出现比例超过 `evidenceMaxDf`（默认 0.15）的词不计入证据。
6. 原始片段：`rawRecall` 打开时，补注块附带来源会话的原文片段，只读本机会话日志。

注入块都写明记忆是背景数据、不是指令，并且记录的是写入时成立的事实，可能已经过期。

## 抽取

抽取是第一遍，跑在维护路径上，不碰对话内容：

- 会话空闲 `autoExtractIdleMs`（默认 300000 毫秒）后被扫描；`extractIntervalMinutes`（默认 30）另按周期检查所有未结束会话。`minIdleHours`（默认 6）与 `maxAgeDays`（默认 10）决定一条会话还能不能被抽取，每轮最多处理 `maxSessionsPerPass`（默认 2）个会话。
- 一次抽取读最近 `extractWindowMessages`（默认 60）条消息，只取用户与助手正文，丢弃工具结果和插件注入的内容，避免记忆自噬。
- 每条候选记忆必须带一段逐字引文，且引文要能在本次窗口的原文里找到，否则丢弃；落盘前统一做密钥擦除（`sk-…`、`ghp_…`、`AKIA…`、JWT、私钥块、`api_key=…`、`Bearer …` 等）。
- 后台模型调用受成本与配额保护：`peakHours` 可把后台调用推到谷时（默认空），`pauseOnQuotaError`（默认开）在限流或配额不足后暂停，冷却从 `quotaCooldownMinutes`（默认 30）起逐次翻倍，上限 `quotaCooldownMaxMinutes`（默认 480）。

## 合并与待裁决

合并是第二遍，处理跨会话的矛盾与碎片：

- 一批记忆交给一个不含任何工具的子代理（预设 `memories-consolidator`），它只返回严格 JSON 方案；插件自己应用方案，并在应用前留快照，出错的改动可以回滚。部署没有预设注册表时退回一次无工具的普通模型调用。
- 可以自动执行的是可逆改动：合并重复、收紧措辞、退役从没被读过的条目。可能丢信息的改写与退役进入**待裁决**：人手写、置顶或永久保留的条目，被读到过的退役，丢失正文里文件路径引用或正文不到原来一半的改写，都不会被静默处理。
- 已在库里的条目不会换作用域，新记忆才由这一遍决定放在 `global` 还是 `project`。
- 待裁决方案在 `consolidateProposalMaxAgeHours`（默认 72）小时后自动作废；`autoDecide`（默认开）允许 AI 先判断是否丢信息，置信度低于 `autoDecideMinConfidence`（默认 0.7）时仍然留给你。
- 两条记忆互相矛盾时，子代理把这一对列进冲突报告（保留哪条、丢弃哪条），而不是悄悄挑一个。
- 合并会维护画像，`persona/human.lock` 存在时跳过；也会把重复流程提成技能草稿（每轮最多 2 个），草稿落在 `memories/skills/<name>/SKILL.md`，`/memories promote` 才复制到 `$DSH_HOME/skills/<name>/SKILL.md`；已晋升的文件比草稿新时，重复晋升会被拒绝。

## 保留与归档

- `maxUnusedDays`（默认 90）内没有被读到、没有被注入摘要、也不是新写的记忆会被归档；归档不是删除，`/memories restore` 可以取回。
- `durability=snapshot` 的条目另按 `snapshotMaxAgeDays`（默认 60）从测量时间起算归档，被读一次不会让读数变新。
- `maxEntriesPerScope`（默认 1000）是每个作用域的上限，超出时归档最久没有被读到或注入的条目；`pinned`、`permanent` 与 `source=user` 的条目不会被自动退役，所以作用域可能略超上限。
- 每个作用域的 `archive/` 目录只保留最新的 500 个文件，更早的归档会被清理。
- `sessions/` 下的证据笔记只保留最新的 200 份，更早的会被清掉；笔记不在时 `evidence` 会直接说明没有这份证据笔记，而不是编造内容。
- `/memories forget` 与 `memory` 工具的 `forget` 是**物理删除**，不可恢复。

## 存储、日志与多机同步

- 条目、证据笔记、画像、反思与技能草稿都是普通文件，可直接读写；水位线、任务租约与用量计数在 `state.db`（Node 内置 `node:sqlite`）。取不到 `node:sqlite` 时水位线只在进程内保存，重启后可能重复抽取已经处理过的会话。
- 插件日志默认在 `$DSH_HOME/logs/dsh-cross-memory.log`，单文件到 2 MB 轮转一代，旧文件改名为 `<path>.1`，只保留这一代。`npm run report` 只读地汇总日志与 `state.db`。
- 记忆库本身是 Git 工作副本：写入只做本地提交（`syncDebounceSeconds` 默认 2 秒合并一批），拉取与推送在后台定时进行（`syncClock` 默认 `12:05,18:05`，留空回退到 `syncIntervalMinutes` 默认 10 分钟，`0` 关闭定时器）。同步路径里的任何失败都不会让一次记忆写入失败，也不会把仓库留在 rebase 中间。
- 记忆库根目录的 `.gitignore` 固定忽略每台机器自己的状态：`state.db`、`state.db-shm`、`state.db-wal`、`index.json`、各级 `**/index.json`、`**/project.json`、`pending/`、`*.log`、`.DS_Store`。
- 冲突处理：能安全合并的自动合并；可能丢信息的进入**待裁决**；没有可用模型路由时按 `updated` 时间取新版，旧文本留在 Git 历史里。归档条目的冲突按更新时间取新版，不进待裁决。

## 浏览器接口与设置页

- 插件通过 Typert 向浏览器暴露 `memories` 命名空间，共 10 个方法：`overview`、`list`、`add`、`forget`、`promoteSkill`、`discardSkill`、`persona`、`savePersona`、`disputes`、`resolveDispute`。
- 设置页「记忆」有四个标签：记忆、画像、配置、待裁决；同一个配置卡也出现在插件页该包下。
- 没有网关的部署（headless、tui）只是没有这张页面，模型工具、`/memories` 命令与自动维护照常工作。

## 注意与限制

- 检索与召回都是词法匹配，不是向量检索：标题、`keys`、`tags`、`appliesTo`、正文按权重计分，再叠时间衰减与沿共享 `keys`/`tags` 的一跳扩展；按需补注的门槛只认标题、`keys`、`tags`、`appliesTo` 四个字段。中文按字符二元组处理，共享两个汉字记为一次强命中。
- 注入的记忆是写入当时的结论，不是当前事实；需要判断时用 `memory` 的 `evidence` 打开来源会话。
- `durability=snapshot` 的数字从测量时间起算过期，不要用它代替会自己变化的读数。
- 合并与抽取都受配额与谷时限制，后台不保证在某个时刻一定跑过。
