/**
 * Family detection: decide whether `rtk pipe -f <filter>` is provably
 * applicable to this text. A wrong `-f` destroys content (measured: 751 B of
 * unrelated text collapsed to 4 lines), so anything unrecognised falls through
 * to a bare `rtk pipe`, which passes unrecognised text through byte-for-byte.
 *
 * @module dsh-rtk-slim/sniff
 */
/** One recognised output family and the rtk filter that proves applicable. */
export interface Family {
    /** Stable family id; also the override key in config `filters`. */
    id: string;
    /** rtk `-f` value this family maps to. */
    filter: string;
    /** Whether this text belongs to the family. */
    test: (text: string) => boolean;
}
/** Ordered families; first match wins. */
export declare const FAMILIES: readonly Family[];
/** Config `filters`: an explicit rtk filter per family id, or `false` to disable it. */
export type FilterOverrides = Record<string, string | false>;
/** The filter decision for one text. */
export interface FilterChoice {
    /** Matched family id, or `auto` for a bare `rtk pipe`. */
    family: string;
    /** rtk `-f` value; `undefined` means "bare rtk pipe". */
    filter: string | undefined;
}
/**
 * @param text - body text (trailing status markers already removed).
 * @param overrides - config `filters`.
 * @returns the family and filter to use; `auto` means "bare rtk pipe".
 */
export declare function chooseFilter(text: string, overrides?: FilterOverrides): FilterChoice;
