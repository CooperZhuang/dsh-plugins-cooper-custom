/**
 * Startup evidence. The harness never logs plugin activation to disk (dsh web
 * and the Desktop shell keep stdout in memory), so "did it actually mount, and
 * with which config?" is otherwise unanswerable after a restart. One appended
 * line per activation settles it.
 *
 * Never throws: a logging failure must not stop the plugin from loading.
 *
 * @module dsh-rtk-slim/log
 */
/**
 * `$DSH_HOME/logs/dsh-rtk-slim.log`, falling back to `~/.dsh/logs/...`.
 * @returns absolute path of this plugin's log file.
 */
export declare function defaultLogPath(): string;
/**
 * Append one timestamped line.
 * @param line - the line to record.
 * @param path - log file path; defaults to {@link defaultLogPath}.
 * @returns whether the line was written.
 */
export declare function logStartup(line: string, path?: string): boolean;
