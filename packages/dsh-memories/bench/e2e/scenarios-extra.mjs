/**
 * 扩展场景库：给端到端记忆评测再加 30 个「编码助手长期记忆」场景。
 *
 * 每个场景仍是一条短编码会话，其中明说一组将来要考的事实，外加一条未来会话会问的问题。
 * 与 scenarios.mjs 的分工：
 *  - 项目名、产品名、主题与那 23 条互不重复，避免某条场景悄悄改掉另一条的答案；
 *  - 十类各 3 条，其中至少 5 条带「相似干扰」：同一场景里另有一件相似但不该混淆的事，
 *    或答案必须区分是谁说的、哪一天发生的；
 *  - 事实在对话里明说，不靠推断；问题不描述提问之后才发生的事；
 *  - required 是判分点（1-2 条），forbidden 必须是明确错误主张（0-1 条），宁可留空。
 *
 * run.mjs 目前只读 scenarios.mjs，本文件独立导出，不改变已有题库的哈希。
 */

/** @typedef {{ role: 'user' | 'assistant', text: string }} Turn */
/**
 * @typedef {object} Scenario
 * @property {string} id
 * @property {string} category
 * @property {Turn[]} turns
 * @property {string} question
 * @property {string[]} required
 * @property {string[]} forbidden
 */

/** @type {Scenario[]} */
export const SCENARIOS_EXTRA = [
  // 命令/约定
  {
    id: 'compose-dev-up',
    category: '命令/约定',
    turns: [
      { role: 'user', text: '烽火报表本地起依赖统一用 docker compose -f compose.dev.yml up -d，别用默认的 compose.yml。' },
      { role: 'assistant', text: '好，本地用 compose.dev.yml。' },
      { role: 'user', text: '默认那个文件别动，CI 还在读它。' },
      { role: 'assistant', text: 'compose.yml 留给 CI，不动。' },
      { role: 'user', text: '停服务用 docker compose -f compose.dev.yml down，别加 -v，卷里的数据要留着。' },
      { role: 'assistant', text: '停服务不加 -v，保留数据卷。' },
    ],
    question: '这个项目本地起依赖和停依赖分别用什么命令？默认的 compose 文件留给谁用？',
    required: ['本地起依赖用 docker compose -f compose.dev.yml up -d', '停的时候不加 -v，数据卷要留着'],
    forbidden: ['本地起依赖用默认的 compose.yml'],
  },
  {
    id: 'alembic-migration-command',
    category: '命令/约定',
    turns: [
      { role: 'user', text: '海雀日程的库迁移统一走 uv run alembic -c configs/alembic.ini upgrade head，别用系统里那个 alembic。' },
      { role: 'assistant', text: '好，用 uv run 加显式的配置文件。' },
      { role: 'user', text: '生产改表不允许手写 SQL，必须落成迁移脚本。' },
      { role: 'assistant', text: '生产只走迁移脚本。' },
      { role: 'user', text: '本地测试库可以直接删了重建，不用管迁移顺序。' },
      { role: 'assistant', text: '本地测试库可以删重建。' },
    ],
    question: '这个项目执行数据库迁移的标准命令是什么？生产上改表允许手写 SQL 吗？',
    required: ['迁移用 uv run alembic -c configs/alembic.ini upgrade head', '生产不允许手写 SQL 改表'],
    forbidden: ['生产可以手写 SQL 改表'],
  },
  {
    id: 'commit-msg-ticket',
    category: '命令/约定',
    turns: [
      { role: 'user', text: '松鼠记账的提交信息必须带财务工单号，格式是 [FIN-1234] 加空格再写说明。' },
      { role: 'assistant', text: '好，提交信息以 [FIN-工单号] 开头。' },
      { role: 'user', text: '分支保护会拦，格式不对直接 push 不上去。' },
      { role: 'assistant', text: '明白，格式不对会被拦。' },
      { role: 'user', text: '本地校验钩子用 uv run pre-commit run --all-files，别只跑改动的那一个文件。' },
      { role: 'assistant', text: '提交前跑全量 pre-commit。' },
    ],
    question: '这个项目的提交信息格式是什么？提交前怎么跑钩子检查？',
    required: ['提交信息以 [FIN-工单号] 开头', '钩子跑 uv run pre-commit run --all-files'],
    forbidden: ['提交信息不需要工单号'],
  },

  // 架构决策
  {
    id: 'event-bus-nats',
    category: '架构决策',
    turns: [
      { role: 'user', text: '白鹭工单的事件总线定下来了，用 NATS JetStream，不用 Kafka，运维不想再养一套集群。' },
      { role: 'assistant', text: '好，事件总线用 NATS JetStream。' },
      { role: 'user', text: '最早也考虑过 Kafka，评估下来维护成本太高，已经否掉了。' },
      { role: 'assistant', text: 'Kafka 只是备选，已否。' },
      { role: 'user', text: '主题命名按 ticket.created、ticket.closed 这种全小写点分。' },
      { role: 'assistant', text: '主题用全小写点分。' },
    ],
    question: '这个项目的事件总线最后选了哪个？之前考虑过的 Kafka 是什么结论？',
    required: ['事件总线用 NATS JetStream', 'Kafka 已经被否掉'],
    forbidden: ['用 Kafka 做事件总线'],
  },
  {
    id: 'keep-monolith',
    category: '架构决策',
    turns: [
      { role: 'user', text: '青柠课程决定不拆微服务了，继续单体，但按模块分目录。' },
      { role: 'assistant', text: '好，保持单体部署。' },
      { role: 'user', text: '拆成七个服务的方案先存档，别真动。' },
      { role: 'assistant', text: '拆微服务的方案只存档，不实施。' },
      { role: 'user', text: '模块边界按 course/ 和 payment/ 两个顶层目录划，跨模块只能走导出的接口。' },
      { role: 'assistant', text: '模块按 course 和 payment 分，跨模块走导出接口。' },
    ],
    question: '这个项目现在是单体还是微服务？之前拆成七个服务的方案怎么处理？',
    required: ['继续单体部署', '拆微服务的方案只存档不实施'],
    forbidden: ['已经拆成微服务'],
  },
  {
    id: 'cache-cluster-shape',
    category: '架构决策',
    turns: [
      { role: 'user', text: '灰鲸图库的缓存定成 Redis Cluster 三主三从共六个节点，别用单实例。' },
      { role: 'assistant', text: '好，Redis Cluster 六个节点，三主三从。' },
      { role: 'user', text: 'key 前缀统一 gw:，后面再加环境后缀。' },
      { role: 'assistant', text: 'key 前缀 gw: 加环境后缀。' },
      { role: 'user', text: '图片原文件不进缓存，只缓存缩略图。' },
      { role: 'assistant', text: '缓存只放缩略图。' },
    ],
    question: '这个项目的缓存用什么形态、几个节点？key 前缀是什么？',
    required: ['Redis Cluster 三主三从共六个节点', 'key 前缀 gw:'],
    forbidden: ['用 Redis 单实例'],
  },

  // 踩坑/失败
  {
    id: 'collation-pagination-bug',
    category: '踩坑/失败',
    turns: [
      { role: 'user', text: '琥珀地址的列表分页会重复出项，根因是 addr_city 表的排序规则跟别的表不一样，它是 utf8mb4_general_ci，其余表都是 utf8mb4_0900_ai_ci。' },
      { role: 'assistant', text: '所以是排序规则不一致导致的，不是分页 SQL 写错。' },
      { role: 'user', text: '对，先别改分页逻辑，把表的 collation 统一就行。' },
      { role: 'assistant', text: '先统一 collation，不动分页 SQL。' },
      { role: 'user', text: '数据本身没有重复，不要去做去重。' },
      { role: 'assistant', text: '数据没有重复，不做去重。' },
    ],
    question: '分页重复出项的根因是什么？应该先动哪里？',
    required: ['根因是 addr_city 表排序规则不一致', '改表 collation，不改分页 SQL'],
    forbidden: ['根因是分页 SQL 写错'],
  },
  {
    id: 'docker-pypi-timeout',
    category: '踩坑/失败',
    turns: [
      { role: 'user', text: '沙丘爬虫的镜像在 CI 上老是构建失败，最后定位是装依赖时连公网 PyPI 超时，不是代码问题。' },
      { role: 'assistant', text: '是依赖源超时，不是构建脚本的问题。' },
      { role: 'user', text: 'Dockerfile 里已经加了 --index-url http://pypi.dune.internal/simple，改走内网源。' },
      { role: 'assistant', text: '依赖从内网源 pypi.dune.internal 装。' },
      { role: 'user', text: 'CI 的构建超时值别动，本来就够长。' },
      { role: 'assistant', text: '超时值不用改。' },
    ],
    question: '这个项目 CI 镜像构建失败的根因是什么？最后怎么解决的？',
    required: ['根因是连公网 PyPI 超时', '改用内网源 pypi.dune.internal'],
    forbidden: ['根因是构建超时值太小'],
  },
  {
    id: 'symlink-nginx-404',
    category: '踩坑/失败',
    turns: [
      { role: 'user', text: '云杉门户的 Nginx 部署是用 releases/ 下切符号链接发版的，上线后会偶发 404。' },
      { role: 'assistant', text: '是切换符号链接引起的。' },
      { role: 'user', text: '根因是 open_file_cache 缓存了旧 inode，配置里加上 open_file_cache off; 之后就好了。' },
      { role: 'assistant', text: '记下，加 open_file_cache off 解决。' },
      { role: 'user', text: '文件权限没问题，别往权限上查。' },
      { role: 'assistant', text: '不查权限这条线。' },
    ],
    question: '这个项目切符号链接发版后偶发 404，根因和修法分别是什么？',
    required: ['根因是 open_file_cache 缓存了旧 inode', '把 open_file_cache 关掉'],
    forbidden: ['根因是文件权限不对'],
  },

  // 偏好/边界
  {
    id: 'no-auto-merge-deps',
    category: '偏好/边界',
    turns: [
      { role: 'user', text: '灯塔文档的依赖升级 PR 可以自动建，但绝对不能自动合并，合并我自己点。' },
      { role: 'assistant', text: '好，自动建 PR 可以，自动合并不行。' },
      { role: 'user', text: '你帮我把 CI 跑绿就行，别替我点合并。' },
      { role: 'assistant', text: 'CI 我盯，合并留给你。' },
      { role: 'user', text: '安全更新也一样，别因为标了 security 就自己合。' },
      { role: 'assistant', text: '安全更新也不自动合。' },
    ],
    question: '依赖升级 PR 哪些动作可以自动化，哪些不行？',
    required: ['可以自动建 PR 和把 CI 跑绿', '任何依赖 PR 都不能自动合并，包括安全更新'],
    forbidden: ['可以自动合并依赖升级 PR'],
  },
  {
    id: 'ask-before-new-dep',
    category: '偏好/边界',
    turns: [
      { role: 'user', text: '橡果备份要加任何新的第三方依赖之前先问我，尤其 GPL 许可证的，我们发行版不能带。' },
      { role: 'assistant', text: '好，加外部依赖先问，GPL 的避免。' },
      { role: 'user', text: 'devDependencies 也一样，别自己装。' },
      { role: 'assistant', text: 'dev 依赖也要先问。' },
      { role: 'user', text: '内部工具包不算，那个随便用。' },
      { role: 'assistant', text: '内部工具包可以直接加。' },
    ],
    question: '给这个项目加第三方依赖有什么要求？有什么例外？',
    required: ['加外部第三方依赖前要先问我，含 devDependencies', '内部工具包可以直接加'],
    forbidden: ['可以自行安装新的外部依赖'],
  },
  {
    id: 'comment-language',
    category: '偏好/边界',
    turns: [
      { role: 'user', text: '雪松 SDK 是公开仓，里面所有注释和 README 都用英文写。' },
      { role: 'assistant', text: '好，注释和 README 用英文。' },
      { role: 'user', text: '提交信息用中文就行，反正是内部看。' },
      { role: 'assistant', text: '提交信息用中文。' },
      { role: 'user', text: '变量名也别用拼音，用英文。' },
      { role: 'assistant', text: '变量名也用英文，不用拼音。' },
    ],
    question: '这个公开仓里注释、README、提交信息和变量名分别用什么语言？',
    required: ['注释和 README 用英文', '提交信息用中文，且变量名用英文不用拼音'],
    forbidden: ['注释用中文'],
  },

  // 配置/事实
  {
    id: 'rabbitmq-vhost-queue',
    category: '配置/事实',
    turns: [
      { role: 'user', text: '蓝莓队列连的是 RabbitMQ，vhost 固定用 /bq-prod，别用默认的 /。' },
      { role: 'assistant', text: '好，vhost 用 /bq-prod。' },
      { role: 'user', text: '对账单的主消费队列叫 order.batch.v3，重试队列是 order.batch.v3.retry。' },
      { role: 'assistant', text: '队列名记下了。' },
      { role: 'user', text: '这个服务只连 RabbitMQ，别的消息中间件都不接。' },
      { role: 'assistant', text: '只连 RabbitMQ。' },
    ],
    question: '这个服务连的 RabbitMQ vhost 和主消费队列分别叫什么？',
    required: ['vhost 用 /bq-prod', '主消费队列叫 order.batch.v3'],
    forbidden: ['vhost 用默认的 /'],
  },
  {
    id: 's3-bucket-region',
    category: '配置/事实',
    turns: [
      { role: 'user', text: '麦田图片的正式桶是 wf-img-prod-ap3，区域 ap-northeast-1，别写成 us-east-1。' },
      { role: 'assistant', text: '好，正式桶 wf-img-prod-ap3，区域 ap-northeast-1。' },
      { role: 'user', text: '测试桶叫 wf-img-test-ap3，两个别搞混。' },
      { role: 'assistant', text: '测试桶是 wf-img-test-ap3。' },
      { role: 'user', text: '签名 URL 默认有效期 600 秒。' },
      { role: 'assistant', text: '签名 URL 有效期 600 秒。' },
    ],
    question: '正式环境的图片桶名和区域是什么？测试桶叫什么？',
    required: ['正式桶 wf-img-prod-ap3，区域 ap-northeast-1', '测试桶叫 wf-img-test-ap3'],
    forbidden: ['正式桶区域是 us-east-1'],
  },
  {
    id: 'cron-inspection-schedule',
    category: '配置/事实',
    turns: [
      { role: 'user', text: '蜜柚巡检的定时任务是每天 04:17 跑，cron 写的是 17 4 * * *。' },
      { role: 'assistant', text: '好，17 4 * * *，每天 04:17。' },
      { role: 'user', text: '千万别改成整点，整点和备份任务撞。' },
      { role: 'assistant', text: '保持 04:17，避开整点。' },
      { role: 'user', text: '日志落到 /var/log/pomelo/inspect.log。' },
      { role: 'assistant', text: '日志路径记下了。' },
    ],
    question: '这个巡检任务每天几点跑，cron 表达式是什么？',
    required: ['每天 04:17 跑', 'cron 是 17 4 * * *'],
    forbidden: ['把巡检改成整点执行'],
  },

  // 更正/变化
  {
    id: 'changed-db-host',
    category: '更正/变化',
    turns: [
      { role: 'user', text: '竹影订单的生产库主机从 10.20.3.7 换成 10.20.3.9 了，今天已经切完。' },
      { role: 'assistant', text: '好，生产库现在是 10.20.3.9。' },
      { role: 'user', text: '旧的 10.20.3.7 只读保留一周，别往上写。' },
      { role: 'assistant', text: '旧地址只读保留。' },
      { role: 'user', text: '配置文件里的连接串记得同步改，.7 那条别再当默认值。' },
      { role: 'assistant', text: '默认值改成 .9。' },
    ],
    question: '这个项目生产库当前的主机地址是什么？旧地址现在是什么角色？',
    required: ['当前生产库是 10.20.3.9', '旧的 10.20.3.7 只读保留，不再写入'],
    forbidden: ['当前生产库仍用 10.20.3.7'],
  },
  {
    id: 'changed-artifact-registry',
    category: '更正/变化',
    turns: [
      { role: 'user', text: '石楠工具的镜像仓库不用 GitLab Registry 了，改推 Nexus，地址 nexus.heather.internal:8081。' },
      { role: 'assistant', text: '好，镜像推 nexus.heather.internal:8081。' },
      { role: 'user', text: '仓库路径还是 heather-tools/，命名空间没变。' },
      { role: 'assistant', text: '路径 heather-tools/。' },
      { role: 'user', text: 'GitLab 那边只留只读，历史镜像还得能拉。' },
      { role: 'assistant', text: '旧仓库只读保留。' },
    ],
    question: '这个项目的镜像现在推到哪里？旧的 GitLab Registry 还能用吗？',
    required: ['镜像推 Nexus 的 nexus.heather.internal:8081', 'GitLab Registry 只读保留历史镜像'],
    forbidden: ['镜像继续推 GitLab Registry'],
  },
  {
    id: 'changed-license',
    category: '更正/变化',
    turns: [
      { role: 'user', text: '枫叶组件的许可证从 MIT 改成 Apache-2.0 了，下次发版生效。' },
      { role: 'assistant', text: '好，许可证改成 Apache-2.0。' },
      { role: 'user', text: '之前说保持 MIT 的话不作数了。' },
      { role: 'assistant', text: 'MIT 那条作废。' },
      { role: 'user', text: '但原来的版权声明文件要保留，别删。' },
      { role: 'assistant', text: '版权声明保留。' },
    ],
    question: '这个组件现在的许可证是什么？之前说的 MIT 还作数吗？',
    required: ['现在是 Apache-2.0', '之前说保持 MIT 已作废'],
    forbidden: ['许可证仍是 MIT'],
  },

  // 计划/未完成
  {
    id: 'plan-rolling-restart',
    category: '计划/未完成',
    turns: [
      { role: 'user', text: '我周五要把测试环境的 web-1 到 web-6 六台机器按顺序滚动重启，一次只动一台。' },
      { role: 'assistant', text: '好，周五滚动重启六台。' },
      { role: 'user', text: '明天先把 README 补一版，那个跟重启没关系。' },
      { role: 'assistant', text: '明天补 README。' },
      { role: 'user', text: '重启前先确认这六台都不在发布窗口里。' },
      { role: 'assistant', text: '重启前确认发布窗口。' },
    ],
    question: '我周五要做什么？重启时有什么限制？',
    required: ['周五按顺序滚动重启 web-1 到 web-6', '一次只重启一台'],
    forbidden: ['一次性重启六台'],
  },
  {
    id: 'plan-api-docs',
    category: '计划/未完成',
    turns: [
      { role: 'user', text: '周六我把 /api/v3/search 的 OpenAPI 文档补齐，现在还缺 14 个字段的描述。' },
      { role: 'assistant', text: '好，周六补 14 个字段。' },
      { role: 'user', text: '这周六只写文档，不改接口实现。' },
      { role: 'assistant', text: '只补文档，不动实现。' },
      { role: 'user', text: '文档先合进去，下周一再发版。' },
      { role: 'assistant', text: '文档先合，下周一发版。' },
    ],
    question: '我周六要做什么？这周六会改接口实现吗？',
    required: ['周六补齐 /api/v3/search 的 14 个字段文档', '这周六不改接口实现'],
    forbidden: ['周六改接口实现'],
  },
  {
    id: 'plan-expand-bench',
    category: '计划/未完成',
    turns: [
      { role: 'user', text: '下周一我把冷启动基准从 20 次扩到 50 次，跑在 bench-runner-03 上。' },
      { role: 'assistant', text: '好，下周一扩到 50 次，机器是 bench-runner-03。' },
      { role: 'user', text: '这次只测冷启动，热启动的等下一轮。' },
      { role: 'assistant', text: '只测冷启动。' },
      { role: 'user', text: '结果我整理成表格发你。' },
      { role: 'assistant', text: '等你表格。' },
    ],
    question: '下周一我要做什么？这次只测哪一项？',
    required: ['下周一把冷启动基准从 20 次扩到 50 次', '只测冷启动'],
    forbidden: ['这次也测热启动'],
  },

  // 时间/快照
  {
    id: 'snapshot-coverage',
    category: '时间/快照',
    turns: [
      { role: 'user', text: '截至 2026-10-21，鹿角计算的单元测试覆盖率是 73.4%，那是那天 CI 跑出来的读数。' },
      { role: 'assistant', text: '好，10 月 21 日覆盖率 73.4%。' },
      { role: 'user', text: '覆盖率统计不含 e2e 用例。' },
      { role: 'assistant', text: '只算单测，不含 e2e。' },
      { role: 'user', text: '后来加的测试还没合进去，别当成最新数。' },
      { role: 'assistant', text: '记成 10-21 的快照。' },
    ],
    question: '截至 2026-10-21，这个项目的单测覆盖率是多少？这个数字该怎么引用？',
    required: ['单测覆盖率 73.4%', '是 2026-10-21 的快照，引用时要带日期'],
    forbidden: ['这是当前最新覆盖率'],
  },
  {
    id: 'snapshot-latency',
    category: '时间/快照',
    turns: [
      { role: 'user', text: '2026-09-30 那天压测，翠鸟网关的 p99 延迟是 142ms，压测配置是 800 并发。' },
      { role: 'assistant', text: '好，9 月 30 日 p99 142ms，800 并发。' },
      { role: 'user', text: '那天的 p50 是 31ms，别只报 p99。' },
      { role: 'assistant', text: 'p50 31ms，p99 142ms。' },
      { role: 'user', text: '后来改过限流，这两天的数字不能跟新配置比。' },
      { role: 'assistant', text: '这是 9-30 旧配置下的读数。' },
    ],
    question: '2026-09-30 压测时这个网关的 p99 和 p50 分别是多少？',
    required: ['p99 是 142ms', 'p50 是 31ms'],
    forbidden: ['这些数字是改限流后的配置测出来的'],
  },
  {
    id: 'snapshot-bundle',
    category: '时间/快照',
    turns: [
      { role: 'user', text: '截至 2026-08-14，苍鹭前端的首屏主包 gzip 后是 1284KB，那天打包用的 Node 18。' },
      { role: 'assistant', text: '好，8 月 14 日主包 1284KB。' },
      { role: 'user', text: '拆包方案还在评审，还没落地，所以拆包后的数我这边没有。' },
      { role: 'assistant', text: '1284KB 是拆包前的读数。' },
      { role: 'user', text: '对，这个数先当拆包前的基准用。' },
      { role: 'assistant', text: '那就只引用 8-14 这个数。' },
    ],
    question: '截至 2026-08-14，首屏主包 gzip 后多大？拆包后的数字有吗？',
    required: ['主包 gzip 后 1284KB', '拆包后的数字还没有'],
    forbidden: ['这是拆包后的体积'],
  },

  // 第三方/文档
  {
    id: 'docs-refund-endpoint',
    category: '第三方/文档',
    turns: [
      { role: 'user', text: '山葵支付的对接文档写退款接口是 /v2/refund，但实际代码调的是 /v2/refunds/create，以代码为准。' },
      { role: 'assistant', text: '好，退款走 /v2/refunds/create。' },
      { role: 'user', text: '文档那页半年没更新了，别照抄。' },
      { role: 'assistant', text: '以代码里的路径为准。' },
      { role: 'user', text: '查询接口的文档是对的，那个可以按文档写。' },
      { role: 'assistant', text: '查询接口按文档走。' },
    ],
    question: '退款接口该用哪个路径？依据是什么？',
    required: ['退款用 /v2/refunds/create', '文档过时，以代码为准'],
    forbidden: ['退款接口按文档用 /v2/refund'],
  },
  {
    id: 'docs-env-var-name',
    category: '第三方/文档',
    turns: [
      { role: 'user', text: '火烈鸟地图的接入文档写环境变量叫 MAPS_TOKEN，实际 SDK 读的是 MAPS_API_TOKEN，按代码。' },
      { role: 'assistant', text: '好，写 MAPS_API_TOKEN。' },
      { role: 'user', text: '两个名字很像，别配错，配错不报错只是不生效。' },
      { role: 'assistant', text: '配错会静默失效。' },
      { role: 'user', text: '还有一个 MAPS_REGION，那个文档写对了。' },
      { role: 'assistant', text: 'MAPS_REGION 按文档写。' },
    ],
    question: '这个地图 SDK 的密钥环境变量该写哪个名字？为什么容易配错？',
    required: ['密钥变量用 MAPS_API_TOKEN', '文档写的 MAPS_TOKEN 是错的，配错会静默不生效'],
    forbidden: ['把密钥环境变量配成 MAPS_TOKEN'],
  },
  {
    id: 'docs-sdk-method',
    category: '第三方/文档',
    turns: [
      { role: 'user', text: '墨鱼监控这个 SDK 的 README 还在教用 trace()，新版本已经改成 startSpan() 了，用新的。' },
      { role: 'assistant', text: '好，用 startSpan()。' },
      { role: 'user', text: 'trace() 调了不报错，但没有 span 数据。' },
      { role: 'assistant', text: '老方法静默无效。' },
      { role: 'user', text: '版本要锁 2.3.0 以上，低版本没有 startSpan。' },
      { role: 'assistant', text: '版本锁 2.3.0 以上。' },
    ],
    question: '这个监控 SDK 该用哪个方法打点？版本有什么要求？',
    required: ['用 startSpan()', '版本要 2.3.0 以上'],
    forbidden: ['继续用 trace() 打点'],
  },

  // 相似事件
  {
    id: 'similar-two-outages',
    category: '相似事件',
    turns: [
      { role: 'user', text: '云豹搜索这月出了两次故障。10 月 8 日那次是 /data 盘写满，日志写不进去。' },
      { role: 'assistant', text: '10 月 8 日是磁盘写满。' },
      { role: 'user', text: '10 月 22 日那次不一样，是重建索引时 OOM，进程被杀了。' },
      { role: 'assistant', text: '10 月 22 日是重建索引 OOM。' },
      { role: 'user', text: '两次都不是代码发布引起的，别归到新版本上。' },
      { role: 'assistant', text: '两次都与发布无关。' },
    ],
    question: '10 月 22 日那次故障的根因是什么？它和 10 月 8 日那次有什么不同？',
    required: ['10 月 22 日是重建索引时 OOM', '10 月 8 日是 /data 磁盘写满'],
    forbidden: ['10 月 22 日是磁盘写满'],
  },
  {
    id: 'similar-two-clients',
    category: '相似事件',
    turns: [
      { role: 'user', text: '燕尾咨询的两家客户都要导出 CSV 报表。甲客户要 GBK 编码，他们的老系统只认 GBK。' },
      { role: 'assistant', text: '好，甲客户导出 GBK。' },
      { role: 'user', text: '乙客户要 UTF-8，还得带 BOM，否则 Excel 打开乱码。' },
      { role: 'assistant', text: '乙客户 UTF-8 带 BOM。' },
      { role: 'user', text: '两个导出走同一个接口，编码按客户配置走。' },
      { role: 'assistant', text: '同一接口，按客户配置换编码。' },
    ],
    question: '甲客户和乙客户导出 CSV 的编码分别是什么？',
    required: ['甲客户用 GBK', '乙客户用 UTF-8 且带 BOM'],
    forbidden: ['两个客户都用 UTF-8'],
  },
  {
    id: 'similar-alert-routes',
    category: '相似事件',
    turns: [
      { role: 'user', text: '紫藤后台的告警分两路：普通告警发到钉钉群，P0 告警直接打电话给我。' },
      { role: 'assistant', text: '好，普通走钉钉，P0 打电话。' },
      { role: 'user', text: 'P0 的定义是核心下单接口连续 3 分钟错误率超过 5%。' },
      { role: 'assistant', text: 'P0 判据记下了。' },
      { role: 'user', text: '别把 P0 也发个钉钉就完事，那不算通知到。' },
      { role: 'assistant', text: 'P0 必须打电话。' },
      { role: 'user', text: '这个后台是上个月从别的团队接过来的，交接文档几乎没有。' },
      { role: 'assistant', text: '明白，缺的文档我们后面补。' },
    ],
    question: '这个后台 P0 告警怎么通知？什么条件算 P0？普通告警走哪？',
    required: ['P0 直接打电话给我', 'P0 判据是下单接口连续 3 分钟错误率超过 5%'],
    forbidden: ['P0 只发钉钉群'],
  },
]

/** 扩展题库的条数。 */
export const SCENARIOS_EXTRA_COUNT = SCENARIOS_EXTRA.length
