/**
 * Ambient declarations for the browser half.
 *
 * These names are not defined by the browser: `PACKAGE` and
 * `REMOTE_INVOCATION_DATA` are injected as literals by
 * `scripts/build-client.mts` (the package name from `package.json` and the
 * host's own wire table), and `window.__ModuleLoader__` is the DSH client
 * module system the generated `lib/client.js` registers itself with.
 */

/** One parameter of a Remote invocation, as the host's wire table declares it. */
interface RemoteInvocationParameter {
  readonly name: string
  readonly wire: string
  readonly shape: string
  readonly optional?: boolean
}

/** One Remote invocation, as the host's wire table declares it. */
interface RemoteInvocation {
  readonly method: string
  readonly parameters: readonly RemoteInvocationParameter[]
  readonly result: string
}

/** The package name; also the client bundle id and the Plugins-page card key. */
declare const PACKAGE: string

/** The host's wire table, injected verbatim so the two halves cannot drift. */
declare const REMOTE_INVOCATION_DATA: readonly RemoteInvocation[]

/** The client module system: a bundle registers a lazy CJS factory with it. */
interface Window {
  __ModuleLoader__: {
    load(entry: {
      readonly id: string
      readonly factory: (require: (specifier: string) => unknown) => unknown
    }): void
  }
}
