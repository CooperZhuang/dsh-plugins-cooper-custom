/**
 * 浏览器半边运行时环境的声明。
 *
 * `client/index.ts` 由 DSH Web 外壳当**经典脚本**直接加载（没有打包器、没有
 * `import`/`export`），外壳先注入 `window.__ModuleLoader__`，脚本再调用
 * `load({ id, factory })` 把自己注册成一个客户端插件。DOM 类型来自 tsconfig 的
 * `lib: ["DOM", "DOM.Iterable"]`，这里只补外壳私有的那一个全局。
 *
 * 本文件是脚本型 `.d.ts`（没有 `import`/`export`），所以下面声明自动是全局的。
 */

/** 客户端插件注册项：`factory(require)` 返回插件的 `{ inject, apply }`。 */
interface ModuleLoaderDefinition {
  /** 插件 id（本包是包名 `dsh-session-ops`）。 */
  id: string
  /** 工厂：`require('react')` 由外壳预置，其余依赖按 id 解析。 */
  factory: (require: (specifier: string) => any) => unknown
}

/** DSH Web 外壳预置的模块加载器。 */
interface ModuleLoader {
  load(definition: ModuleLoaderDefinition): unknown
}

interface Window {
  __ModuleLoader__?: ModuleLoader
}
