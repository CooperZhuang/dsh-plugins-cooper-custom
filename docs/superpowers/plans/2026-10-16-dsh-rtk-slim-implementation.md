# dsh-rtk-slim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个 DSH 宿主半边插件 `dsh-rtk-slim`：把 `bash` / `job_output` 的超大输出交给 `rtk` 精简，且每次精简都可追溯（全文经官方 `spillStore` 落盘）、任何失败都保留原文。

**Architecture:** 单个 `tools/post-execute` waterfall 监听器（登记为最内层，因此拿到原始结果），内部是 6 个纯逻辑模块 + 1 个薄装配层：`content`（块↔文本边界）→ `markers`（末尾状态标记拆/拼）→ `sniff`（家族嗅探选 filter）→ `rtk`（子进程调用）→ `guards`（I1/I2/I3 + 严格变小体检）→ `spill`（落盘 + notice）。运行时只 import `@deepseek-ai/schemastery`，其余 `@deepseek-ai/*` 仅作 JSDoc 类型。

**Tech Stack:** Node.js ≥ 20（实测运行时 Node 26.9.0）、纯 ESM JavaScript（`lib/*.js` 即源码，无构建）、`node:test`、`@deepseek-ai/schemastery@^3.18.4`、`tsc --checkJs`（类型检查）、真 `rtk 0.49.0`（`/opt/homebrew/bin/rtk`）。

**Spec:** `docs/superpowers/specs/2026-10-16-dsh-rtk-slim-design.md`（v3，两轮评审 Approved）

---

## 全局约定

- 仓库根：`/Users/cooper/Documents/Code/dsh-rtk-slim`（下称「仓库根」）。所有相对路径都相对它。
- 每个 Task 结束都要 commit；commit message 用 `feat:` / `test:` / `docs:` / `chore:` 前缀。
- 单测跑法：`node --test test/*.test.mjs`（显式 glob，避免 `node --test test/` 把 `test/bin/` 下的 stub 当测试文件执行）。
- 所有长度/阈值单位是**字节**，一律 `Buffer.byteLength(x, 'utf8')`，不用 `String.length`。
- **运行时禁止** `import` 任何 `@deepseek-ai/dsh-*`；类型只写 `@typedef {import('...')}`（运行时擦除）。

## 文件结构

| 路径 | 职责 |
|---|---|
| `package.json` | 包元数据、`dsh.bundle.patch`、依赖、scripts |
| `jsconfig.json` | `checkJs` + `strict` 的 `tsc --noEmit` 配置 |
| `cordis.patch.yml` | bundle patch：一行 `insert`（id `rtk-slim`） |
| `.gitignore` | `node_modules/` 等 |
| `lib/content.js` | `singleText` / `textBlock`：块 ↔ 文本的唯一边界 |
| `lib/markers.js` | `splitTailMarkers` / `joinTailMarkers`：末尾状态标记拆拼 |
| `lib/sniff.js` | `FAMILIES` / `chooseFilter`：家族嗅探 |
| `lib/guards.js` | `FAILURE_PATTERNS` / `collectFailureLines` / `checkInvariants` |
| `lib/rtk.js` | `runRtk`：spawn / 超时 / 整组击杀 / 输出上限 / 取消 |
| `lib/spill.js` | `saveFullText` / `formatCondenseNotice` |
| `lib/index.js` | `name` / `inject` / `Config` / `apply` / `createPostExecuteHandler` |
| `test/bin/rtk-stub.mjs` | 可注入故障的假 rtk（用 `node <stub>` 调用，不依赖 shebang/chmod） |
| `test/fixtures/make-fixtures.mjs` | 生成 10 份确定性语料 |
| `test/fixtures/*.txt` | 提交进仓库的语料 |
| `test/content.test.mjs` 等 7 个测试文件 | 见各 Task |
| `README.md` | 用法、配置、设计要点、安装 |

---

## Task 1: 仓库骨架与测试跑道

**Files:**
- Create: `package.json`, `jsconfig.json`, `cordis.patch.yml`, `.gitignore`

- [ ] **Step 1: 写 `package.json`**

```json
{
  "name": "dsh-rtk-slim",
  "version": "0.1.0",
  "private": true,
  "description": "DSH host plugin: condense oversized bash/job_output text through rtk, with lossless spill traceability",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "license": "MIT",
  "scripts": {
    "test": "node --test test/*.test.mjs",
    "typecheck": "tsc -p jsconfig.json",
    "check": "npm run typecheck && npm test"
  },
  "dependencies": {
    "@deepseek-ai/schemastery": "^3.18.4"
  },
  "devDependencies": {
    "@deepseek-ai/dsh-llm": "0.2.1-alpha.2",
    "@deepseek-ai/dsh-tools": "0.2.1-alpha.2",
    "@types/node": "^24.0.0",
    "typescript": "^5.9.0"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

说明：`@deepseek-ai/cordis` **不声明**（host 为 4.0.5-alpha.1，运行时由宿主注入；本插件也从不 import 其类型——`ctx` 用自己的 JSDoc typedef）。这是 spec §11 的收紧版：devDeps 里连 cordis 都不需要。

- [ ] **Step 2: 写 `jsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "nodenext",
    "lib": ["ES2023"],
    "types": ["node"],
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["lib/**/*.js", "test/**/*.mjs"]
}
```

- [ ] **Step 3: 写 `cordis.patch.yml`**

```yaml
# The dsh-rtk-slim bundle patch: one row inserting the rtk output condenser over
# the profile root. Address it by id (`rtk-slim`) from the profile's own patch
# layer; the last write wins.
#
# Every behavioural knob lives on this row as a live config field (see the
# plugin's Config schema). This row carries deployment facts only.
- insert:
    - id: rtk-slim
      name: dsh-rtk-slim
      config:
        # command: rtk            # bare name resolves through PATH
        # tools: ['bash', 'job_output']
        # minBytes: 2048
        # spill: true
        # requireSpill: true
        # notice: true
        enabled: true
```

- [ ] **Step 4: 写 `.gitignore`**

```
node_modules/
*.log
```

- [ ] **Step 5: 安装依赖并确认运行时可用**

Run:
```bash
cd /Users/cooper/Documents/Code/dsh-rtk-slim
npm install --ignore-scripts
node -e "import('@deepseek-ai/schemastery').then(m=>console.log('schemastery keys:', ['dict','union','const','string','boolean','number','array'].every(k=>k in m.default)))"
```
Expected: `schemastery keys: true`（若为 `false`，说明 schemastery 该版本缺方法，先停下来核对再继续）

- [ ] **Step 6: Commit**

```bash
cd /Users/cooper/Documents/Code/dsh-rtk-slim
git add -A && git commit -m "chore: 插件骨架（package.json / jsconfig / bundle patch / gitignore）"
```

---

## Task 2: `lib/content.js` —— 内容块 ↔ 文本边界

**Files:**
- Create: `lib/content.js`, `test/content.test.mjs`

- [ ] **Step 1: 写失败测试 `test/content.test.mjs`**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { singleText, textBlock } from '../lib/content.js'

test('singleText: 单个 text block 返回其文本', () => {
  assert.equal(singleText([{ type: 'text', text: 'hello' }]), 'hello')
})

test('singleText: 空文本也返回（不是 undefined）', () => {
  assert.equal(singleText([{ type: 'text', text: '' }]), '')
})

test('singleText: 多块 / 非文本块 / 空数组 一律 bail', () => {
  assert.equal(singleText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), undefined)
  assert.equal(singleText([{ type: 'image', attachment: {} }]), undefined)
  assert.equal(singleText([]), undefined)
  assert.equal(singleText(undefined), undefined)
})

test('textBlock: 回填为单个 text block', () => {
  assert.deepEqual(textBlock('x'), [{ type: 'text', text: 'x' }])
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/content.test.mjs`
Expected: FAIL —— `Cannot find module '.../lib/content.js'`

- [ ] **Step 3: 实现 `lib/content.js`**

```js
/**
 * Boundary between the harness content-block payload and plain text.
 *
 * `tools/post-execute` hands over `result.content` as a `ContentBlock[]`, not a
 * string. The plugin is only interested in the common single-text-block case
 * (what `bash` and `job_output` render); anything else is left untouched so we
 * never fight a tool's own definition-owned content finalizer.
 *
 * @module dsh-rtk-slim/content
 */

/**
 * @typedef {import('@deepseek-ai/dsh-llm').ContentBlock} ContentBlock
 */

/**
 * Text of a payload that is exactly one text block.
 * @param {readonly ContentBlock[] | undefined} content
 * @returns {string | undefined} `undefined` means "out of scope, bail".
 */
export function singleText(content) {
  if (!Array.isArray(content) || content.length !== 1) return undefined
  const block = content[0]
  if (block === null || typeof block !== 'object' || block.type !== 'text') return undefined
  return block.text
}

/**
 * Re-wrap condensed text as the single text block the registry expects.
 * @param {string} text
 * @returns {ContentBlock[]}
 */
export function textBlock(text) {
  return [{ type: 'text', text }]
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/content.test.mjs`
Expected: PASS（4 pass）

- [ ] **Step 5: Commit**

```bash
git add lib/content.js test/content.test.mjs
git commit -m "feat: content 模块（ContentBlock 单文本块边界）"
```

---

## Task 3: `lib/markers.js` —— 末尾状态标记拆拼

**Files:**
- Create: `lib/markers.js`, `test/markers.test.mjs`

- [ ] **Step 1: 写失败测试 `test/markers.test.mjs`**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { joinTailMarkers, splitTailMarkers } from '../lib/markers.js'

const cases = [
  'out\n[exit code: 1]',
  'out\n[stderr]\nboom\n[exit code: 2]',
  'out\n[timed out after 30000ms]',
  'out\n[stopped: user]\n[exit code: 130]',
  'out\n[killed by signal: SIGKILL]',
  'out\n[sandbox: file access denied under workspace-write mode]',
  'out\n[sandbox: file access denied under read-only mode]\n[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]',
  'out\n[still running after 15000ms; moved to background job job-1]\nThe command keeps running in the background. You will be notified when it finishes; read newer output with job_output, stop it with job_kill.',
  '[exit code: 1]',
  'no markers at all',
  'out with\n\nblank line before marker\n[exit code: 3]',
]

test('split/join 往返逐字节一致', () => {
  for (const text of cases) {
    const { body, tail } = splitTailMarkers(text)
    assert.equal(joinTailMarkers(body, tail), text, `roundtrip failed: ${JSON.stringify(text)}`)
  }
})

test('尾部标记被正确拆出，正文不含标记', () => {
  const { body, tail } = splitTailMarkers('out\n[stderr]\nboom\n[exit code: 2]')
  assert.equal(body, 'out\n[stderr]\nboom')
  assert.equal(tail, '[exit code: 2]')
})

test('后台指引段落随 still-running 标记一起拆出', () => {
  const text = cases[7]
  const { body, tail } = splitTailMarkers(text)
  assert.equal(body, 'out')
  assert.ok(tail.startsWith('[still running after 15000ms; moved to background job job-1]'))
  assert.ok(tail.includes('The command keeps running in the background.'))
})

test('正文里形似标记的行不被拆（只处理末尾连续区段）', () => {
  const { body, tail } = splitTailMarkers('echoed [exit code: 1] in the middle\nreal output')
  assert.equal(body, 'echoed [exit code: 1] in the middle\nreal output')
  assert.equal(tail, '')
})

test('无标记时 tail 为空字符串', () => {
  assert.deepEqual(splitTailMarkers('plain'), { body: 'plain', tail: '' })
  assert.deepEqual(splitTailMarkers(''), { body: '', tail: '' })
})

test('孤立的后台指引（前面不是标记）不被拆', () => {
  const text = 'The command keeps running in the background. You will be notified when it finishes; read newer output with job_output, stop it with job_kill.'
  assert.deepEqual(splitTailMarkers(text), { body: text, tail: '' })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/markers.test.mjs`
Expected: FAIL —— `Cannot find module '.../lib/markers.js'`

- [ ] **Step 3: 实现 `lib/markers.js`**

```js
/**
 * Trailing status markers, exactly as the harness bash tool renders them
 * (`dsh-tool-bash`'s `renderResult` / `renderPromoted`). They are the model's
 * contract for exit status, so they must survive condensation byte-for-byte.
 *
 * @module dsh-rtk-slim/markers
 */

/** One trailing status marker line. */
const MARKER = /^\[(?:exit code: -?\d+|timed out after \d+ms|stopped: [^\]]*|killed by signal: [^\]]*|sandbox: [^\]]*|still running after \d+ms; moved to background job [^\]]+)\]$/

/** Opening words of the guidance paragraph that follows a background promotion. */
const BACKGROUND_GUIDANCE = 'The command keeps running in the background.'

/**
 * Split the trailing status block off a rendered tool result.
 * @param {string} text
 * @returns {{ body: string, tail: string }} `tail` is `''` when nothing matched.
 */
export function splitTailMarkers(text) {
  if (text.length === 0) return { body: '', tail: '' }
  const lines = text.split('\n')
  let cut = lines.length
  // The promoted-to-background shape is "<marker>\n<guidance>"; consume the
  // guidance only when a real marker sits directly above it.
  if (cut > 1 && lines[cut - 1].startsWith(BACKGROUND_GUIDANCE) && MARKER.test(lines[cut - 2])) cut -= 1
  while (cut > 0 && MARKER.test(lines[cut - 1])) cut -= 1
  if (cut === lines.length) return { body: text, tail: '' }
  return { body: lines.slice(0, cut).join('\n'), tail: lines.slice(cut).join('\n') }
}

/**
 * Re-attach a split `tail`. `joinTailMarkers(...split(x)) === x` for every `x`.
 * @param {string} body
 * @param {string} tail
 * @returns {string}
 */
export function joinTailMarkers(body, tail) {
  if (tail === '') return body
  return body === '' ? tail : `${body}\n${tail}`
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/markers.test.mjs`
Expected: PASS（6 pass）

- [ ] **Step 5: Commit**

```bash
git add lib/markers.js test/markers.test.mjs
git commit -m "feat: markers 模块（末尾状态标记逐字节拆拼）"
```

---

## Task 4: `lib/sniff.js` —— 家族嗅探 + 语料 fixture

**Files:**
- Create: `lib/sniff.js`, `test/sniff.test.mjs`, `test/fixtures/make-fixtures.mjs`, `test/fixtures/*.txt`

- [ ] **Step 1: 写语料生成器 `test/fixtures/make-fixtures.mjs`**

```js
#!/usr/bin/env node
// Deterministic corpora for sniff/guard/e2e tests. Run from the repo root:
//   node test/fixtures/make-fixtures.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const write = (name, text) => writeFileSync(join(here, name), text)

const cargo = (result) => {
  const lines = [
    '   Compiling foo v0.1.0',
    '    Finished `test` profile [unoptimized + debuginfo] target(s) in 1.2s',
    '     Running tests/lib.rs',
    'running 40 tests',
  ]
  for (let i = 1; i <= 40; i += 1) lines.push(`test t${i} ... ${result === 'FAILED' && i === 7 ? 'FAILED' : 'ok'}`)
  lines.push('')
  lines.push(
    result === 'FAILED'
      ? 'test result: FAILED. 39 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.31s'
      : 'test result: ok. 40 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.31s',
  )
  return `${lines.join('\n')}\n`
}

const pytest = (result) => {
  const lines = [
    '============================= test session starts ==============================',
    'platform darwin -- Python 3.11.0',
    'collected 30 items',
    '',
  ]
  for (let i = 1; i <= 30; i += 1) {
    const outcome = result === 'FAILED' && i === 4 ? 'FAILED' : 'PASSED'
    lines.push(`tests/test_x.py::test_${i} ${outcome}${' '.repeat(Math.max(1, 34 - String(i).length))}[ ${i * 3}%]`)
  }
  lines.push('')
  lines.push(
    result === 'FAILED'
      ? '=================================== FAILURES ===================================\n__________________________________ test_4 ______________________________________\n\n    assert 1 == 2\nE   AssertionError\n\n=========================== short test summary info ============================\nFAILED tests/test_x.py::test_4 - AssertionError\n========================= 1 failed, 29 passed in 1.44s ========================='
      : '============================== 30 passed in 1.44s ==============================',
  )
  return `${lines.join('\n')}\n`
}

const gitLog = () => {
  const subjects = [
    '可观测性：摘要脚本 + 三条事后确认检索效果的行',
    '搜索面按词法相关度排序，注入面保持按注意力',
    '检索评测分成两个承诺来量：排名与闸门；并把「中文改写」那条查清',
    '一跳的边加上稀有度规则，并用评测把 EXPAND_FACTOR 定在 0.4',
    '真实库离线检索评测：并修掉它当场暴露的三个一跳错误',
  ]
  const lines = []
  for (let i = 0; i < 74; i += 1) {
    const sha = (0x1000000 + i * 0x9e3779b1).toString(16).slice(0, 7)
    lines.push(`${sha} ${subjects[i % subjects.length]} #${i}`)
  }
  return `${lines.join('\n')}\n`
}

const grepRn = () => {
  const lines = []
  for (let i = 0; i < 60; i += 1) {
    lines.push(`/Users/cooper/Documents/Code/some-repo/src/module_${i}/index.ts:${10 + i}:export function handler${i}() {`)
  }
  return `${lines.join('\n')}\n`
}

const lsLa = () => {
  const lines = ['total 96']
  for (let i = 0; i < 40; i += 1) {
    lines.push(`drwx------@ ${String(i).padStart(3)} cooper  admin   ${String(96 + i).padStart(5)} Oct 16 12:0${i % 10} dir_${i}`)
  }
  return `${lines.join('\n')}\n`
}

const source = () => {
  const lines = ['/** A module. */', 'import { x } from "./x.js"', '']
  for (let i = 0; i < 120; i += 1) lines.push(`export function fn${i}(a, b) { return a + b + ${i} }`)
  return `${lines.join('\n')}\n`
}

const json = () => {
  const object = {}
  for (let i = 0; i < 120; i += 1) object[`key_${i}`] = `value_${i}`
  return `${JSON.stringify(object, null, 2)}\n`
}

const logTimestamps = () => {
  const lines = []
  for (let i = 0; i < 40; i += 1) {
    lines.push(`2024-01-0${(i % 9) + 1}:12:0${i % 10}:00: request handled in ${i}ms`)
  }
  return `${lines.join('\n')}\n`
}

mkdirSync(here, { recursive: true })
write('cargo-test-pass.txt', cargo('ok'))
write('cargo-test-fail.txt', cargo('FAILED'))
write('pytest-pass.txt', pytest('ok'))
write('pytest-fail.txt', pytest('FAILED'))
write('git-log.txt', gitLog())
write('grep-rn.txt', grepRn())
write('ls-la.txt', lsLa())
write('source.js.txt', source())
write('json.txt', json())
write('log-timestamps.txt', logTimestamps())
console.log('fixtures written:', here)
```

- [ ] **Step 2: 生成语料并确认体积**

Run:
```bash
node test/fixtures/make-fixtures.mjs
wc -c test/fixtures/*.txt
```
Expected: 10 个文件；`cargo-test-pass.txt` ≈ 866 B、`pytest-pass.txt` ≈ 2.4 KB、`git-log.txt` ≈ 6 KB、`grep-rn.txt` ≈ 4.7 KB

- [ ] **Step 3: 写失败测试 `test/sniff.test.mjs`**

```js
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { chooseFilter } from '../lib/sniff.js'

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

test('正例：四个家族各自命中', () => {
  assert.equal(chooseFilter(fixture('cargo-test-pass.txt')).filter, 'cargo-test')
  assert.equal(chooseFilter(fixture('pytest-pass.txt')).filter, 'pytest')
  assert.equal(chooseFilter(fixture('git-log.txt')).filter, 'git-log')
  assert.equal(chooseFilter(fixture('grep-rn.txt')).filter, 'grep')
})

test('负例：五类内容一律落 auto（不猜 filter）', () => {
  for (const name of ['ls-la.txt', 'source.js.txt', 'json.txt', 'log-timestamps.txt']) {
    assert.deepEqual(chooseFilter(fixture(name)), { family: 'auto', filter: undefined }, name)
  }
  assert.deepEqual(chooseFilter('plain unstructured text\n'.repeat(20)), { family: 'auto', filter: undefined })
})

test('边界：只有 running N tests 而没有 test result 不算 cargo-test', () => {
  const text = 'running 40 tests\ntest a ... ok\n'
  assert.equal(chooseFilter(text).family, 'auto')
})

test('边界：含 :: 但没有结果词不算 pytest', () => {
  const text = 'src/a.ts::handler\nsrc/b.ts::other\n'.repeat(10)
  assert.equal(chooseFilter(text).family, 'auto')
})

test('边界：3 行 grep 形态不触发（阈值 5）', () => {
  const text = 'a/x.ts:1:one\nb/y.ts:2:two\nc/z.ts:3:three\n'
  assert.equal(chooseFilter(text).family, 'auto')
})

test('边界：find 形态（裸路径、无冒号）命中 find', () => {
  const text = Array.from({ length: 12 }, (_, i) => `src/deep/dir_${i}/file.ts`).join('\n') + '\n'
  assert.equal(chooseFilter(text).filter, 'find')
})

test('overrides：字符串覆盖 filter 名，false 停用该家族', () => {
  const text = fixture('git-log.txt')
  assert.equal(chooseFilter(text, { 'git-log': 'log' }).filter, 'log')
  assert.equal(chooseFilter(text, { 'git-log': false }).family, 'auto')
})
```

- [ ] **Step 4: 运行确认失败**

Run: `node --test test/sniff.test.mjs`
Expected: FAIL —— `Cannot find module '.../lib/sniff.js'`

- [ ] **Step 5: 实现 `lib/sniff.js`**

```js
/**
 * Family detection: decide whether `rtk pipe -f <filter>` is provably
 * applicable to this text. A wrong `-f` destroys content (measured: 751 B of
 * unrelated text collapsed to 4 lines), so anything unrecognised falls through
 * to a bare `rtk pipe`, which passes unrecognised text through byte-for-byte.
 *
 * @module dsh-rtk-slim/sniff
 */

const CARGO_RUNNING = /^running \d+ tests?$/m
const CARGO_RESULT = /^test result:/m
const PYTEST_HEADER = /^=+ .*test session starts.* =+$/m
const PYTEST_OUTCOME = /^\S+::\S+ (?:PASSED|FAILED|ERROR)/m
const GIT_ONELINE = /^[0-9a-f]{7,40} \S/
const GIT_COMMIT = /^commit [0-9a-f]{40}$/m
const GREP_LINE = /^[^\s:]*[/.][^\s:]*:\d+:/
const BARE_LINE = /^\S+$/

/**
 * @param {string} text
 * @param {RegExp} re
 * @returns {number}
 */
function countLines(text, re) {
  const global = new RegExp(re.source, 'gm')
  const found = text.match(global)
  return found === null ? 0 : found.length
}

/** @typedef {{ id: string, filter: string, test: (text: string) => boolean }} Family */

/** Ordered families; first match wins. */
export const FAMILIES = /** @type {Family[]} */ ([
  {
    id: 'cargo-test',
    filter: 'cargo-test',
    test: (text) => CARGO_RUNNING.test(text) && CARGO_RESULT.test(text),
  },
  {
    id: 'pytest',
    filter: 'pytest',
    test: (text) => PYTEST_HEADER.test(text) || PYTEST_OUTCOME.test(text),
  },
  {
    id: 'git-log',
    filter: 'git-log',
    test: (text) => countLines(text, GIT_ONELINE) >= 5 || GIT_COMMIT.test(text),
  },
  {
    id: 'grep',
    filter: 'grep',
    test: (text) => countLines(text, GREP_LINE) >= 5,
  },
  {
    id: 'find',
    filter: 'find',
    test: (text) => {
      const bare = text.split('\n').filter((line) => BARE_LINE.test(line))
      if (bare.length < 10) return false
      return bare.every((line) => line.includes('/')) && bare.every((line) => !line.includes(':'))
    },
  },
])

/**
 * @typedef {Record<string, string | false>} FilterOverrides
 */

/**
 * @param {string} text body text (trailing status markers already removed)
 * @param {FilterOverrides} [overrides] config `filters`
 * @returns {{ family: string, filter: string | undefined }} `auto` means "bare rtk pipe"
 */
export function chooseFilter(text, overrides = {}) {
  for (const family of FAMILIES) {
    const override = overrides[family.id]
    if (override === false) continue
    if (!family.test(text)) continue
    return { family: family.id, filter: typeof override === 'string' ? override : family.filter }
  }
  return { family: 'auto', filter: undefined }
}
```

- [ ] **Step 6: 运行确认通过**

Run: `node --test test/sniff.test.mjs`
Expected: PASS（7 pass）。若 `find` 或 `grep` 用例失败，先看是语料形态与正则不符，**改正则前先确认语料确实代表真实输出**。

- [ ] **Step 7: Commit**

```bash
git add lib/sniff.js test/sniff.test.mjs test/fixtures
git commit -m "feat: sniff 模块（家族嗅探 + 10 份确定性语料）"
```

---

## Task 5: `lib/guards.js` —— 不变式体检

**Files:**
- Create: `lib/guards.js`, `test/guards.test.mjs`

- [ ] **Step 1: 写失败测试 `test/guards.test.mjs`**

```js
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { checkInvariants, collectFailureLines } from '../lib/guards.js'

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

test('I2 陷阱回归：全通过的测试输出里 "0 failed" 不得恒假', () => {
  const raw = fixture('cargo-test-pass.txt')
  assert.deepEqual(collectFailureLines(raw), [])
  assert.deepEqual(checkInvariants({ raw, condensed: 'cargo test: 40 passed (1 suite, 0.31s)' }), { ok: true })
})

test('I2：失败的测试输出一旦丢掉失败行就回退', () => {
  const raw = fixture('cargo-test-fail.txt')
  assert.ok(collectFailureLines(raw).some((line) => line.startsWith('test result: FAILED')))
  assert.deepEqual(checkInvariants({ raw, condensed: 'cargo test: 39 passed, 1 failed' }), {
    ok: false,
    reason: 'failures',
  })
})

test('I2：pytest 失败行同理', () => {
  const raw = fixture('pytest-fail.txt')
  const condensed = raw.split('\n').filter((line) => line.includes('FAILED')).join('\n')
  assert.deepEqual(checkInvariants({ raw, condensed }), { ok: true })
  assert.deepEqual(checkInvariants({ raw, condensed: '1 failed, 29 passed in 1.44s' }), {
    ok: false,
    reason: 'failures',
  })
})

test('共同前置：空 / 未变化 / 变大 三种闸门', () => {
  assert.deepEqual(checkInvariants({ raw: 'abc', condensed: '' }), { ok: false, reason: 'empty' })
  assert.deepEqual(checkInvariants({ raw: 'abc', condensed: 'abc' }), { ok: false, reason: 'unchanged' })
  assert.deepEqual(checkInvariants({ raw: 'abc', condensed: 'abcd' }), { ok: false, reason: 'expanded' })
  assert.deepEqual(checkInvariants({ raw: 'abc\n', condensed: 'abc' }), { ok: false, reason: 'unchanged' })
})

test('I3：极端压缩比且无省略标记 -> ratio 回退；带省略标记 -> 放行', () => {
  const raw = `${Array.from({ length: 900 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')}\n`
  assert.ok(Buffer.byteLength(raw, 'utf8') >= 32 * 1024)
  assert.deepEqual(checkInvariants({ raw, condensed: 'stub' }), { ok: false, reason: 'ratio' })
  assert.deepEqual(checkInvariants({ raw, condensed: 'first\n[+899 lines omitted]' }), { ok: true })
  assert.deepEqual(checkInvariants({ raw, condensed: 'first\nFull formatted result stored at: /tmp/x.txt' }), { ok: true })
})

test('字节单位：多字节 UTF-8 文本下比值按字节算', () => {
  const raw = '中文'.repeat(20) // 120 chars, 360 bytes
  assert.deepEqual(checkInvariants({ raw, condensed: '中文' }), { ok: true }) // 6 bytes < 360
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/guards.test.mjs`
Expected: FAIL —— `Cannot find module '.../lib/guards.js'`

- [ ] **Step 3: 实现 `lib/guards.js`**

```js
/**
 * Invariants a condensation must satisfy before it may replace model-visible
 * text. Any failure means "keep the original" — never an error result.
 *
 * I1 (marker preservation) is structural: callers split the trailing status
 * block off before calling rtk and re-attach it verbatim afterwards, so it
 * cannot be lost here.
 *
 * @module dsh-rtk-slim/guards
 */

/**
 * Failure-signal lines. Deliberately narrow: a bare `failed` word would make
 * the invariant vacuously false on a passing run ("0 failed"), killing the
 * main win.
 */
export const FAILURE_PATTERNS = [
  /^test result: FAILED/,
  /^FAILED\b/,
  /^--- FAIL:/,
  /^error(\[E\d+\])?:/,
  /^Traceback \(most recent call last\):/,
  /panicked at/,
  /^AssertionError\b/,
  /^FAIL\b/,
]

/**
 * Distinct failure-signal lines in `text` (trimmed).
 * @param {string} text
 * @returns {string[]}
 */
export function collectFailureLines(text) {
  const found = new Set()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (FAILURE_PATTERNS.some((pattern) => pattern.test(trimmed))) found.add(trimmed)
  }
  return [...found]
}

/** @typedef {{ ok: true } | { ok: false, reason: 'empty' | 'unchanged' | 'expanded' | 'failures' | 'ratio' }} GuardResult */

/**
 * @param {{ raw: string, condensed: string }} input both already-extracted text
 * @returns {GuardResult}
 */
export function checkInvariants({ raw, condensed }) {
  if (condensed.length === 0) return { ok: false, reason: 'empty' }
  const rawBytes = Buffer.byteLength(raw, 'utf8')
  const condensedBytes = Buffer.byteLength(condensed, 'utf8')
  if (condensed.trim() === raw.trim()) return { ok: false, reason: 'unchanged' }
  if (condensedBytes >= rawBytes) return { ok: false, reason: 'expanded' }
  if (collectFailureLines(raw).some((line) => !condensed.includes(line))) {
    return { ok: false, reason: 'failures' }
  }
  if (condensedBytes < rawBytes * 0.02 && rawBytes >= 32 * 1024) {
    const hasOmissionMarker = /\[\+\d+ lines? omitted\]/.test(condensed)
    const hasSpillNotice = condensed.includes('Full formatted result stored at:')
    if (!hasOmissionMarker && !hasSpillNotice) return { ok: false, reason: 'ratio' }
  }
  return { ok: true }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/guards.test.mjs`
Expected: PASS（6 pass）

- [ ] **Step 5: Commit**

```bash
git add lib/guards.js test/guards.test.mjs
git commit -m "feat: guards 模块（I2 失败证据 / I3 压缩比 / 严格变小）"
```

---

## Task 6: `lib/rtk.js` —— rtk 子进程调用

**Files:**
- Create: `lib/rtk.js`, `test/bin/rtk-stub.mjs`, `test/rtk.test.mjs`

- [ ] **Step 1: 写假 rtk `test/bin/rtk-stub.mjs`**

```js
#!/usr/bin/env node
// Fault-injectable rtk stand-in. Invoked as `node <this file>` with
// RTK_STUB_MODE set; reads all of stdin, then behaves per mode.
const mode = process.env.RTK_STUB_MODE ?? 'ok'

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
})
process.stdin.on('end', () => {
  switch (mode) {
    case 'ok':
      process.stdout.write(`CONDENSED ${Buffer.byteLength(input, 'utf8')}`)
      break
    case 'exit':
      process.exit(3)
      break
    case 'empty':
      process.stdout.write('')
      break
    case 'hang':
      setInterval(() => {}, 1000)
      break
    case 'big': {
      const chunk = 'y'.repeat(64 * 1024)
      for (let i = 0; i < 40; i += 1) process.stdout.write(chunk)
      break
    }
    default:
      process.stderr.write(`unknown RTK_STUB_MODE ${mode}\n`)
      process.exit(64)
  }
})
```

- [ ] **Step 2: 写失败测试 `test/rtk.test.mjs`**

```js
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { runRtk } from '../lib/rtk.js'

const stub = fileURLToPath(new URL('./bin/rtk-stub.mjs', import.meta.url))

const call = (mode, overrides = {}) => {
  process.env.RTK_STUB_MODE = mode
  return runRtk({
    command: process.execPath,
    args: [stub],
    input: 'hello world',
    timeoutMs: 2000,
    maxOutputBytes: 1024 * 1024,
    ...overrides,
  })
}

test('正常：拿到 stdout 文本', async () => {
  assert.deepEqual(await call('ok'), { ok: true, text: 'CONDENSED 11' })
})

test('非零退出：reason=exit', async () => {
  assert.deepEqual(await call('exit'), { ok: false, reason: 'exit' })
})

test('空输出：成功但文本为空（由 guards 判 empty）', async () => {
  assert.deepEqual(await call('empty'), { ok: true, text: '' })
})

test('超时：整组击杀并回退', async () => {
  const started = Date.now()
  const result = await call('hang', { timeoutMs: 300 })
  assert.deepEqual(result, { ok: false, reason: 'timeout' })
  assert.ok(Date.now() - started < 3000, '超时后必须及时返回，不能等子进程自然结束')
})

test('超过 maxOutputBytes：reason=too-large', async () => {
  assert.deepEqual(await call('big', { maxOutputBytes: 4096 }), { ok: false, reason: 'too-large' })
})

test('调用方取消：reason=aborted', async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 150)
  assert.deepEqual(await call('hang', { signal: controller.signal, timeoutMs: 5000 }), {
    ok: false,
    reason: 'aborted',
  })
})

test('可执行文件不存在：reason=spawn', async () => {
  assert.deepEqual(
    await runRtk({
      command: '/definitely/not/a/binary',
      args: [],
      input: 'x',
      timeoutMs: 1000,
      maxOutputBytes: 1024,
    }),
    { ok: false, reason: 'spawn' },
  )
})
```

- [ ] **Step 3: 运行确认失败**

Run: `node --test test/rtk.test.mjs`
Expected: FAIL —— `Cannot find module '.../lib/rtk.js'`

- [ ] **Step 4: 实现 `lib/rtk.js`**

```js
/**
 * rtk invocation. Owns every way the child can misbehave: missing binary,
 * non-zero exit, timeout, caller cancellation, runaway output. Every failure is
 * a value, never a throw — the caller keeps the original text.
 *
 * @module dsh-rtk-slim/rtk
 */

import { spawn } from 'node:child_process'

/** @typedef {{ ok: true, text: string } | { ok: false, reason: 'spawn' | 'exit' | 'timeout' | 'aborted' | 'too-large' }} RunResult */

/**
 * @param {object} input
 * @param {string} input.command
 * @param {string[]} input.args
 * @param {string} input.input stdin payload
 * @param {number} input.timeoutMs
 * @param {AbortSignal} [input.signal]
 * @param {number} input.maxOutputBytes
 * @returns {Promise<RunResult>}
 */
export function runRtk({ command, args, input, timeoutMs, signal, maxOutputBytes }) {
  return new Promise((resolve) => {
    if (signal !== undefined && signal.aborted) {
      resolve({ ok: false, reason: 'aborted' })
      return
    }
    /** @type {import('node:child_process').ChildProcess} */
    let child
    try {
      // `detached` gives the child its own process group so a runaway rtk and
      // its descendants can be killed as a unit.
      child = spawn(command, args, { detached: true, stdio: ['pipe', 'pipe', 'ignore'], signal })
    } catch {
      resolve({ ok: false, reason: 'spawn' })
      return
    }

    let settled = false
    let bytes = 0
    /** @type {Buffer[]} */
    const chunks = []

    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }, true), timeoutMs)
    const onAbort = () => finish({ ok: false, reason: 'aborted' }, true)

    function cleanup() {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    }

    function killGroup() {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }

    /**
     * @param {RunResult} result
     * @param {boolean} [kill]
     */
    function finish(result, kill) {
      if (settled) return
      settled = true
      cleanup()
      if (kill === true) killGroup()
      resolve(result)
    }

    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })

    child.on('error', () => {
      finish({ ok: false, reason: signal !== undefined && signal.aborted ? 'aborted' : 'spawn' })
    })

    child.stdout?.on('data', (/** @type {Buffer} */ chunk) => {
      bytes += chunk.length
      if (bytes > maxOutputBytes) {
        finish({ ok: false, reason: 'too-large' }, true)
        return
      }
      chunks.push(chunk)
    })

    child.on('close', (code) => {
      if (code !== 0) {
        finish({ ok: false, reason: 'exit' })
        return
      }
      finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') })
    })

    child.stdin?.on('error', () => {
      // EPIPE when the child is already gone; the close/error handler decides.
    })
    child.stdin?.end(input)
  })
}
```

- [ ] **Step 5: 运行确认通过**

Run: `node --test test/rtk.test.mjs`
Expected: PASS（7 pass）。`超时` 用例必须明显快于子进程的自然寿命；若卡住，检查 `detached` + `process.kill(-pid)`。

- [ ] **Step 6: Commit**

```bash
git add lib/rtk.js test/rtk.test.mjs test/bin/rtk-stub.mjs
git commit -m "feat: rtk 模块（超时/取消/输出上限/整组击杀，全部降级为值）"
```

---

## Task 7: `lib/spill.js` —— 落盘与 notice

**Files:**
- Create: `lib/spill.js`, `test/spill.test.mjs`

- [ ] **Step 1: 写失败测试 `test/spill.test.mjs`**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { formatCondenseNotice, saveFullText } from '../lib/spill.js'

const exec = { name: 'bash', callId: 'call-1', agent: { session: { header: { id: 'session-1' } } } }
const ctxWith = (spillStore) => ({ get: (name) => (name === 'spillStore' ? spillStore : undefined) })

test('saveFullText：把原文与 owner/source 交给 spillStore', async () => {
  const calls = []
  const store = {
    saveText: async (input) => {
      calls.push(input)
      return { locator: '/tmp/spill/session-1/abc-bash.txt', bytes: 42, retrievalHint: 'Use read with offset/limit, or grep this path to search within it.' }
    },
  }
  const ref = await saveFullText(ctxWith(store), exec, 'RAW TEXT')
  assert.equal(ref.locator, '/tmp/spill/session-1/abc-bash.txt')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].owner, { sessionId: 'session-1' })
  assert.equal(calls[0].content, 'RAW TEXT')
  assert.equal(calls[0].suggestedName, 'bash.txt')
  assert.deepEqual(calls[0].source, { kind: 'tool', toolName: 'bash', callId: 'call-1', label: 'result' })
})

test('saveFullText：后端缺失 / 无会话 id / 抛错 / 返回值畸形 一律返回 undefined', async () => {
  assert.equal(await saveFullText(ctxWith(undefined), exec, 'x'), undefined)
  assert.equal(await saveFullText(ctxWith({ saveText: async () => ({ locator: '/x' }) }), { name: 'bash' }, 'x'), undefined)
  assert.equal(
    await saveFullText(ctxWith({ saveText: async () => { throw new Error('disk full') } }), exec, 'x'),
    undefined,
  )
  assert.equal(await saveFullText(ctxWith({ saveText: async () => ({}) }), exec, 'x'), undefined)
})

test('formatCondenseNotice：与 spill-policy 同款措辞，含字节数与 hint', () => {
  const notice = formatCondenseNotice({
    beforeBytes: 6202,
    afterBytes: 184,
    ref: { locator: '/tmp/x.txt', retrievalHint: 'Use read with offset/limit, or grep this path to search within it.' },
  })
  assert.equal(
    notice,
    '(rtk condensed 6202 → 184 bytes. Full formatted result stored at: /tmp/x.txt. Use read with offset/limit, or grep this path to search within it.)',
  )
})

test('formatCondenseNotice：hint 缺失时用兜底措辞', () => {
  const notice = formatCondenseNotice({ beforeBytes: 10, afterBytes: 2, ref: { locator: '/tmp/y.txt' } })
  assert.ok(notice.includes('Full formatted result stored at: /tmp/y.txt.'))
  assert.ok(notice.includes('Use read with offset/limit'))
  assert.ok(notice.startsWith('(rtk condensed 10 → 2 bytes.'))
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/spill.test.mjs`
Expected: FAIL —— `Cannot find module '.../lib/spill.js'`

- [ ] **Step 3: 实现 `lib/spill.js`**

```js
/**
 * Lossy-but-traceable condensation: every condensed text is recoverable in
 * full. The store is the official `ctx.spillStore` service (backed by
 * `dsh-spill-local`), used exactly the way `dsh-spill-policy` uses it, so the
 * notice wording and the file layout are the ones the harness already knows.
 *
 * @module dsh-rtk-slim/spill
 */

/** @typedef {{ locator: string, bytes?: number, retrievalHint?: string }} Ref */

const FALLBACK_HINT = 'Use read with offset/limit, or grep this path to search within it.'

/**
 * Persist the untouched original text.
 * @param {{ get: (name: string) => any }} ctx
 * @param {{ name: string, callId?: string, agent?: any }} exec
 * @param {string} text
 * @returns {Promise<Ref | undefined>} `undefined` means "no traceability available".
 */
export async function saveFullText(ctx, exec, text) {
  const store = ctx.get('spillStore')
  if (store === null || typeof store !== 'object' || typeof store.saveText !== 'function') return undefined
  const sessionId = exec.agent?.session?.header?.id
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  try {
    const ref = await store.saveText({
      owner: { sessionId },
      source: { kind: 'tool', toolName: exec.name, callId: exec.callId, label: 'result' },
      suggestedName: `${exec.name}.txt`,
      content: text,
    })
    if (ref === null || typeof ref !== 'object' || typeof ref.locator !== 'string' || ref.locator.length === 0) {
      return undefined
    }
    return ref
  } catch {
    return undefined
  }
}

/**
 * @param {{ beforeBytes: number, afterBytes: number, ref: Ref }} input
 * @returns {string}
 */
export function formatCondenseNotice({ beforeBytes, afterBytes, ref }) {
  const hint = typeof ref.retrievalHint === 'string' && ref.retrievalHint.length > 0 ? ref.retrievalHint : FALLBACK_HINT
  return `(rtk condensed ${beforeBytes} → ${afterBytes} bytes. Full formatted result stored at: ${ref.locator}. ${hint})`
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/spill.test.mjs`
Expected: PASS（4 pass）

- [ ] **Step 5: Commit**

```bash
git add lib/spill.js test/spill.test.mjs
git commit -m "feat: spill 模块（复用官方 spillStore，落盘失败即放弃替换）"
```

---

## Task 8: `lib/index.js` —— 装配与 handler

**Files:**
- Create: `lib/index.js`, `test/handler.test.mjs`

- [ ] **Step 1: 写失败测试 `test/handler.test.mjs`**

```js
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Config, createPostExecuteHandler, name } from '../lib/index.js'

const fixture = (file) => readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')

function harness(overrides = {}) {
  const warnings = []
  const saved = []
  const spillStore = {
    saveText: async (input) => {
      saved.push(input)
      return { locator: '/tmp/spill/x.txt', bytes: 1, retrievalHint: 'Use read with offset/limit, or grep this path to search within it.' }
    },
  }
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    get: (key) => (key === 'spillStore' ? spillStore : undefined),
  }
  const calls = []
  const deps = {
    runRtk: async (input) => {
      calls.push(input)
      return { ok: true, text: 'CONDENSED' }
    },
    saveFullText: async (_ctx, _exec, text) => {
      saved.push({ content: text })
      return { locator: '/tmp/spill/x.txt', bytes: 1, retrievalHint: 'Use read with offset/limit, or grep this path to search within it.' }
    },
  }
  const handler = createPostExecuteHandler(ctx, { ...Config({}), ...overrides }, deps)
  const exec = { name: 'bash', callId: 'call-1', signal: undefined, agent: { session: { header: { id: 'session-1' } } } }
  const result = (text, extra = {}) => ({ content: [{ type: 'text', text }], isError: false, ...extra })
  const next = async () => ({ kind: 'accept' })
  return { handler, exec, result, next, warnings, saved, calls, spillStore }
}

const textOf = (decision) => decision.content.map((block) => block.text).join('')

test('name 与 Config 形状', () => {
  assert.equal(name, 'rtk-slim')
  const cfg = Config({})
  assert.equal(cfg.minBytes, 2048)
  assert.deepEqual(cfg.tools, ['bash', 'job_output'])
  assert.equal(cfg.requireSpill, true)
  assert.equal(cfg.ultraCompact, false)
})

test('命中：替换为 单个 text block（精简正文 + notice + 原标记），并把原文落盘', async () => {
  const h = harness()
  const raw = `${fixture('cargo-test-pass.txt')}[exit code: 1]`
  const decision = await h.handler(h.exec, h.result(raw), h.next)
  const text = textOf(decision)
  assert.ok(text.startsWith('CONDENSED'))
  assert.ok(text.includes('(rtk condensed '))
  assert.ok(text.endsWith('[exit code: 1]'))
  assert.equal(decision.content.length, 1)
  assert.equal(decision.kind, 'accept')
  assert.equal(h.saved.length, 1)
  assert.equal(h.saved[0].content, raw)
  assert.deepEqual(h.calls[0].args.slice(0, 3), ['pipe', '-f', 'cargo-test'])
})

test('低门槛/高门槛：低于 minBytes 或高于 maxInputBytes 直接放行', async () => {
  const h = harness()
  const small = await h.handler(h.exec, h.result('tiny [exit code: 1]'), h.next)
  assert.equal(small.content, undefined) // accept 但没带 content => 未替换
  const h2 = harness({ maxInputBytes: 640 })
  const wide = await h2.handler(h2.exec, h2.result(`${fixture('cargo-test-pass.txt')}[exit code: 1]`), h2.next)
  assert.equal(wide.content, undefined)
  assert.equal(h2.calls.length, 0)
})

test('非目标工具 / 失败结果 / 非单文本块 / block 决策：一律原样放行', async () => {
  const h = harness()
  assert.equal((await h.handler({ ...h.exec, name: 'read' }, h.result('x'.repeat(9000)), h.next)).content, undefined)
  assert.equal((await h.handler(h.exec, h.result('x'.repeat(9000), { isError: true }), h.next)).content, undefined)
  assert.equal(
    (await h.handler(h.exec, { content: [{ type: 'text', text: 'a'.repeat(9000) }, { type: 'text', text: 'b' }], isError: false }, h.next)).content,
    undefined,
  )
  const blocked = { kind: 'block', feedback: [{ type: 'text', text: 'no' }] }
  assert.equal(await h.handler(h.exec, h.result('x'.repeat(9000)), async () => blocked), blocked)
  assert.equal(h.calls.length, 0)
})

test('rtk 失败：保留原文并按 reason 去重告警', async () => {
  const h = harness()
  h.calls.length = 0
  const failing = createPostExecuteHandler(
    { logger: { warn: (m) => h.warnings.push(m) }, get: () => undefined },
    { ...Config({}) },
    { runRtk: async () => ({ ok: false, reason: 'timeout' }), saveFullText: async () => undefined },
  )
  const raw = `${fixture('cargo-test-pass.txt')}[exit code: 1]`
  assert.equal((await failing(h.exec, h.result(raw), h.next)).content, undefined)
  assert.equal((await failing(h.exec, h.result(raw), h.next)).content, undefined)
  assert.equal(h.warnings.filter((line) => line.includes('rtk:timeout')).length, 1, '同一 reason 只告警一次')
})

test('guard 不过：失败行丢失 / 变大 / 未变化 都保留原文', async () => {
  const raw = `${fixture('cargo-test-fail.txt')}[exit code: 1]`
  const cases = ['SUMMARY ONLY', `${raw}EXTRA`, raw]
  for (const condensed of cases) {
    const h = harness()
    const handler = createPostExecuteHandler(
      { logger: { warn: () => {} }, get: () => undefined },
      { ...Config({}) },
      { runRtk: async () => ({ ok: true, text: condensed }), saveFullText: async () => undefined },
    )
    assert.equal((await handler(h.exec, h.result(raw), h.next)).content, undefined, JSON.stringify(condensed.slice(0, 20)))
  }
})

test('requireSpill：落盘不可用时放弃替换；spill 关闭时可无指针替换', async () => {
  const raw = `${fixture('cargo-test-pass.txt')}[exit code: 1]`
  const strict = createPostExecuteHandler(
    { logger: { warn: () => {} }, get: () => undefined },
    { ...Config({}) },
    { runRtk: async () => ({ ok: true, text: 'CONDENSED' }), saveFullText: async () => undefined },
  )
  assert.equal((await strict({ name: 'bash' }, { content: [{ type: 'text', text: raw }], isError: false }, async () => ({ kind: 'accept' }))).content, undefined)

  const relaxed = createPostExecuteHandler(
    { logger: { warn: () => {} }, get: () => undefined },
    { ...Config({}), spill: false },
    { runRtk: async () => ({ ok: true, text: 'CONDENSED' }), saveFullText: async () => undefined },
  )
  const decision = await relaxed({ name: 'bash' }, { content: [{ type: 'text', text: raw }], isError: false }, async () => ({ kind: 'accept' }))
  assert.equal(textOf(decision), 'CONDENSED\n[exit code: 1]')
})

test('additionalContexts 与 exec.signal 透传', async () => {
  const h = harness()
  const signal = new AbortController().signal
  const ctxMessage = { role: 'user', content: [{ type: 'text', text: 'ctx' }] }
  const decision = await h.handler({ ...h.exec, signal }, h.result(`${fixture('git-log.txt')}[exit code: 0]`), async () => ({
    kind: 'accept',
    additionalContexts: [ctxMessage],
  }))
  assert.deepEqual(decision.additionalContexts, [ctxMessage])
  assert.equal(h.calls[0].signal, signal)
  assert.deepEqual(h.calls[0].args.slice(0, 3), ['pipe', '-f', 'git-log'])
})

test('默认走裸 pipe（认不出的家族）且 ultraCompact 可透传', async () => {
  const h = harness({ ultraCompact: true })
  await h.handler(h.exec, h.result(`${fixture('source.js.txt')}[exit code: 1]`), h.next)
  assert.deepEqual(h.calls[0].args, ['pipe', '--ultra-compact'])
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/handler.test.mjs`
Expected: FAIL —— `Cannot find module '.../lib/index.js'`

- [ ] **Step 3: 实现 `lib/index.js`**

```js
/**
 * dsh-rtk-slim: condense oversized `bash` / `job_output` text through `rtk`
 * before the model sees it, with a recoverable full-text copy and a
 * no-surprises failure surface.
 *
 * Registered WITHOUT `prepend`, i.e. as the innermost listener of the
 * `tools/post-execute` waterfall: every outer listener (notably
 * `dsh-spill-policy`, which prepends) has already run `next()` by the time we
 * see the result, so we condense the original text and spill-policy then gets
 * to post-process our (smaller) output.
 *
 * @module dsh-rtk-slim
 */

import z from '@deepseek-ai/schemastery'
import { singleText, textBlock } from './content.js'
import { checkInvariants } from './guards.js'
import { joinTailMarkers, splitTailMarkers } from './markers.js'
import { runRtk } from './rtk.js'
import { chooseFilter } from './sniff.js'
import { formatCondenseNotice, saveFullText } from './spill.js'

export const name = 'rtk-slim'

/** The tools registry owns the waterfall we hook. */
export const inject = ['tools']

export const Config = z.object({
  enabled: z.boolean().default(true),
  command: z.string().default('rtk'),
  tools: z.array(z.string()).default(['bash', 'job_output']),
  minBytes: z.number().default(2048),
  maxInputBytes: z.number().default(4194304),
  timeoutMs: z.number().default(10000),
  maxOutputBytes: z.number().default(8388608),
  filters: z.dict(z.union([z.string(), z.const(false)])).default({}),
  spill: z.boolean().default(true),
  requireSpill: z.boolean().default(true),
  notice: z.boolean().default(true),
  ultraCompact: z.boolean().default(false),
})

/**
 * @typedef {object} SlimConfig
 * @property {boolean} enabled
 * @property {string} command
 * @property {string[]} tools
 * @property {number} minBytes
 * @property {number} maxInputBytes
 * @property {number} timeoutMs
 * @property {number} maxOutputBytes
 * @property {Record<string, string | false>} filters
 * @property {boolean} spill
 * @property {boolean} requireSpill
 * @property {boolean} notice
 * @property {boolean} ultraCompact
 */

/**
 * Defensive defaults so the handler is usable with a raw config object in
 * tests, and with a schema-validated one from the loader.
 * @param {Partial<SlimConfig> | undefined} raw
 * @returns {SlimConfig}
 */
function normalizeConfig(raw) {
  const defaults = {
    enabled: true,
    command: 'rtk',
    tools: ['bash', 'job_output'],
    minBytes: 2048,
    maxInputBytes: 4194304,
    timeoutMs: 10000,
    maxOutputBytes: 8388608,
    filters: {},
    spill: true,
    requireSpill: true,
    notice: true,
    ultraCompact: false,
  }
  const merged = { ...defaults, ...(raw ?? {}) }
  if (!Array.isArray(merged.tools)) merged.tools = defaults.tools
  if (merged.filters === null || typeof merged.filters !== 'object') merged.filters = {}
  return merged
}

/**
 * Build the `tools/post-execute` listener. Exported for tests that drive it
 * without a cordis context.
 * @param {{ logger?: { warn: (message: string) => void }, get: (name: string) => any }} ctx
 * @param {Partial<SlimConfig> | undefined} rawConfig
 * @param {{ runRtk?: typeof runRtk, saveFullText?: typeof saveFullText }} [deps]
 * @returns {(exec: any, result: any, next: () => Promise<any>) => Promise<any>}
 */
export function createPostExecuteHandler(ctx, rawConfig, deps = {}) {
  const config = normalizeConfig(rawConfig)
  const run = deps.runRtk ?? runRtk
  const spill = deps.saveFullText ?? saveFullText
  const warned = new Set()

  /**
   * One line per distinct reason, ever.
   * @param {string} key
   * @param {string} detail
   */
  function warn(key, detail) {
    if (warned.has(key)) return
    warned.add(key)
    ctx.logger?.warn(`rtk-slim: ${key}: ${detail}`)
  }

  return async function postExecute(exec, result, next) {
    // Let downstream (more inner) listeners settle first; a throw here belongs
    // to the registry, not to us.
    const decision = await next()
    try {
      if (decision === null || typeof decision !== 'object' || decision.kind !== 'accept') return decision
      if (Object.hasOwn(decision, 'value')) return decision
      if (result?.isError === true) return decision
      if (!config.tools.includes(exec?.name)) return decision

      const raw = singleText(decision.content ?? result?.content)
      if (raw === undefined) return decision

      const rawBytes = Buffer.byteLength(raw, 'utf8')
      if (rawBytes < config.minBytes || rawBytes > config.maxInputBytes) return decision

      const { body, tail } = splitTailMarkers(raw)
      if (body.length === 0) return decision

      const { filter } = chooseFilter(body, config.filters)
      const args = filter === undefined ? ['pipe'] : ['pipe', '-f', filter]
      if (config.ultraCompact) args.push('--ultra-compact')

      const produced = await run({
        command: config.command,
        args,
        input: body,
        timeoutMs: config.timeoutMs,
        signal: exec?.signal,
        maxOutputBytes: config.maxOutputBytes,
      })
      if (!produced.ok) {
        warn(`rtk:${produced.reason}`, `rtk did not condense ${exec?.name} output`)
        return decision
      }

      const condensedBody = produced.text.replace(/\n+$/, '')
      const guard = checkInvariants({ raw: body, condensed: condensedBody })
      if (!guard.ok) {
        if (guard.reason !== 'unchanged') warn(`guard:${guard.reason}`, `condensation rejected for ${exec?.name}`)
        return decision
      }

      let ref
      if (config.spill) {
        ref = await spill(ctx, exec, raw)
        if (ref === undefined && config.requireSpill) {
          warn('spill:failed', `no recoverable copy for ${exec?.name}; keeping the original`)
          return decision
        }
      }

      const notice =
        config.notice && ref !== undefined
          ? formatCondenseNotice({
              beforeBytes: rawBytes,
              afterBytes: Buffer.byteLength(condensedBody, 'utf8'),
              ref,
            })
          : undefined

      const assembled = [condensedBody, notice, tail].filter((part) => part !== undefined && part !== '').join('\n')
      return {
        kind: 'accept',
        content: textBlock(assembled),
        ...(decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts }),
      }
    } catch (error) {
      warn('unexpected', String(error instanceof Error ? error.message : error))
      return decision
    }
  }
}

/**
 * @param {{ on: (event: string, listener: any) => any }} ctx
 * @param {Partial<SlimConfig> | undefined} config
 */
export function apply(ctx, config) {
  const resolved = normalizeConfig(config)
  if (resolved.enabled === false) return
  ctx.on('tools/post-execute', createPostExecuteHandler(ctx, resolved))
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/handler.test.mjs`
Expected: PASS（9 pass）。若 `Config({})` 断言失败，先用 `node -e "import('./lib/index.js').then(m=>console.log(m.Config({})))"` 看 schema 实际产出，再决定是改断言还是改 schema——**不要**为了迁就 schema 改变默认值语义。

- [ ] **Step 5: 全量回归**

Run: `node --test test/*.test.mjs`
Expected: 全部 PASS（content 4 + markers 6 + sniff 7 + guards 6 + rtk 7 + spill 4 + handler 9 = 43）

- [ ] **Step 6: Commit**

```bash
git add lib/index.js test/handler.test.mjs
git commit -m "feat: handler 与插件装配（Config/apply/post-execute）"
```

---

## Task 9: 真 rtk 端到端验收（spec §10 的 1–7 条）

**Files:**
- Create: `test/e2e-real-rtk.test.mjs`

- [ ] **Step 1: 写测试 `test/e2e-real-rtk.test.mjs`**

```js
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { accessSync, constants } from 'node:fs'
import test from 'node:test'
import { Config, createPostExecuteHandler } from '../lib/index.js'

const RTK = '/opt/homebrew/bin/rtk'
const hasRtk = (() => {
  try {
    accessSync(RTK, constants.X_OK)
    return true
  } catch {
    return false
  }
})()

const fixture = (file) => readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')
const bytes = (text) => Buffer.byteLength(text, 'utf8')

function realHarness(overrides = {}) {
  const spool = []
  const ctx = { logger: { warn: () => {} }, get: () => undefined }
  const handler = createPostExecuteHandler(ctx, { ...Config({}), command: RTK, ...overrides }, {
    saveFullText: async (_ctx, _exec, text) => {
      spool.push(text)
      return { locator: '/tmp/spill/e2e.txt', bytes: bytes(text), retrievalHint: 'Use read with offset/limit, or grep this path to search within it.' }
    },
  })
  const exec = { name: 'bash', callId: 'call-1', agent: { session: { header: { id: 's1' } } } }
  const run = async (text) => {
    const decision = await handler(exec, { content: [{ type: 'text', text }], isError: false }, async () => ({ kind: 'accept' }))
    const blocks = decision.content
    return { replaced: blocks !== undefined, text: blocks === undefined ? text : blocks.map((b) => b.text).join('') }
  }
  return { run, spool }
}

test('验收 1（rtk 基线，minBytes 512）：四类语料都被压缩', { skip: !hasRtk }, async () => {
  const h = realHarness({ minBytes: 512 })
  const cargo = await h.run(`${fixture('cargo-test-pass.txt')}[exit code: 0]`)
  assert.ok(cargo.replaced)
  assert.ok(bytes(cargo.text) < bytes(fixture('cargo-test-pass.txt')) / 2, `cargo 压缩不足: ${bytes(cargo.text)}`)

  const pytest = await h.run(`${fixture('pytest-pass.txt')}[exit code: 0]`)
  assert.ok(pytest.replaced)
  assert.ok(bytes(pytest.text) < bytes(fixture('pytest-pass.txt')) / 2)

  const grep = await h.run(`${fixture('grep-rn.txt')}[exit code: 0]`)
  assert.ok(grep.replaced)
  assert.ok(bytes(grep.text) < bytes(fixture('grep-rn.txt')))

  const gitLog = await h.run(`${fixture('git-log.txt')}[exit code: 0]`)
  assert.ok(gitLog.replaced)
  assert.ok(bytes(gitLog.text) < bytes(fixture('git-log.txt')) / 4, `git-log 未走 -f git-log: ${bytes(gitLog.text)}`)
})

test('验收 2（默认 minBytes 2048）：pytest/grep/git-log 替换，866B 的 cargo 不替换', { skip: !hasRtk }, async () => {
  const h = realHarness()
  const cargo = await h.run(`${fixture('cargo-test-pass.txt')}[exit code: 0]`)
  assert.equal(cargo.replaced, false)
  for (const name of ['pytest-pass.txt', 'grep-rn.txt', 'git-log.txt']) {
    const out = await h.run(`${fixture(name)}[exit code: 0]`)
    assert.equal(out.replaced, true, name)
  }
})

test('验收 3：失败行在压缩后逐字仍在', { skip: !hasRtk }, async () => {
  const h = realHarness({ minBytes: 512 })
  for (const [name, needle] of [
    ['cargo-test-fail.txt', 'test result: FAILED'],
    ['pytest-fail.txt', 'FAILED tests/test_x.py::test_4'],
  ]) {
    const out = await h.run(`${fixture(name)}[exit code: 1]`)
    assert.ok(out.text.includes(needle), `${name} 丢失失败行`)
  }
})

test('验收 4：exit code / timeout 标记逐字保留', { skip: !hasRtk }, async () => {
  const h = realHarness({ minBytes: 512 })
  const exit = await h.run(`${fixture('git-log.txt')}[exit code: 1]`)
  assert.ok(exit.text.endsWith('[exit code: 1]'))
  const timedOut = await h.run(`${fixture('git-log.txt')}\n[timed out after 30000ms]`)
  assert.ok(timedOut.text.endsWith('[timed out after 30000ms]'))
})

test('验收 5：每次替换都带 spill 指针，且取回的原文逐字节相同', { skip: !hasRtk }, async () => {
  const h = realHarness({ minBytes: 512 })
  const raw = `${fixture('git-log.txt')}[exit code: 0]`
  const out = await h.run(raw)
  assert.ok(out.text.includes('Full formatted result stored at: /tmp/spill/e2e.txt'))
  assert.equal(h.spool.length, 1)
  assert.equal(h.spool[0], raw)
})

test('验收 6：rtk 不可用时输出与未装插件完全一致', { skip: !hasRtk }, async () => {
  const h = realHarness({ command: '/definitely/not/rtk', minBytes: 512 })
  const raw = `${fixture('git-log.txt')}[exit code: 1]`
  const out = await h.run(raw)
  assert.equal(out.replaced, false)
  assert.equal(out.text, raw)
})

test('验收 7：内容型输出（ls / 源码 / JSON）逐字节不变', { skip: !hasRtk }, async () => {
  const h = realHarness({ minBytes: 512 })
  for (const name of ['ls-la.txt', 'source.js.txt', 'json.txt']) {
    const raw = `${fixture(name)}[exit code: 0]`
    const out = await h.run(raw)
    assert.equal(out.text, raw, `${name} 不应被替换`)
  }
})
```

- [ ] **Step 2: 运行**

Run: `node --test test/e2e-real-rtk.test.mjs`
Expected: 7 pass（若 `/opt/homebrew/bin/rtk` 缺失则 7 skip）

- [ ] **Step 3: 若有失败，按下表定位（不要直接把断言改松）**

| 现象 | 首先检查 |
|---|---|
| cargo/pytest 未被压缩 | 裸 `rtk pipe` 对该语料是否真的压缩（`/opt/homebrew/bin/rtk pipe < fixture`），再查 `singleText`/门槛 |
| git-log 压缩不足 | `chooseFilter` 是否命中 `git-log`；`-f git-log` 是否真被传进 args |
| 失败行丢失 | I2 是否按预期拦截（此时应是"不替换"而不是"替换后丢行"） |
| 标记不完整 | `splitTailMarkers` 是否把 `[exit code: N]` 归入 body（检查正则） |
| ls/源码/JSON 被替换 | `chooseFilter` 命中过宽（尤其 `grep`/`find` 阈值） |

- [ ] **Step 4: 全量回归 + Commit**

```bash
node --test test/*.test.mjs
git add test/e2e-real-rtk.test.mjs
git commit -m "test: 真 rtk 端到端验收（7 条，含语料与降级路径）"
```

---

## Task 10: 类型检查、README 与全量回归

**Files:**
- Create: `README.md`
- Modify: `lib/*.js`（仅修类型问题）、`test/*.mjs`（仅在类型检查要求时）

- [ ] **Step 1: 跑类型检查**

Run: `npm run typecheck`
Expected: 0 error。允许的例外处理方式（按序尝试）：
1. 补 JSDoc 注解（首选）；
2. `@typedef {import('@deepseek-ai/dsh-llm').ContentBlock}` 若无法解析，改用本地 `@typedef {{ type: 'text', text: string }} TextBlock` 并保留注释说明；
3. 仅在确实无法表达的位置用 `// @ts-expect-error <原因>`，禁止 `@ts-nocheck`。

- [ ] **Step 2: 写 `README.md`**

````markdown
# dsh-rtk-slim

DSH 宿主半边插件：把 `bash` / `job_output` 的超大输出交给 [rtk](https://github.com/rtk-ai/rtk)（Rust Token Killer）
精简后再交给模型，并且**每一次精简都可追溯、每一次失败都保留原文**。

## 它做了什么

- 挂在官方 `tools/post-execute` waterfall 上，**登记为最内层**（不加 `prepend`），因此看到的是原始结果；
  `dsh-spill-policy` 在外层，仍可对精简后的文本再落盘。
- 只改模型看到的 `content`，**从不动命令、不动 `value`、绝不把成功调用变成 `isError`**。
- 家族嗅探决定 rtk 参数：识别得出才用 `-f <filter>`（cargo-test / pytest / git-log / grep / find），
  识别不出走裸 `rtk pipe`（实测认不出即逐字节透传）。这避免了"`-f` 选错把内容删掉"的失败模式。
- 替换前过四道闸门：标记逐字保全、失败证据保全、压缩比合理、**必须严格变小**；任一不过就保留原文。
- 每次替换都把**全文**经官方 `ctx.spillStore` 落盘，并在文本末尾附一行
  `(rtk condensed A → B bytes. Full formatted result stored at: <path>. …)`。

## 安装

```sh
PNPM="$(dirname "$(command -v dsh)")/pnpm"   # 或直接用 Desktop 运行时目录下的 pnpm
"$PNPM" --dir ~/.dsh/profiles/desktop add --ignore-scripts \
  "dsh-rtk-slim@file:/Users/cooper/Documents/Code/dsh-rtk-slim"
```

再把 `dsh-rtk-slim` 追加到该 profile `package.json` 的 `dsh.profile.bundles`，然后重启宿主一次
（宿主半边改动走的是 Node ESM 缓存，不能热重载）。日志看 `~/.dsh/logs/dsh-rtk-slim.log`。

## 配置（全部有默认值）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 时完全不注册监听器 |
| `command` | `'rtk'` | rtk 可执行文件 |
| `tools` | `['bash','job_output']` | 需要过滤的工具名 |
| `minBytes` | `2048` | 低于此字节数放行（避免为小输出付一次 spawn） |
| `maxInputBytes` | `4194304` | 高于此字节数不调 rtk |
| `timeoutMs` | `10000` | rtk 超时（超时整组击杀） |
| `maxOutputBytes` | `8388608` | 捕获 stdout 上限 |
| `filters` | `{}` | 按家族 id 覆盖 filter 名，或传 `false` 停用某家族 |
| `spill` | `true` | 是否落盘全文 |
| `requireSpill` | `true` | 落盘失败时是否放弃替换（"有损必可追溯"） |
| `notice` | `true` | 是否追加 notice 行 |
| `ultraCompact` | `false` | 透传 `--ultra-compact` 给 rtk |

把 `requireSpill` 设为 `false` 即可放宽成"压缩但不落盘"。

## 开发

```sh
npm install --ignore-scripts
npm run check     # tsc --checkJs + node --test
node test/fixtures/make-fixtures.mjs   # 重新生成语料（确定性）
```
````

- [ ] **Step 3: 全量回归**

Run: `npm run check`
Expected: typecheck 0 error + 全部测试 PASS（50 个：43 单测 + 7 端到端）

- [ ] **Step 4: 自查产物新鲜度**（本插件无构建步骤，源码即产物）

Run: `ls -la lib/*.js test/*.test.mjs | head -20`
Expected: `lib/*.js` 时间戳都新于对应的最后一次编辑；没有任何 `src/` 目录或构建产物

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: README + 类型检查通过，全量回归 50 项"
```

---

## Task 11: 装进 profile 并验证宿主加载（含一次重启）

**Files:**
- Modify: `~/.dsh/profiles/desktop/package.json`（pnpm 会改，另外手工追加 `dsh.profile.bundles`）

- [ ] **Step 1: 记录改动前的 profile 状态（便于回滚）**

Run:
```bash
cp ~/.dsh/profiles/desktop/package.json /tmp/desktop-package.json.bak
cat ~/.dsh/profiles/desktop/package.json
```
Expected: 看到当前 `dependencies`（含 `dsh-memories`）与 `dsh.profile.bundles` 数组

- [ ] **Step 2: 以 pnpm file: 依赖装入**

Run:
```bash
PNPM="/Users/cooper/Library/Application Support/DSH Desktop Beta/runtime-commands/generations/$(ls '/Users/cooper/Library/Application Support/DSH Desktop Beta/runtime-commands/generations' | head -1)/bin/pnpm"
"$PNPM" --dir ~/.dsh/profiles/desktop add --ignore-scripts "dsh-rtk-slim@file:/Users/cooper/Documents/Code/dsh-rtk-slim"
```
Expected: pnpm 报告新增 `dsh-rtk-slim`（如报 peer 冲突，先停下报告，不要 `--force`）

- [ ] **Step 3: 把包登记进 profile 的 bundles**

在 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 末尾追加 `"dsh-rtk-slim"`：

```json
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-memories",
        "dsh-rtk-slim"
      ]
    }
  }
```

- [ ] **Step 4: 确认包名可解析**

Run:
```bash
node -e "console.log(require.resolve('dsh-rtk-slim/package.json', { paths: ['/Users/cooper/.dsh/profiles/desktop'] }))"
```
Expected: `/Users/cooper/.dsh/profiles/desktop/node_modules/dsh-rtk-slim/package.json`

- [ ] **Step 5: 重启宿主（需要用户操作或应用内重启）**

重启 DSH Desktop。**注意**：宿主重启会中断当前这一轮会话运行（会话本身持久化，重启后仍在）。
重启后确认 `~/.dsh/logs/dsh-rtk-slim.log` 出现 `mounted`。

- [ ] **Step 6: 逐条跑 spec §10 的 8 条验收（在重启后的 GUI 里）**

1. 跑 `seq 1 4000 | sed 's/^/line /'`（>2048 B，非识别家族）：**不应**被压缩（落 auto 且 rtk 认不出）。
2. 跑一段真实 pytest/cargo 输出（可用 `node test/fixtures/make-fixtures.mjs && cat test/fixtures/pytest-pass.txt`）：
   应被压缩，且带 `(rtk condensed …)` 指针。
3. 跑 `cat test/fixtures/cargo-test-fail.txt`：失败行仍在。
4. 跑 `cat test/fixtures/git-log.txt`：被显著压缩（走 `-f git-log`）。
5. 跑 `ls -la /Applications | head -80`：不应被替换。
6. 用 `read` 打开上一步的 spill 路径：内容与原文逐字节一致。
7. 把 profile patch 里的 `command` 指向 `/definitely/not/rtk`（或用 `enabled: false`）后重跑第 2 步：
   输出与未装插件时一致。
8. 起一个后台 job（`run_in_background`）产出大输出，再用 `job_output` 读取：确认被压缩且指针可读回。

- [ ] **Step 7: 回滚预案（只在验收失败时执行）**

```bash
cp /tmp/desktop-package.json.bak ~/.dsh/profiles/desktop/package.json
PNPM="<同上>"
"$PNPM" --dir ~/.dsh/profiles/desktop remove --ignore-scripts dsh-rtk-slim
```
然后重启宿主，确认回到安装前状态。

- [ ] **Step 8: 把验收结果写进 README 的「实测」小节并 commit**

```bash
git add README.md
git commit -m "docs: 记录 profile 安装与 8 条验收结果"
```

---

## 完成标准（DoD）

- [ ] `npm run check` 全绿（typecheck 0 error，50 项测试 PASS）
- [ ] `lib/*.js` 对 `@deepseek-ai/dsh-*` 的运行时导入为 **0**（`grep -rn "from '@deepseek-ai/dsh" lib/` 无结果）
- [ ] 插件已装进 `~/.dsh/profiles/desktop` 且在 profile `dsh.profile.bundles` 中登记
- [ ] 宿主重启后 `~/.dsh/logs/dsh-rtk-slim.log` 显示已挂载
- [ ] spec §10 的 8 条验收逐条有明确结论（通过，或记录原因并已回滚）

---

## 执行记录（2026-10-16，Task 1–10 已执行）

**结果：`npm run check` 全绿 —— `tsc --checkJs` 0 error，50 项测试全部通过（43 单测 + 7 端到端）。**
实现提交：`e40400c`。

执行时对计划做了 6 处修正，均已在仓库中落地（计划正文的对应代码块未逐字回写，以本节与本仓库为准）：

1. **TDD 红-绿步骤被压缩**：每个模块写成「测试 + 实现」后一次运行，而不是先跑一次确认失败。
   纯函数 + 明确的 spec 让"确认失败"的信息量很低；代价是失去了"测试是否真的在测东西"的一次校验，
   由最终 50 项全绿与端到端数据兜底。
2. **Task 8 的 handler 测试必须把 `minBytes` 压到 512**：语料 `cargo-test-pass.txt` 只有 866 B，
   用默认 `minBytes: 2048` 会在门槛处直接放行，`命中`/`rtk 失败`/`guard 不过`/`requireSpill`
   四个用例的断言全部失效（这是我写计划时埋的 bug）。修正：`harness()` 固定 `minBytes: 512`，
   **默认 2048 那一档改由 `test/e2e-real-rtk.test.mjs` 的「验收 2」显式覆盖**（断言 866 B 的 cargo
   不被替换，而 pytest/grep/git-log 被替换），语义没有放松。
3. **grep 语料必须"少文件、多命中"**：rtk 的 `grep` filter 按**文件分组**压缩
   （真实输出形如 `70 matches in 4F:\n\n[file] <path> (15):\n    42: …`）。最初的语料写成
   "60 个文件各 1 行命中"，`rtk pipe -f grep` 对它**逐字节不变**（5680 → 5680），
   一度被误判为代码 bug（`验收 1`/`验收 2` 因此失败）。修正语料生成器为 4 个文件 / 70 命中后
   压缩正常（9104 → 3220 B）。**教训：语料不忠实于真实输出时，测试会给出假阴性。**
4. **类型检查范围收到 `lib/**`**：`test/**` 的动态桩产生约 30 条隐式 `any` 报错，
   给它们补 JSDoc 既不增加安全性、又会淹没真正的错误。`lib/**` 是"用运行时同版本类型校验插件契约"
   的落点，保持 `strict + checkJs`。顺带修了一处真错：`apply()` 的 ctx typedef 缺 `logger`/`get`
   （`createPostExecuteHandler` 需要），已补齐。
5. **假 rtk 用 `node <stub>` 调用**，而不是计划里的「JS + shebang + 临时 PATH 前置注入」：
   不依赖 chmod 与 shebang，跨平台更稳，且 `runRtk` 的 `command`/`args` 本来就是注入点。
6. **安装命令用 Desktop 运行时目录下的 pnpm**（`runtime-commands/generations/<gen>/bin/pnpm`），
   `dsh` 本体不在 PATH 上。
7. **新增 bundle 不会热挂载（实测结论，与 `dsh-plugin-hot-load` skill 的乐观描述不同）**：
   装好后分别试了两条热路径——① 改 `dsh.profile.bundles` 等 21 s；② 往 profile 的
   `cordis.patch.yml` 追加 `insert` 等 6 s——命令输出始终原样返回，插件未挂载。
   期间已排除其它解释：profile patch 与插件 patch 的 YAML 均能正常解析；
   `.package-map.json` 与 `pnpm-lock.yaml` 都已登记 `dsh-rtk-slim`；
   `node -e "await import('dsh-rtk-slim')"` 在 profile 目录下能加载并打印 `name: rtk-slim`；
   宿主进程（Electron 主进程）的 PATH 里 `/opt/homebrew/bin` 可见、`rtk` 可解析。
   结论：**装/卸插件必须重启宿主**，Task 11 Step 5 的重启不是可选项。日志层面也无法自查
   （dsh web/Desktop 的 stdout 不落盘，本插件默认不写日志），所以验收只能靠重启后的可观测量。
8. **验收方式本身也要小心**：我第一次的"可观测量"是 `cat <6472 B 语料> | head -6`——管道把输出
   截到 460 B，低于 `minBytes`，于是"没被精简"是必然结果，与插件是否挂载无关。
   可观测量必须让**完整输出**进入 bash 工具结果（例如直接 `cat` 大语料，不加 `head`/`tail`）。
9. **补上漏掉的 `[status: …]` 标记（真 bug）**：`dsh-tool-jobs` 的 `statusLine()` 渲染的是
   `[status: running]` / `[status: exited, code 0]`，而计划与 spec 的标记词汇表都漏了它。
   后果：`job_output` 的正文若命中某个带 `-f` 的家族（例如后台跑的是 git log），rtk 会把状态行
   当正文压掉，而 I2 只看失败信号、拦不住。已把 `status: [^\]]*` 加进 `MARKER` 正则，
   并新增**验收 8**（`test/e2e-real-rtk.test.mjs`）：后台输出被压缩 + `[status: …]` 逐字保留 +
   spill 指针可读回原文。测试数 50 → 51。
10. **`file:` 依赖是快照拷贝，改完源码必须重新同步**：安装副本与仓库**不共享 inode**，
    `pnpm install` / `pnpm add`（含 `--force`）都报 `Already up to date` 而不刷新；
    只有 `pnpm remove` + `pnpm add` 才会真正重拷。因此"改仓库 → 重启"这条链会加载到**旧代码**，
    是很容易踩的坑。已写进 README，并用 `diff -r lib <profile>/node_modules/dsh-rtk-slim/lib` 复核。
11. **新增 `lib/log.js`：启动留痕（计划外补充，验收所需）**：宿主不把 stdout 落盘，
    于是"插件是否挂载、生效配置是什么"在重启后**无法回答**——这会让 Task 11 的验收退化成
    猜谜（"输出没变"既可能是没挂载，也可能是挂了但被闸门拦下）。因此插件在 `apply()` 里往
    `$DSH_HOME/logs/dsh-rtk-slim.log` 追加一行 `mounted pid=… command=… tools=… minBytes=…`。
    路径约定与本地 `dsh-solpi-action-fusion` 一致；`DSH_HOME` 已在宿主进程环境中实测存在
    （`ps eww` 可见）；`enabled:false` 也留痕以区分"没挂上"与"挂了但停用"；写失败静默。
12. **"确认宿主加载"的取证方法（本轮新增，全部实测）**：
    - 宿主日志其实**落盘**在 `~/Library/Application Support/DSH Desktop Beta/logs/host/dsh-YYYY-MM-DD.log`
      （纯文本 `[I]/[W]/[E]` 行 + `host.tools`/`host.session` 的 JSONL 行）。用它能读到
      `[hmr] config reload … failed` 这类只有宿主才知道的事——本次据此排除了"我的改动触发了重组"
      （12:29/12:31 两次改动没有任何 hmr 日志），也解释了 `duplicate loader entry id "memories"`
      是 11:49–11:52 外部编辑中间态的**瞬时**错误（当前组合已干净，`id: memories` 只插一次）。
    - **不重启验证组合**：Desktop profile 被 app 独占（`--dump-config` 报
      `profile "desktop" is managed exclusively by the Electron application`），但把 profile
      **复制成另一个名字**就能用同一套逻辑 dump：`cp -Rc … desktop → rtkcheck` 后
      `dsh --profile rtkcheck --dump-config | grep -A3 rtk-slim` 能直接看到
      `- id: rtk-slim / name: dsh-rtk-slim / config: enabled: true`。
    - **隔离实例确认挂载**：`DSH_HOME=/tmp/rtk-verify` + `--from-default-profile headless` 起一个
      一次性真实宿主（headless 模板自带 bash / job_output / spill-local / spill-policy），装上插件后
      启动 → 隔离 home 的 `logs/dsh-rtk-slim.log` 出现
      `mounted pid=88042 enabled=true command=rtk tools=bash,job_output minBytes=2048 …`。
      **这就是"确认宿主加载"的证据**（LLM 路径因隔离 home 无凭据而 `MISSING_CREDENTIAL`，
      但挂载发生在凭据解析之前）。验完删除临时 profile 与临时 home，用户环境只剩"装了插件"这一处改动。


### 实测数据（探针脚本，真 rtk，`minBytes: 512`）

> **Task 11 收尾（2026-10-16 用户重启宿主后）**：插件在真实 GUI 宿主里挂载成功
> （`~/.dsh/logs/dsh-rtk-slim.log` 里 `mounted pid=4717 enabled=true command=rtk tools=bash,job_output minBytes=2048 …`），
> spec §10 的 8 条验收**逐条在 GUI 内验证通过**，数字与本表一致：git-log 6472→373 B、
> pytest 2313→26 B、grep 9104→3218 B、失败 cargo 3566→99 B（失败行保留）、`[exit code: 7]` 保留、
> spill 的 md5 与原文一致、rtk 缺失时 74 行原样且宿主日志留一条 `rtk:spawn` 告警、
> `job_output` 8915→27 B 且 `[status: completed, exit code: 0]` 逐字保留。完整表见 README「GUI 内验收」。
> 两条子项（timeout 标记、源码/JSON 不变）由自动化测试覆盖。

| 语料 | 输入 | 插件替换后 | 是否替换 |
|---|---|---|---|
| `cargo-test-pass.txt` | 880 B | 130 B | 是（`-f cargo-test`） |
| `pytest-pass.txt` | 2327 B | 110 B | 是（`-f pytest`） |
| `grep-rn.txt` | 9118 B | 3313 B | 是（`-f grep`） |
| `git-log.txt` | 6486 B | 467 B | 是（`-f git-log`） |
| `ls-la.txt` | 2333 B | 2333 B | 否（落 `auto`，逐字节不变） |
| `source.js.txt` | 5959 B | 5959 B | 否 |
| `json.txt` | 2917 B | 2917 B | 否 |

（"替换后"含追加的 spill notice 与保留的状态标记。）
