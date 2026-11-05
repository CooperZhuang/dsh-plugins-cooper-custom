/**
 * 本包内部的小工具：只放「宿主边界上重复出现、但语义必须逐字一致」的那几行。
 *
 * 目前只有一处：把 `unknown` 类型抛出的错误取成可读文案。JS 里的写法是
 * `String(error?.message ?? error)`——它同时容忍 Error、任意带 `message` 的对象、
 * 以及 `throw 'oops'` 这样的原始值。TS 的 `catch` 变量是 `unknown`，这份语义必须
 * 原样保留（错误文案会被用户可见的报告与日志引用），所以收成一个函数。
 *
 * @module dsh-session-ops/store/util
 */
/**
 * 取一个 unknown 错误的可读文案，语义与 `String(error?.message ?? error)` 逐字一致。
 * @param error - catch 到的错误。
 * @returns 可读文案。
 */
export function messageOf(error) {
    const candidate = error;
    return String(candidate?.message ?? error);
}
