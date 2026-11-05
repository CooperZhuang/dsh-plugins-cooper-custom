/**
 * Ambient browser globals for the DSH client bundle.
 *
 * `client/index.ts` is a classic script, not a module: it has no import/export,
 * so `tsc` emits it as-is and `scripts/build-client.mts` splices the emitted
 * text into the body of the factory `window.__ModuleLoader__.load({ id,
 * factory })` registers. This file only describes the globals that contract
 * itself puts on `window`; DOM types come from the `DOM` lib.
 */

/** One lazy module registration accepted by `window.__ModuleLoader__.load`. */
interface DshModuleLoaderRegistration {
  /** Package name the bundle registers under (`dsh-open-in-dsh`). */
  id: string
  /** Runs once on first require; its return value is the module's exports. */
  factory: (require: (id: string) => unknown) => unknown
}

/** The devtools/console surface the browser half exposes for troubleshooting. */
interface DshOpenInDebug {
  /** The Host route the stream follows. */
  route: string
  /** Make one folder the current Workspace (and land in a blank Session). */
  open: (path: string) => Promise<void>
  /** Ask the Host to launch one allowlisted app on a path. */
  openWith: (app: string, path: string) => Promise<void>
  /** A snapshot of the stream state, for `console.log(__dshOpenIn.status())`. */
  status: () => {
    lastSeq: number
    settings: { alwaysNewSession: boolean }
    uiWorkspace: boolean
    readyState: number | null
  }
}

interface Window {
  /** The DSH client module system: executes plugin bundles as classic scripts. */
  __ModuleLoader__: {
    load(registration: DshModuleLoaderRegistration): void
  }
  /** Troubleshooting hook, callable from the devtools console. */
  __dshOpenIn: DshOpenInDebug
}
