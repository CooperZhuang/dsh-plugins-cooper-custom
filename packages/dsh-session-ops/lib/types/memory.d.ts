/**
 * 项目作用域记忆的「随会话走」支持（**可选，默认关**）。
 *
 * 背景：`dsh-cross-memory` 的项目作用域是**工作区级**的 —— 存到
 * `$DSH_HOME/memories/projects/<slug>/entries/<id>.md`，slug 由工作区根目录派生
 * （`slugify(basename)`，只取项目名、与机器路径无关，见其 storage.js）。
 * 所以搬会话**不需要**搬记忆：会话换了 cwd，作用域自然跟到目标工作区。
 * 但"这条会话在源工作区下写下的条目"留在源工作区，如果这次搬迁属于**纠正错放**
 * （会话本来就该在目标工作区），那些条目也该一起过去。本模块只负责这一件事。
 *
 * 两条设计原则：
 *   1. **默认不做**。项目记忆是工作区共享的，把单条会话的条目拖过去会改变另一个
 *      工作区的记忆视图——这种事必须显式开启（`memoryFollow: 'copy' | 'move'`）。
 *   2. **文件级、可逆、可预演**。`dsh-cross-memory` 的存储契约写明「条目文件才是真相源，
 *      索引是可重建的缓存，手改/删除索引会在下次读取时自愈」，所以复制 `.md` 文件
 *      就是受支持的写入方式，也不必依赖它的运行时。
 *
 * @module dsh-session-ops/memory
 */
/** 一个已存在的项目记忆目录。 */
export interface ProjectMemoryDir {
    slug: string;
    root: string;
    descriptorFile: string;
    dir: string;
}
/** 一条被选中的记忆条目文件。 */
export interface MemoryFollowEntry {
    id: string;
    title: string;
    sourceFile: string;
    targetFile: string;
    existsInTarget: boolean;
}
/** {@link planMemoryFollow} 的计划（**只读**）。 */
export interface MemoryFollowPlan {
    projectsDir: string;
    source: {
        slug: string;
        root: string;
        dir: string;
    } | null;
    target: {
        slug: string;
        root: string;
        dir: string;
        descriptorFile: string;
        existed: boolean;
        planned?: boolean;
    };
    sessionId: string;
    totalInSource: number;
    matched: MemoryFollowEntry[];
}
/** {@link planMemoryFollow} 的选项。 */
export interface MemoryFollowOptions {
    dshHome: string;
    sessionId: string;
    fromCwd: string;
    toCwd: string;
}
/** {@link applyMemoryFollow} 的结果。 */
export interface MemoryFollowOutcome {
    mode: string;
    copied: number;
    skipped: number;
    removed: number;
    files: string[];
    removeError?: string;
}
/** 与 dsh-cross-memory/lib/storage.js 的 slugify 逐字一致。 */
export declare function slugify(value: unknown): string;
/**
 * 与 dsh-cross-memory/lib/storage.js 的 projectSlug 逐字一致：**只取项目名**，
 * 不再拼 `sha1(resolve(root))` 后缀。dsh-cross-memory 已把项目 slug 改成
 * 「一台机器上算出来、另一台也对得上」的名字派生（旧的后缀方案会把同一个
 * 项目按机器拆成多个目录，迁移逻辑见其 storage.ts 的 LEGACY_PROJECT_SLUG）。
 */
export declare function projectSlug(root: string): string;
/** `$DSH_HOME/memories/projects`。 */
export declare function projectsDirOf(dshHome: string): string;
/**
 * 在 projects 目录里按 root 找已存在的项目（优先命中已有 slug，避免算出第二个目录）。
 * @param projectsDir - `…/memories/projects`。
 * @param root - 工作区根目录。
 * @returns `{slug, root, descriptorFile, dir}`，没有时 `undefined`。
 */
export declare function findProjectByRoot(projectsDir: string, root: string): ProjectMemoryDir | undefined;
/** 极简 frontmatter 解析：只认 `key: value` 单行（dsh-cross-memory 的条目就是这种形状）。 */
export declare function parseFrontmatter(text: string): Record<string, string>;
/**
 * 计算一次「记忆随会话走」的计划。**只读**。
 *
 * @param options - `{dshHome, sessionId, fromCwd, toCwd}`。
 * @returns 计划：源/目标项目、匹配到的条目（按 frontmatter 的 `session:` 归属过滤）。
 */
export declare function planMemoryFollow(options: MemoryFollowOptions): MemoryFollowPlan;
/**
 * 执行计划。`copy` 只加不删；`move` 复制后从源项目移除（= 纠正错放）。
 * 目标已有同名条目时跳过（不覆盖、按名去重）。
 *
 * @param plan - {@link planMemoryFollow} 的返回值。
 * @param mode - `'copy'` 或 `'move'`。
 * @returns `{mode, copied, skipped, removed, files}`。
 */
export declare function applyMemoryFollow(plan: MemoryFollowPlan, mode: string): MemoryFollowOutcome;
