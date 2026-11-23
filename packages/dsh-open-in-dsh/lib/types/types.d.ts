/**
 * The shared entry Config type of `dsh-open-in-dsh`.
 *
 * One type, two faces: the Host schema in `index.ts` resolves the profile row
 * into this shape, and the browser half receives its `Volatile` fields through
 * `apply(ctx, config)` as the kernel's `SyncedConfig<OpenInDshConfig>`
 * (`@deepseek-ai/dsh-client-config/types`). Keeping the shape here means the
 * half that declares the fields and the half that reads them cannot drift, and
 * that neither half has to import the other.
 *
 * Only a field some reader reads again while the plugin stays mounted is
 * declared `Volatile`. The Loader hands those to `apply` as references and
 * commits a later config write into them in place, so the plugin must read
 * `.get()` at the point of use instead of capturing a value. A field consumed
 * once at mount — the enable switch, the loopback policy, the replay window,
 * the bound socket path — stays an ordinary value on purpose: changing it has
 * to remount the row, and a volatile field would silently stop doing that.
 *
 * @module dsh-open-in-dsh/types
 */
import type { Volatile } from '@deepseek-ai/cordis';
/** One resolved entry config, as both plugin faces name it. */
export interface OpenInDshConfig {
    /** Master switch, read once when the row mounts; off means no route and no socket. */
    enabled: boolean;
    /**
     * Whether every announced folder lands in a brand-new blank Session.
     *
     * Volatile because the browser half decides per request: a write made while
     * the host runs must reach the page that is already loaded, without a reload.
     * The Host half itself never reads this field — it exists in the schema so
     * the kernel projects it into the graph row the Client face receives.
     */
    alwaysNewSession: Volatile<boolean>;
    /** Whether a non-loopback peer may announce a path; captured by the route handlers at mount. */
    allowNonLoopback: boolean;
    /** How long an unanswered request stays replayable; read once when the hub is built. */
    backlogTtlMs: number;
    /** macOS handoff socket path; bound once when the row mounts. Empty disables the transport. */
    socketPath: string;
}
