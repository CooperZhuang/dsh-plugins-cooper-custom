/**
 * Ambient declarations for the browser half.
 *
 * `client/index.ts` is a classic script (it has no imports or exports), so the
 * bundle wrapper in `scripts/build-client.mts` can embed it inside a
 * `window.__ModuleLoader__.load({ id, factory })` factory unchanged. The DOM
 * types come from the `DOM` lib in `tsconfig.client.json`; only the two
 * page globals this plugin defines or consumes are declared here.
 */

/** The troubleshooting hook the browser half installs on `window`. */
interface FolderPathDebugHook {
  /** The host route the plugin calls. */
  route: string
  /** Ask the host for the full paths behind these folder names. */
  probe(names: string[]): Promise<{ paths: string[]; reason: string | null }>
  /** Insert text through DSH's own paste path. */
  insert(root: HTMLElement, text: string): void
  /** Split a paste payload into directories and files. */
  classify(dataTransfer: DataTransfer): { directories: string[]; files: File[] }
}

interface Window {
  /** The DSH client module system; the bundle wrapper registers through it. */
  __ModuleLoader__: {
    load(registration: { id: string; factory: (require: (id: string) => unknown) => unknown }): void
  }
  /** Installed by `apply` so the devtools console can drive the plugin. */
  __dshFolderPath?: FolderPathDebugHook
}
