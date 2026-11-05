/**
 * Frozen scenarios for the end-to-end memory benchmark.
 *
 * Each scenario is a short coding-assistant conversation in which one durable
 * fact is stated, plus a question a future session asks about it. The fact is
 * what the `memory` arm must have extracted and recalled; the `rag` arm gets the
 * whole transcript; the `closed` arm gets nothing. `required` and `forbidden`
 * are points for the judge, not substrings: the answer has to mean them, not
 * repeat them.
 *
 * Rules for writing one (learned from companion-memory's authoring rules):
 *  - one scenario, one fact group; never reuse a project or product name in
 *    another scenario, or a later scenario silently changes an earlier answer;
 *  - every fact must be stated in the transcript, never inferred from outside;
 *  - a question must not describe anything that happens after its turn;
 *  - time-relative answers say which date they mean.
 *
 * The bank is frozen by hash when `run.mts` starts; editing a scenario after a
 * run invalidates that run's numbers, which is the point.
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
export const SCENARIOS = [
  {
    id: 'pnpm-workspace',
    category: '命令/约定',
    turns: [
      { role: 'user', text: '这个仓库以后统一用 pnpm，别再跑 npm install 了，不然两个锁文件会打架。' },
      { role: 'assistant', text: '明白，我把文档和 CI 里的安装步骤都改成 pnpm。' },
      { role: 'user', text: '顺手把测试脚本也改一下，跑测试用 pnpm test 就够了。' },
      { role: 'assistant', text: '测试脚本已经改成 pnpm test。' },
    ],
    question: '这个仓库安装依赖和跑测试分别该用什么命令？',
    required: ['装依赖用 pnpm', '测试用 pnpm test'],
    forbidden: ['npm install'],
  },
  {
    id: 'hot-reload-restart',
    category: '踩坑/失败',
    turns: [
      { role: 'user', text: '插件改完界面那半边不生效，是不是又得重启客户端？' },
      { role: 'assistant', text: '浏览器半边刷新页面就行；profile 里是硬链接写穿，宿主那半边必须重启才生效。' },
      { role: 'user', text: '那以后我只改 client 的部分就不用重启了，对吧。' },
      { role: 'assistant', text: '对，只改 client 侧刷新即可，改到宿主侧才需要重启 DSH。' },
    ],
    question: '改插件的客户端部分后需要重启 DSH 宿主吗？',
    required: ['只改客户端不用重启', '刷新页面即可'],
    forbidden: ['必须重启宿主'],
  },
  {
    id: 'log-archive-xz',
    category: '命令/约定',
    turns: [
      { role: 'user', text: '日志轮转超过 30 份的备份要压成 xz 归档，别直接删。' },
      { role: 'assistant', text: '好的，归档到 log/archive/，先写临时文件再原子替换。' },
      { role: 'user', text: '还有，读归档日志别自己 open xz，走 read_archived_log()。' },
      { role: 'assistant', text: '记住了，读归档统一走 read_archived_log()。' },
    ],
    question: '日志备份超过 30 份时该怎么处理，读归档日志要用什么函数？',
    required: ['压成 xz 归档而不是删除', '读归档走 read_archived_log'],
    forbidden: ['直接删除旧日志'],
  },
  {
    id: 'never-force-push',
    category: '偏好/边界',
    turns: [
      { role: 'user', text: '以后任何情况下都别直接 force-push，要推先告诉我一声。' },
      { role: 'assistant', text: '收到，force-push 前一定先问你。' },
      { role: 'user', text: '普通提交不用问，直接推 origin 就行。' },
      { role: 'assistant', text: '普通提交默认推 origin，force-push 单独确认。' },
    ],
    question: '什么 git 操作必须先征得我同意？普通提交要不要问？',
    required: ['force-push 要先问', '普通提交直接推不用问'],
    forbidden: ['普通提交也要先问'],
  },
  {
    id: 'deploy-command',
    category: '命令/约定',
    turns: [
      { role: 'user', text: '发布走 npm run release，它会自动打 tag 并触发 CI。' },
      { role: 'assistant', text: '好的，发布只跑 npm run release，不手动打 tag。' },
      { role: 'user', text: '对，别直接 git tag，会跳过 CI 的构建检查。' },
      { role: 'assistant', text: '明白，不手动打 tag。' },
    ],
    question: '这个项目发布该跑什么命令，能不能手动打 tag？',
    required: ['发布跑 npm run release', '不要手动打 tag'],
    forbidden: ['手动 git tag 发布'],
  },
  {
    id: 'api-base-url',
    category: '配置/事实',
    turns: [
      { role: 'user', text: '内网 API 的测试地址是 http://10.8.0.12:8080，别用外网那个域名。' },
      { role: 'assistant', text: '好的，测试连 10.8.0.12:8080。' },
      { role: 'user', text: '生产是 https://api.internal.example，两个别搞混。' },
      { role: 'assistant', text: '测试 10.8.0.12:8080，生产 api.internal.example。' },
    ],
    question: '测试环境的 API 地址是什么？',
    required: ['10.8.0.12:8080'],
    forbidden: ['api.internal.example 是测试地址'],
  },
  {
    id: 'sinatra-port',
    category: '配置/事实',
    turns: [
      { role: 'user', text: '本地起服务固定用 4567 端口，别用默认的 3000，会跟别的项目撞。' },
      { role: 'assistant', text: '好，本地固定 4567。' },
      { role: 'user', text: 'CI 里用 3000 没事，只要本地别撞就行。' },
      { role: 'assistant', text: '本地 4567，CI 可以 3000。' },
    ],
    question: '本地开发服务器该用哪个端口，为什么？',
    required: ['本地用 4567', '避免和别的项目冲突'],
    forbidden: ['本地用 3000'],
  },
  {
    id: 'monorepo-layout',
    category: '架构决策',
    turns: [
      { role: 'user', text: '这个仓改成 monorepo 了，业务包统一放 packages/ 下面。' },
      { role: 'assistant', text: '好，新包都建在 packages/<name>。' },
      { role: 'user', text: '共享库放 packages/shared，别再往根目录塞代码了。' },
      { role: 'assistant', text: '明白，共享库在 packages/shared。' },
    ],
    question: '新的业务包和共享库分别应该放哪里？',
    required: ['业务包放 packages/', '共享库放 packages/shared'],
    forbidden: ['代码放仓库根目录'],
  },
  {
    id: 'windows-path-quirk',
    category: '踩坑/失败',
    turns: [
      { role: 'user', text: 'Windows 上那个脚本双击跑的时候，PATH 里拿到的是旧版本 node，别以为代码没更新。' },
      { role: 'assistant', text: '明白，双击运行的 PATH 和终端不一样。' },
      { role: 'user', text: '对，要验证就去终端里跑，别信双击的结果。' },
      { role: 'assistant', text: '验证一律在终端里跑。' },
    ],
    question: 'Windows 上双击脚本和终端运行有什么区别？验证时该用哪个？',
    required: ['双击时 PATH 里可能是旧版本', '验证要在终端里跑'],
    forbidden: ['双击结果可以当准'],
  },
  {
    id: 'root-cause-flake',
    category: '踩坑/失败',
    turns: [
      { role: 'user', text: '上次测试偶发失败，根因是定时器等待余量不够，不是功能回归。' },
      { role: 'assistant', text: '所以是 flake，不是代码坏了。' },
      { role: 'user', text: '对，后来把等待从 400ms 拉到 1.8s 就稳定了。' },
      { role: 'assistant', text: '记住了，那类偶发失败先查余量。' },
    ],
    question: '之前那个偶发失败的测试，根因是什么，怎么修的？',
    required: ['根因是等待余量不够', '把等待余量拉大后稳定'],
    forbidden: ['根因是功能回归'],
  },
  {
    id: 'docs-third-party',
    category: '第三方/文档',
    turns: [
      { role: 'user', text: '官方文档说配置项叫 timeout_ms，但实际代码读的是 timeoutMilliseconds，以代码为准。' },
      { role: 'assistant', text: '好，写配置用 timeoutMilliseconds。' },
      { role: 'user', text: '对，文档是旧的，别照抄。' },
      { role: 'assistant', text: '以代码里的 timeoutMilliseconds 为准。' },
    ],
    question: '配置超时时间到底该写哪个字段名？依据是什么？',
    required: ['用 timeoutMilliseconds', '文档过时，以代码为准'],
    forbidden: ['timeout_ms 是对的'],
  },
  {
    id: 'changed-mind-retry',
    category: '更正/变化',
    turns: [
      { role: 'user', text: '重试策略我改主意了：原来重试三次太多，现在统一只重试一次。' },
      { role: 'assistant', text: '好的，重试次数从三次改成一次。' },
      { role: 'user', text: '对，之前说三次的那条作废。' },
      { role: 'assistant', text: '已按重试一次更新。' },
    ],
    question: '重试策略现在是什么？之前说的还作数吗？',
    required: ['现在只重试一次', '之前的三次已作废'],
    forbidden: ['重试三次'],
  },
  {
    id: 'open-plan-tomorrow',
    category: '计划/未完成',
    turns: [
      { role: 'user', text: '明天我把登录页的截图补齐，然后发给你。' },
      { role: 'assistant', text: '好，我等你截图。' },
      { role: 'user', text: '发之前我先自己过一遍文案。' },
      { role: 'assistant', text: '明白，文案你先过。' },
    ],
    question: '我说明天要做什么？',
    required: ['补登录页截图', '发给我之前先自己过文案'],
    forbidden: ['已经发过截图'],
  },
  {
    id: 'bench-snapshot',
    category: '时间/快照',
    turns: [
      { role: 'user', text: '截至 2026-11-02，检索基准的 R@1 是 60.0，这是干净样本 b 批的数字。' },
      { role: 'assistant', text: '好，记下是 11 月 2 日的 b 批读数。' },
      { role: 'user', text: '别把它当成随时会变的当前值，报的时候带上日期。' },
      { role: 'assistant', text: '会带日期，标明是快照。' },
    ],
    question: '截至 2026-11-02，干净样本的 R@1 是多少？这个数字该怎么引用？',
    required: ['R@1 是 60.0', '是 2026-11-02 的快照，要带日期'],
    forbidden: ['这是当前实时值'],
  },
  {
    id: 'reply-style',
    category: '偏好/风格',
    turns: [
      { role: 'user', text: '给我回话先给结论再给依据，别写三段铺垫。' },
      { role: 'assistant', text: '好，结论先行。' },
      { role: 'user', text: '还有，别用形容词凑数，数字和路径就够了。' },
      { role: 'assistant', text: '明白，用具体数字和路径说话。' },
    ],
    question: '你回复我时应该遵守什么风格？',
    required: ['结论先给再给依据', '多用具体数字和路径，少形容词'],
    forbidden: ['先铺垫背景'],
  },
  {
    id: 'review-before-push',
    category: '偏好/边界',
    turns: [
      { role: 'user', text: '给上游作者回话之前，先把草稿给我看一眼，别直接发出去。' },
      { role: 'assistant', text: '好，发之前先给你看草稿。' },
      { role: 'user', text: '尤其是那种要提 issue 的长文。' },
      { role: 'assistant', text: '长文草稿一定先给你过。' },
    ],
    question: '在对外发言前我应该先做什么？',
    required: ['先把草稿给我看', '不要直接发出去'],
    forbidden: ['直接发出'],
  },
  {
    id: 'secret-handling',
    category: '偏好/边界',
    turns: [
      { role: 'user', text: '配置文件里的 api_key 不要写进记忆，也不要在回复里贴出来。' },
      { role: 'assistant', text: '明白，密钥不进记忆、不贴出来。' },
      { role: 'user', text: '要引用就写 [redacted]。' },
      { role: 'assistant', text: '统一写 [redacted]。' },
    ],
    question: '记忆和回复里该怎么处理密钥？',
    required: ['密钥不进记忆不贴出', '写成 redacted'],
    forbidden: ['把密钥原文记下来'],
  },
  {
    id: 'editor-choice',
    category: '偏好/风格',
    turns: [
      { role: 'user', text: '写文档用 Obsidian，别给我生成 Word 文件。' },
      { role: 'assistant', text: '好，文档用 Obsidian 的 Markdown。' },
      { role: 'user', text: '只有发给客户的时候才需要 docx。' },
      { role: 'assistant', text: '对客户交付才用 docx。' },
    ],
    question: '写文档默认用什么格式，什么时候才需要 Word？',
    required: ['默认 Obsidian Markdown', '只有客户交付才用 docx'],
    forbidden: ['默认生成 Word'],
  },
  {
    id: 'timezone-tz',
    category: '配置/事实',
    turns: [
      { role: 'user', text: '所有定时任务按 Asia/Shanghai 算时间，别用机器本地时区。' },
      { role: 'assistant', text: '好，定时任务统一 Asia/Shanghai。' },
      { role: 'user', text: '日志里的时间戳也按这个时区解读。' },
      { role: 'assistant', text: '日志时间也按上海时区读。' },
    ],
    question: '定时任务和日志的时间按哪个时区算？',
    required: ['Asia/Shanghai'],
    forbidden: ['用机器本地时区'],
  },
  {
    id: 'branch-strategy',
    category: '架构决策',
    turns: [
      { role: 'user', text: '这个仓以后都从 main 切 feature 分支，别直接在 main 上改。' },
      { role: 'assistant', text: '好，从 main 切 feature 分支。' },
      { role: 'user', text: '合回去之前先 rebase 一遍。' },
      { role: 'assistant', text: '合并前先 rebase。' },
    ],
    question: '改代码应该在哪个分支上做，合并前要做什么？',
    required: ['从 main 切 feature 分支', '合并前先 rebase'],
    forbidden: ['直接在 main 上改'],
  },
  {
    id: 'test-data-exclusion',
    category: '偏好/边界',
    turns: [
      { role: 'user', text: '这个项目的测试数据是真实业务数据，提交前必须排除，别进 git。' },
      { role: 'assistant', text: '好，测试数据不入库。' },
      { role: 'user', text: '凭据和业务数据都算。' },
      { role: 'assistant', text: '凭据和业务数据都排除。' },
    ],
    question: '提交这个项目时要排除哪些东西？',
    required: ['真实业务数据和凭据都要排除', '不要提交进 git'],
    forbidden: ['业务数据可以提交'],
  },
  {
    id: 'local-first-rag',
    category: '架构决策',
    turns: [
      { role: 'user', text: '检索先只用词法，别一上来就上向量库，我们还没验证收益。' },
      { role: 'assistant', text: '好，先词法，向量等验证过再说。' },
      { role: 'user', text: '上向量之前先跑对照实验，有数据再决定。' },
      { role: 'assistant', text: '先对照实验，有结论再上向量。' },
    ],
    question: '检索这块现在的决定是什么？上向量库的前提是什么？',
    required: ['先用词法', '上向量前先跑对照实验'],
    forbidden: ['直接上向量库'],
  },
  {
    id: 'release-tag-format',
    category: '命令/约定',
    turns: [
      { role: 'user', text: '发版 tag 统一 v 开头，比如 v1.4.2，别省 v。' },
      { role: 'assistant', text: '好，tag 都用 v 前缀。' },
      { role: 'user', text: 'CHANGELOG 里也要保留 compare 链接。' },
      { role: 'assistant', text: 'CHANGELOG 保留 compare 链接。' },
    ],
    question: '发版 tag 的格式是什么？CHANGELOG 要注意什么？',
    required: ['tag 用 v 开头如 v1.4.2', 'CHANGELOG 保留 compare 链接'],
    forbidden: ['tag 不带 v'],
  },
]

/** Highest number of scenarios the harness will accept. */
export const SCENARIO_COUNT = SCENARIOS.length
