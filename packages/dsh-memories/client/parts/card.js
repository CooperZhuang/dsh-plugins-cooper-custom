/**
 * The tunables card, embedded at the foot of the Memories settings page.
 *
 * Field descriptors, in render order. `kind` picks the control; `min`/`step`
 * bound the numeric inputs. Every label and hint is bilingual (Chinese first,
 * English fallback) and resolves from the active locale, so the surface reads
 * naturally in the language the shell is already speaking. Keep this list in
 * sync with `MemoriesSettingsSchema` — the host is the authority on what it
 * accepts, and a field the schema does not declare fails the save instead of
 * being silently dropped.
 */

/** The profile entry whose form this card edits; must match the host's entry id. */
const NS = 'memories'

/** Per-locale chrome strings for the card frame. */
const CARD_COPY = {
  zh: {
    reset: '恢复默认',
    saved: '已保存。',
    unavailable: '这个部署没有把 memories 条目暴露成可编辑的表单。',
    note: '改动写进 profile 配置并立即生效，无需重启。存储位置是部署层配置。',
  },
  en: {
    reset: 'Reset',
    saved: 'Saved.',
    unavailable: 'This deployment does not expose the memories entry as an editable form.',
    note: 'Changes are written to the profile config and apply immediately; no restart is needed. The store location is a deployment setting.',
  },
}

/** One row per tunable; `label`/`hint` are the `{ zh, en }` pair. */
const FIELDS = [
  {
    field: 'maxSummaryBytes', kind: 'number', min: 0, step: 256,
    label: { zh: '摘要字节上限', en: 'Summary byte budget' },
    hint: { zh: '一次会话注入的记忆摘要最大字节数，0 表示关闭注入。', en: 'Bytes of memory summary injected once per conversation. 0 disables injection.' },
  },
  {
    field: 'maxSummaryEntries', kind: 'number', min: 1, step: 1,
    label: { zh: '每作用域摘要条数', en: 'Summary entries per scope' },
    hint: { zh: '摘要里每个作用域列出多少条记忆。', en: 'How many memories each scope lists in the summary.' },
  },
  {
    field: 'globalSummaryEntries', kind: 'number', min: 0, step: 1,
    label: { zh: '全局段摘要条数', en: 'Global entries' },
    hint: { zh: '全局段最多列几条。两个作用域共用一份字节预算、全局段先渲染，不设上限时全局会吃掉项目段用不完的部分（实测某 2 条记忆的项目会话里全局占了 87%）。设为 0 则不注入全局段。', en: 'How many the GLOBAL section may list. Both scopes share one byte budget and global renders first, so without a cap it absorbs whatever the project half leaves (measured: 87% of a small project\'s summary). 0 removes the global section.' },
  },
  {
    field: 'globalSummaryBytes', kind: 'number', min: 0, step: 100,
    label: { zh: '全局段字节预算', en: 'Global bytes' },
    hint: { zh: '全局段单独占多少字节（在总预算之内）。只限条数不够：中文一条约 600 字节，4 条就吃掉 4KB 的 60%，实测全局段仍占 45–81%；按字节预留才真正给项目段留出位置。设为 0 则不注入全局段。', en: 'Byte budget for the GLOBAL section, inside the total. A count cap is not enough — four Chinese entries cost ~2.6 KB of a 4 KB block, and the global half still took 45–81% until bytes were reserved. 0 removes the global section.' },
  },
  {
    field: 'summaryFreshSlots', kind: 'number', min: 0, step: 1,
    label: { zh: '新记忆保底条数', en: 'Fresh-memory slots' },
    hint: { zh: '每个作用域预留几条给从未被注入过的记忆，且优先人手或模型显式写入的。作用域存满后纯按排序等于永远只展示同一批老记忆，新写的（包括用来纠正旧结论的那条）永远排不进来；设为 0 即恢复纯排序。', en: 'How many of each scope\'s entries are reserved for memories never listed before, preferring ones written deliberately over extracted ones. On a full scope pure ranking shows the same old set forever, so a correction never makes it in; 0 restores pure ranking.' },
  },
  {
    field: 'recallMode', kind: 'select',
    options: [
      { value: 'once', label: { zh: '仅一次', en: 'Once' } },
      { value: 'on-demand', label: { zh: '按需补充', en: 'On demand' } },
      { value: 'off', label: { zh: '关闭注入', en: 'Off' } },
    ],
    label: { zh: '记忆注入方式', en: 'Memory injection' },
    hint: { zh: 'once 只在会话开始时注入一次摘要；on-demand 额外在当前话题明显命中记忆时补一小块；off 完全关闭注入，只留记忆工具。', en: 'once injects the summary at the start of the conversation; on-demand also adds a small block when the current turn clearly matches a memory; off disables injection and leaves only the memory tool.' },
  },
  {
    field: 'recallMinScore', kind: 'number', min: 0, step: 1,
    label: { zh: '按需注入的相关度下限', en: 'Recall relevance floor' },
    hint: { zh: '补注需要达到的相关度分数，是一个"更严/更松"的旋钮。真正的精度由下面「补注所需命中词数」把关：中文提问共享两个词大约得 9–12 分，所以默认 9；只共用「日志」这类一个常见词大约 8 分，因此单靠相关度是拦不住的。', en: 'Relevance a memory must reach to be injected on demand. This is a strictness knob; precision comes from the strong-term requirement below. A Chinese paraphrase sharing two bigrams scores about 9-12, and one shared common word about 8, which is why the default sits at 9.' },
  },
  {
    field: 'recallMaxPerConversation', kind: 'number', min: 0, step: 1,
    label: { zh: '每会话补注条数上限', en: 'Recalled memories per conversation' },
    hint: { zh: '一个会话最多补注多少条记忆；0 关闭按需补注，只保留一次摘要。', en: 'Maximum memories injected on demand in one conversation. 0 keeps only the once-per-conversation summary.' },
  },
  {
    field: 'recallMaxBytes', kind: 'number', min: 0, step: 100,
    label: { zh: '补注字节上限', en: 'Recall block byte budget' },
    hint: { zh: '单次按需补注块的字节上限，0 表示关闭按需补注。', en: 'Byte budget for one on-demand recall block. 0 disables recall deltas.' },
  },
  {
    field: 'recallMinQueryChars', kind: 'number', min: 0, step: 1,
    label: { zh: '触发补注的最短发问长度', en: 'Shortest turn worth recalling' },
    hint: { zh: '用户消息短于该字符数时不判定补注（例如「好」「继续」），避免为无意义的回合扫描整个记忆库。', en: 'A user turn shorter than this is skipped instead of scanning the store, so bare acknowledgements cost nothing.' },
  },
  {
    field: 'recallMinTerms', kind: 'number', min: 1, step: 1,
    label: { zh: '补注所需命中词数', en: 'Strong terms required to recall' },
    hint: { zh: '一条记忆要被按需补注，除了达到相关度下限，还必须在标题、别名、标签或「何时有用」里命中这么多个不同的提问词。中文提问尤其需要：只共用「插件」「日志」这类常见词不算证据，共享两个词才算。设为 1 就只按相关度打分判断（会明显更容易误补）。', en: 'Distinct query terms that must land in the title, keys, tags, or appliesTo before a memory may be recalled. This is what stops a Chinese turn from recalling everything that shares a common word; set it to 1 to gate on relevance alone.' },
  },
  {
    field: 'reflectionEnabled', kind: 'boolean',
    label: { zh: '每周反思', en: 'Weekly reflection' },
    hint: { zh: '每周从记忆里综合出几条「没有哪一条记忆单独说过」的观察，比如跨项目的习惯、反复踩的坑。每条必须引用依据的记忆，否则丢弃。写成按日期归档的 markdown，不注入对话。', en: 'Once a week, synthesize observations no single memory states — cross-project habits, recurring pitfalls. Every observation must cite its evidence or it is dropped. Dated markdown files, never injected.' },
  },
  {
    field: 'noticeGate', kind: 'boolean',
    label: { zh: '没规矩的提醒先问 AI', en: 'Gate judgement notices' },
    hint: { zh: '有硬规则的提醒（日报、积压、到期承诺）不过闸门。只有「没有截止日期、躺了好几天」这类需要判断的，才先问一次模型值不值得打扰——答不上来就不打扰。', en: 'Rule-based notices (digest, backlog, a passed deadline) bypass the gate. Only judgement calls — an undated promise sitting for days — go to a model first, and a failure means silence.' },
  },
  {
    field: 'noticesEnabled', kind: 'boolean',
    label: { zh: '允许它主动开口', en: 'Let it speak first' },
    hint: { zh: '每天一条整理简报、待裁决积压超时提醒。先走桌宠气泡，桌宠不在时退回系统通知。关掉则只在你问的时候回答。', en: 'A daily digest of maintenance and a warning when decisions have waited too long. Desktop pet bubble first, system notification as fallback. Off means it only answers.' },
  },
  {
    field: 'petId', kind: 'text',
    label: { zh: '桌宠 id', en: 'Desktop pet id' },
    hint: { zh: '留空则从 dsh-pet 的配置里读第一个宠物的 id（本机是 main / 蓝毛小女仆）。', en: 'Empty reads the first pet from the pet plugin\'s own config (main on this machine).' },
  },
  {
    field: 'petRouteId', kind: 'text',
    label: { zh: '桌宠路由 id', en: 'Pet route id' },
    hint: { zh: '桌宠注册的 HTTP 前缀里的那一段（/dsh-pet-<id>）。只有换桌宠版本时才需要改。', en: 'Route segment in the pet HTTP prefix (/dsh-pet-<id>). Only change it if the pet changes it.' },
  },
  {
    field: 'petBubbleMs', kind: 'number', min: 1000, step: 1000,
    label: { zh: '气泡停留时长', en: 'Bubble duration' },
    hint: { zh: '一条通知在桌宠上停留多久（毫秒）。', en: 'How long one notice stays on screen, in milliseconds.' },
  },
  {
    field: 'noticeQuietHours', kind: 'text',
    label: { zh: '安静时段', en: 'Quiet hours' },
    hint: { zh: '本地时间的免打扰窗口，例如 "22:00-08:00"；留空表示不限制。落在窗口内的通知会顺延到窗口结束，不会丢。', en: 'Local windows when nothing is delivered, e.g. "22:00-08:00". Held notices fire when the window ends; they are not dropped.' },
  },
  {
    field: 'personaMaxBytes', kind: 'number', min: 0, step: 100,
    label: { zh: '画像块字节预算', en: 'Persona block budget' },
    hint: { zh: '每会话开头注入的「关于你」块的上限。它由合并子代理从 voice=user 的记忆里维护，是整轮对话的上下文，不占记忆摘要的预算；设为 0 关闭。', en: 'Upper bound for the profile block injected once per conversation. It is maintained by the consolidation pass from voice=user memories and is turn-level context, so it does not compete with the memory summary budget. 0 disables it.' },
  },
  {
    field: 'autoDecide', kind: 'boolean',
    label: { zh: '合并争议交给 AI 裁决', en: 'Let an AI adjudicate merge disputes' },
    hint: { zh: '合并里那些「只是判断、不是承诺」的变更（例如这条被读过 2 次就想退役、改写后正文变短）改由一次受限子代理裁决：它只回答"有没有丢信息"，答 accept 或 reject 并给置信度。永久保留、人手写、跨作用域搬移三类仍然等你。关掉则全部进「待裁决」。', en: 'Changes blocked only because they are a judgement rather than a promise are adjudicated by one tool-free child that answers accept or reject with a confidence. Permanent, user-written and scope-moving items still wait for you. Off sends everything to the panel.' },
  },
  {
    field: 'autoDecideMinConfidence', kind: 'number', min: 0, max: 1, step: 0.05,
    label: { zh: 'AI 裁决的最低置信度', en: 'AI verdict confidence floor' },
    hint: { zh: '低于该置信度视为「没有答案」，条目留在待裁决。', en: 'Below this the verdict counts as no answer and the item stays in the panel.' },
  },
  {
    field: 'evidenceMaxDf', kind: 'number', min: 0, max: 1, step: 0.05,
    label: { zh: '算作「常见词」的库占比', en: 'Share of the store that makes a word common' },
    hint: { zh: '一个提问词若出现在该作用域超过这个比例的记忆里，就不算补注所需的「证据词」。默认 0.15 是在真实库上量出来的：只命中一个词（dsh，占 22%），把「dsh 插件 配置」这类泛问的误纳入从 37 条降到 9 条，10 条标注探针一条不变。设为 0 关闭折扣。', en: 'A query term appearing in more than this share of one scope stops counting as recall evidence. 0.15 is measured on a real store: it catches one word (dsh, 22%) and takes a generic turn from 37 admitted memories to 9 while all ten labelled probes keep their verdict. 0 disables it.' },
  },
  {
    field: 'maxEntriesPerScope', kind: 'number', min: 1, step: 1,
    label: { zh: '每作用域保留条数', en: 'Stored memories per scope' },
    hint: { zh: '超过后归档最久未使用的记忆（可用 /memories restore 取回）。', en: 'Past this cap the least recently used memories are archived; /memories restore brings one back.' },
  },
  {
    field: 'maxUnusedDays', kind: 'number', min: 0, step: 10,
    label: { zh: '无用记忆归档天数', en: 'Archive unused after (days)' },
    hint: { zh: '这么久没有被读到、没有被注入摘要、也不是新写的记忆会被归档（可恢复）。0 关闭归档；人手写的记忆永不归档。', en: 'Archive a memory that has not been read, surfaced, or written for this many days. Recoverable with /memories restore. 0 disables archival; memories a person wrote are never archived.' },
  },
  {
    field: 'dedupeSimilarity', kind: 'number', min: 0, step: 0.05,
    label: { zh: '近似重复合并阈值', en: 'Near-duplicate threshold' },
    hint: { zh: '标题与正文词重叠超过该比例时，新记忆视为改写并取代旧记忆（0–1）。0 只保留完全相同才合并的规则。', en: 'Share of title and body words two memories must share before the newer one supersedes the older (0-1). 0 keeps only the exact-match rule.' },
  },
  {
    field: 'sweepIntervalHours', kind: 'number', min: 0, step: 1,
    label: { zh: '定期整理间隔（小时）', en: 'Maintenance sweep interval (hours)' },
    hint: { zh: '每隔多久对所有工作区做一次归档整理；0 关闭定期整理（仍可用 /memories sweep 手动执行）。', en: 'How often to run retention across every workspace. 0 disables the periodic sweep; /memories sweep still runs it on demand.' },
  },
  {
    field: 'autoExtract', kind: 'boolean',
    label: { zh: '后台抽取', en: 'Background extraction' },
    hint: { zh: '会话空闲后从最近对话里抽取值得长期保留的事实。', en: 'Mine finished sessions for durable facts once they have been idle.' },
  },
  {
    field: 'autoExtractIdleMs', kind: 'number', min: 1000, step: 1000,
    label: { zh: '抽取前空闲时长（毫秒）', en: 'Idle before extraction (ms)' },
    hint: { zh: '会话需空闲多久才开始挖掘。', en: 'How long a session must stay idle before it is mined.' },
  },
  {
    field: 'extractWindowMessages', kind: 'number', min: 1, step: 1,
    label: { zh: '抽取窗口（条消息）', en: 'Extraction window (messages)' },
    hint: { zh: '一次抽取最多读最近多少条对话消息。配合「周期性抽取间隔」使用：按一个间隔的增量来定，而不是按整段会话。', en: 'How many recent conversation messages one extraction reads. Size it for one periodic interval, not for a whole conversation.' },
  },
  {
    field: 'extractMaxInputChars', kind: 'number', min: 1, step: 1000,
    label: { zh: '抽取输入预算（字符）', en: 'Extraction input budget (chars)' },
    hint: { zh: '交给抽取器的对话文本字符上限。', en: 'Character budget for the transcript handed to the extractor.' },
  },
  {
    field: 'extractMaxOutputTokens', kind: 'number', min: 1, step: 128,
    label: { zh: '抽取输出 token 上限', en: 'Extraction output tokens' },
    hint: { zh: '一次抽取调用的输出 token 上限。', en: 'Output token cap for one extraction call.' },
  },
  {
    field: 'extractTimeoutMs', kind: 'number', min: 1000, step: 5000,
    label: { zh: '抽取超时（毫秒）', en: 'Extraction timeout (ms)' },
    hint: { zh: '一次抽取调用的超时时间。', en: 'Timeout for one extraction call.' },
  },
  {
    field: 'extractMaxMemories', kind: 'number', min: 1, step: 1,
    label: { zh: '每次抽取条数上限', en: 'Memories per extraction' },
    hint: { zh: '一次抽取最多写入多少条记忆。', en: 'Maximum memories one extraction pass may store.' },
  },
  {
    field: 'extractIntervalMinutes', kind: 'number', min: 0, step: 5,
    label: { zh: '周期性抽取间隔（分钟）', en: 'Periodic extraction interval (minutes)' },
    hint: { zh: '每隔这么久检查一次所有打开的会话，只要有新内容且会话当时空闲就抽一段——长会话因此不会因为「只在停止输入后抽一次」而丢掉中间的内容。没有新内容时不产生模型调用；仍受错峰时段与额度闸门限制。0 关闭周期检查。', en: 'How often to check every open session and mine a slice when there is new material and the session is momentarily idle — so a long working session does not lose its middle to a single end-of-session pass. A session with nothing new costs no model call; peak hours and the quota gate still apply. 0 disables the check.' },
  },
  {
    field: 'minIdleHours', kind: 'number', min: 0, step: 0.5,
    label: { zh: '挖掘前最短空闲（小时）', en: 'Minimum idle before mining (hours)' },
    hint: { zh: '会话至少要空闲这么久才会被挖掘，可填小数（0.5 = 半小时）；实际等待取它与「抽取前空闲时长」的较大者。0 关闭该闸门。', en: 'A session must have been idle at least this long before it is mined. Fractions are allowed (0.5 = half an hour); the effective wait is the larger of this and the idle delay above. 0 disables the gate.' },
  },
  {
    field: 'maxAgeDays', kind: 'number', min: 0, step: 1,
    label: { zh: '超过天数不再挖掘（天）', en: 'Never mine sessions older than (days)' },
    hint: { zh: '最后活动早于该天数的会话永不挖掘，0 关闭该闸门。', en: 'Sessions whose last activity is older than this are never mined. 0 disables the gate.' },
  },
  {
    field: 'maxSessionsPerPass', kind: 'number', min: 1, step: 1,
    label: { zh: '每次挖掘的会话数', en: 'Sessions per pass' },
    hint: { zh: '一次抽取最多挖掘多少个会话，新的优先。', en: 'How many sessions one extraction pass may mine, newest first.' },
  },
  {
    field: 'consolidate', kind: 'boolean',
    label: { zh: '合并重整', en: 'Consolidation pass' },
    hint: { zh: '新记忆落盘后，用一个受限子代理合并、改写并相互协调。', en: 'After new memories land, merge and reconcile them through a restricted sub-agent.' },
  },
  {
    field: 'consolidateCooldownHours', kind: 'number', min: 0, step: 1,
    label: { zh: '合并冷却（小时）', en: 'Consolidation cooldown (hours)' },
    hint: { zh: '两次合并之间的最短小时数，约束后台额度消耗。', en: 'Minimum hours between consolidation passes; bounds background quota use.' },
  },
  {
    field: 'consolidateMaxEntries', kind: 'number', min: 1, step: 8,
    label: { zh: '每次合并条目上限', en: 'Memories per consolidation' },
    hint: { zh: '一次合并最多考虑多少条记忆。', en: 'How many memories one consolidation pass may consider.' },
  },
  {
    field: 'consolidateTimeoutMs', kind: 'number', min: 1000, step: 10000,
    label: { zh: '合并超时（毫秒）', en: 'Consolidation timeout (ms)' },
    hint: { zh: '一次合并子代理运行的超时时间。', en: 'Timeout for one consolidation sub-agent run.' },
  },
  {
    field: 'pauseOnQuotaError', kind: 'boolean',
    label: { zh: '额度紧张时暂停后台', en: 'Pause background work on quota errors' },
    hint: { zh: '提供方因限流或额度耗尽拒绝后，暂停后台抽取与合并，直到冷却结束。', en: 'After a rate-limit or exhausted-quota refusal, stop background extraction and consolidation until the cooldown elapses.' },
  },
  {
    field: 'quotaCooldownMinutes', kind: 'number', min: 0, step: 5,
    label: { zh: '额度冷却（分钟）', en: 'Quota cooldown (minutes)' },
    hint: { zh: '一次拒绝后等待多久；连续拒绝会翻倍。0 表示不暂停。', en: 'Wait after one refusal; doubles per consecutive refusal. 0 disables the pause.' },
  },
  {
    field: 'quotaCooldownMaxMinutes', kind: 'number', min: 0, step: 30,
    label: { zh: '额度冷却上限（分钟）', en: 'Quota cooldown ceiling (minutes)' },
    hint: { zh: '上面那个等待翻倍后的上限。', en: 'Upper bound as the wait doubles.' },
  },
  {
    field: 'snapshotMaxAgeDays', kind: 'number', min: 0, step: 10,
    label: { zh: '快照记忆保留天数', en: 'Snapshot lifetime (days)' },
    hint: { zh: '标记为「快照」的记忆（某个时刻的读数：数量、通过率、当前状态）从测量那天算起多少天后归档，与「多久没被读到」无关——过期数字再被读一次也不会变对。0 关闭快照过期。', en: 'Days a memory marked durability=snapshot survives before it is archived, counted from when it was measured rather than from when it was last read. A stale number does not become right by being read. 0 disables snapshot expiry.' },
  },
  {
    field: 'extractProvider', kind: 'text',
    label: { zh: '抽取提供方', en: 'Extraction provider' },
    hint: { zh: '抽取用的提供方路由；留空则复用该会话已记录的请求路由。', en: "Provider route for extraction. Empty reuses the session's own logged route." },
  },
  {
    field: 'extractModel', kind: 'text',
    label: { zh: '抽取模型', en: 'Extraction model' },
    hint: { zh: '抽取用的模型；留空则复用该会话已记录的请求路由。', en: "Model for extraction. Empty reuses the session's own logged route." },
  },
  {
    field: 'consolidateProvider', kind: 'text',
    label: { zh: '合并提供方', en: 'Consolidation provider' },
    hint: { zh: '合并用的提供方路由；留空则先回退到抽取路由，再回退到会话路由。', en: 'Provider route for consolidation. Empty falls back to the extraction route, then the session route.' },
  },
  {
    field: 'consolidateModel', kind: 'text',
    label: { zh: '合并模型', en: 'Consolidation model' },
    hint: { zh: '合并用的模型；留空则先回退到抽取路由，再回退到会话路由。', en: 'Model for consolidation. Empty falls back to the extraction route, then the session route.' },
  },
  {
    field: 'consolidateProposalMaxAgeHours', kind: 'number', min: 0, step: 6,
    label: { zh: '合并提案保鲜期（小时）', en: 'Proposal lifetime (hours)' },
    hint: { zh: '待确认的合并提案等多久还没被 /memories apply 或 reject，后续的自动整理才可以换一份新的。窗口内后台不重复生成（生成一次是模型调用，覆盖一个没人回答的问题没有意义）；/memories consolidate 无视这个窗口。0 表示一直等你的答复。', en: 'Hours a staged consolidation proposal waits for /memories apply or reject before a background pass may replace it with a fresh one. Inside the window a pass leaves the pending question alone; /memories consolidate always proposes now. 0 keeps it until answered.' },
  },
  {
    field: 'enableTool', kind: 'boolean',
    label: { zh: '记忆工具', en: 'Memory tool' },
    hint: { zh: '是否注册面向模型的 memory 工具。立即生效。', en: 'Register the model-facing memory tool. Takes effect immediately.' },
  },
  {
    field: 'enableCommand', kind: 'boolean',
    label: { zh: '斜杠命令', en: 'Slash command' },
    hint: { zh: '是否注册 /memories 命令。立即生效。', en: 'Register the /memories command. Takes effect immediately.' },
  },
  {
    field: 'logLevel', kind: 'select',
    options: [
      { value: 'off', label: { zh: '不写日志', en: 'Off' } },
      { value: 'error', label: { zh: '仅错误', en: 'Errors' } },
      { value: 'warn', label: { zh: '错误 + 警告', en: 'Errors and warnings' } },
      { value: 'info', label: { zh: '再 + 每轮摘要（默认）', en: 'Plus pass summaries' } },
      { value: 'debug', label: { zh: '全部（含逐条决策）', en: 'Everything' } },
    ],
    label: { zh: '日志等级', en: 'Log level' },
    hint: { zh: '本插件日志文件的详细程度。默认 info：错误、警告，以及每轮抽取/合并摘要。debug 还会记录每条归档、补注、复审决策。文件路径见 /memories stats。', en: 'How much this plugin writes to its own log file. info keeps errors, warnings, and one line per pass; debug adds every retention, recall, and review decision. /memories stats prints the path.' },
  },
  {
    field: 'syncRemote', kind: 'text',
    label: { zh: '记忆库同步远端（Git）', en: 'Memory store remote (Git)' },
    hint: { zh: '记忆库本身就是一个 git 仓库，这里填一台私有仓库的地址（如 git@github.com:you/dsh-memories-store.git），多台机器就会共用同一份记忆。留空则只在本机提交历史、不联网。写入路径只做本地提交，拉取与推送在后台按间隔进行。', en: 'The store is a git repository; point this at one private repository and every machine shares the same memories. Empty keeps local history only. Writes commit locally; fetch and push happen in the background.' },
  },
  {
    field: 'syncClock', kind: 'text',
    label: { zh: '定时同步时刻（本地时间）', en: 'Scheduled sync times (local)' },
    hint: { zh: '逗号分隔的 HH:MM，例如 12:05,18:05——默认在 DeepSeek 谷时开始后几分钟，冲突合并的模型调用最便宜。留空则改按下面的间隔同步。', en: 'Comma separated HH:MM, e.g. 12:05,18:05 — a few minutes after DeepSeek off-peak pricing starts, when a conflict merge costs least. Empty falls back to the interval below.' },
  },
  {
    field: 'syncIntervalMinutes', kind: 'number', min: 0, step: 5,
    label: { zh: '后台同步间隔（分钟）', en: 'Background sync interval (minutes)' },
    hint: { zh: '每隔这么久拉取、变基并推送一次。0 停止定时同步，只保留本地提交。', en: 'How often to fetch, rebase and push in the background. 0 stops the timer and keeps local commits only.' },
  },
  {
    field: 'syncDebounceSeconds', kind: 'number', min: 0, step: 1,
    label: { zh: '写入合并窗口（秒）', en: 'Write debounce (seconds)' },
    hint: { zh: '一串连续写入会在这么长时间内合并成一次提交，避免每条记忆一个 commit。真实网络动作永远不在写入路径上。', en: 'A burst of writes is folded into one commit within this window. Network work never runs on the write path.' },
  },
  {
    field: 'syncConflictProvider', kind: 'text',
    label: { zh: '冲突解析 Provider', en: 'Conflict resolver provider' },
    hint: { zh: '两台机器改了同一条记忆时，用来合并两次改动的模型提供方。留空回落到抽取路由；两者都没有时按 updated 取新版本，旧版本留在 git 历史里。', en: 'Provider used to merge two revisions of the same memory. Empty falls back to the extraction route; with neither, the newer updated wins and the older revision stays in git history.' },
  },
  {
    field: 'syncConflictModel', kind: 'text',
    label: { zh: '冲突解析 Model', en: 'Conflict resolver model' },
    hint: { zh: '合并冲突时使用的模型。留空回落到抽取模型。', en: 'Model used to merge a conflicting memory. Empty falls back to the extraction model.' },
  },
  {
    field: 'traceMaintenance', kind: 'boolean',
    label: { zh: '记录维护决策明细', en: 'Trace maintenance decisions' },
    hint: { zh: '把归档、按需补注、复审选择等决策提升到 info，默认等级就能看到；关闭时它们只在 debug 等级出现。', en: 'Log retention, recall, and selection decisions at info so a stock log level records them; off keeps them at debug.' },
  },
  {
    field: 'peakHours', kind: 'text',
    label: { zh: '错峰时段（避开高峰）', en: 'Peak hours to avoid' },
    hint: { zh: '本地时间的「高价时段」，后台抽取与合并会推迟到窗口之外；留空不限制。DeepSeek 用 "Mon-Fri 09:00-12:00, Mon-Fri 14:00-18:00"（北京时间，峰价是谷价 2 倍；周末与夜间全为谷时）。手动 /memories mine 与 consolidate 不受此限制。', en: 'Local-time windows whose tokens cost more; background extraction and consolidation are deferred out of them. Empty means no restriction. For DeepSeek use "Mon-Fri 09:00-12:00, Mon-Fri 14:00-18:00" (Beijing time; peak is double price and weekends are always off-peak). /memories mine and consolidate ignore this.' },
  },
]

/** Whether the user layer carries an override for one field. */
function isOverridden(snapshot, field) {
  const user = snapshot.user
  return typeof user === 'object' && user !== null && Object.prototype.hasOwnProperty.call(user, field)
}

/** Pick one field's label/hint for the active locale. */
function fieldText(field, lang) {
  return {
    label: field.label[lang] ?? field.label.zh,
    hint: field.hint[lang] ?? field.hint.zh,
  }
}

/** Render one row: label + hint on the left, control on the right. */
function renderRow(React, field, snapshot, draft, onEdit, lang, copy) {
  const text = fieldText(field, lang)
  const current = draft !== undefined ? draft : snapshot.value === undefined ? undefined : snapshot.value[field.field]
  const disabled = snapshot.writable !== true || snapshot.status !== 'ready'
  const controls = []
  if (field.kind === 'boolean') {
    controls.push(React.createElement('input', {
      key: 'input',
      className: 'dshm-check',
      type: 'checkbox',
      checked: current === true,
      disabled,
      onChange: (event) => onEdit(field.field, event.target.checked),
    }))
  } else if (field.kind === 'select') {
    controls.push(React.createElement('select', {
      key: 'input',
      className: 'dshm-input',
      value: current === undefined || current === null ? '' : String(current),
      disabled,
      onChange: (event) => onEdit(field.field, event.target.value),
    }, (field.options ?? []).map((option) => React.createElement('option', {
      key: option.value,
      value: option.value,
    }, option.label[lang] ?? option.label.zh))))
  } else {
    controls.push(React.createElement('input', {
      key: 'input',
      className: 'dshm-input',
      type: field.kind === 'number' ? 'number' : 'text',
      value: current === undefined || current === null ? '' : String(current),
      min: field.min,
      step: field.step,
      disabled,
      onChange: (event) => onEdit(field.field, event.target.value),
    }))
  }
  if (!disabled && isOverridden(snapshot, field.field)) {
    controls.push(React.createElement('button', {
      key: 'reset',
      className: 'dshm-reset',
      type: 'button',
      title: copy.reset,
      onClick: () => onEdit(field.field, undefined),
    }, copy.reset))
  }
  return React.createElement('div', { key: field.field, className: 'dshm-row' }, [
    React.createElement('div', { key: 'label', className: 'dshm-label' }, [
      React.createElement('span', { key: 'name' }, text.label),
      React.createElement('span', { key: 'hint', className: 'dshm-hint' }, text.hint),
    ]),
    React.createElement('div', { key: 'control', className: 'dshm-control' }, controls),
  ])
}

/**
 * Build the card component.
 *
 * `props.scope` is the entry's config form and `props.useSnapshot` its reactive
 * hook, both supplied by the registration's inject face; `props.lang` and
 * `props.copy` pick the labels and chrome for the active locale. The component is
 * embedded at the foot of the Memories settings page, so it edits one entry
 * through one write path regardless of where it is rendered.
 *
 * @param React - the shell's React instance.
 * @returns the card component.
 */
function createMemoriesCard(React) {
  return function MemoriesCard(props) {
    const scope = props.scope
    const snapshot = props.useSnapshot((value) => value)
    const lang = props.lang ?? 'zh'
    const copy = props.copy ?? CARD_COPY[lang]
    const [error, setError] = React.useState(null)
    const [saved, setSaved] = React.useState(false)
    const [pending, setPending] = React.useState({})

    const settle = (field) => {
      setPending((previous) => {
        const next = { ...previous }
        delete next[field]
        return next
      })
    }

    const onEdit = (field, value) => {
      setError(null)
      setSaved(false)
      setPending((previous) => ({ ...previous, [field]: value }))
      const operation = value === undefined ? scope.unset(field) : scope.set(field, value)
      Promise.resolve(operation).then(
        () => { settle(field); setSaved(true) },
        (failure) => { settle(field); setError(failure instanceof Error ? failure.message : String(failure)) },
      )
    }

    const statusLine = error !== null
      ? React.createElement('p', { key: 'status', className: 'dshm-status dshm-error' }, error)
      : saved
        ? React.createElement('p', { key: 'status', className: 'dshm-status dshm-ok' }, copy.saved)
        : null

    const children = [
      React.createElement('div', { key: 'head', className: 'dshm-head' }, [
        React.createElement('h3', { key: 'title', className: 'dshm-title' }, props.title ?? NS),
        React.createElement('span', { key: 'ns', className: 'dshm-ns' }, NS),
      ]),
    ]
    if (props.intro !== false) {
      children.push(React.createElement('p', { key: 'intro', className: 'dshm-intro' },
        props.intro ?? '跨会话记忆：项目作用域由本工作区所有会话共享，全局作用域由所有项目共享。'))
    }
    if (snapshot.status === 'unavailable') {
      children.push(React.createElement('p', { key: 'unavailable', className: 'dshm-status dshm-error' }, copy.unavailable))
    }
    for (const field of FIELDS) children.push(renderRow(React, field, snapshot, pending[field.field], onEdit, lang, copy))
    if (statusLine !== null) children.push(statusLine)
    children.push(React.createElement('p', { key: 'note', className: 'dshm-note' }, copy.note))
    return React.createElement('section', { className: 'dshm-card' }, children)
  }
}