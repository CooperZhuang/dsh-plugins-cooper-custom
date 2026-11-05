/**
 * 把浏览器半边编译产物拷成随包发布的 `lib/client.js`。
 *
 * `client/index.ts` 是一个**没有 import/export 的脚本**（由 DSH Web 外壳当经典脚本
 * 加载，文件末尾自己调用 `window.__ModuleLoader__.load(...)`），所以
 * `tsc -p tsconfig.client.json` 发射出的 `.client-build/index.js` 就是最终形态——
 * 本脚本只把它原样拷到 `lib/client.js`，**不再包一层 `load()`**（与 folder-path /
 * open-in-dsh 那些"源码只给 factory、由脚本包壳"的包不同）。
 *
 * 用 Node ≥24 直接执行 `.mts`（原生类型剥离），不引入 tsx/ts-node。
 *
 * @module dsh-session-ops/scripts/build-client
 */

import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, '.client-build', 'index.js')
const target = join(root, 'lib', 'client.js')

mkdirSync(dirname(target), { recursive: true })
copyFileSync(source, target)
console.log(`build-client: ${source} -> ${target} (${statSync(target).size} bytes)`)
