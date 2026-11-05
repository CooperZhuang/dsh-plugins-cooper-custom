#!/usr/bin/env node
/**
 * 校验 profile 里 file: 安装的插件是否仍和仓库源码保持一致。
 *
 * 为什么需要：pnpm 的 `file:` 目录依赖在本机是硬链接副本，`pnpm build` 会写穿
 * 已存在的文件，但**新增的源文件不会出现在 profile/node_modules 里**。宿主下次
 * 启动 import 新模块时直接 ERR_MODULE_NOT_FOUND（2026-11-05 的
 * dsh-memories/lib/raw-recall.js 就是这样坏的），而 `pnpm install` 对「清单没变」
 * 的 file: 依赖只报 Already up to date，不会自愈。
 *
 * 检查每个已安装包的 lib/ 子树：
 *   missing  源码有、installed 没有 → 新文件没链接（宿主启动会失败）
 *   detached 两边都有但不是同一个 inode → 不是硬链接，build 不会写穿
 *   extra    installed 有、源码没有 → 残留产物（只提示，不修）
 *
 * 用法：
 *   node scripts/verify-profile-links.mjs
 *   node scripts/verify-profile-links.mjs --fix        # 缺失/未链接的文件补成硬链接
 *   node scripts/verify-profile-links.mjs --profile ~/.dsh/profiles/headless
 */
import { existsSync, linkSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(repoRoot, 'packages');
const args = process.argv.slice(2);

function option(name, fallback) {
    const index = args.indexOf(name);
    if (index < 0) return fallback;
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
        console.error(`${name} 需要一个路径参数`);
        process.exit(2);
    }
    return value;
}

const fix = args.includes('--fix');
const rawProfile = option('--profile', join(homedir(), '.dsh', 'profiles', 'desktop'));
const profile = resolve(rawProfile.startsWith('~') ? rawProfile.replace(/^~/, homedir()) : rawProfile);

if (!existsSync(join(profile, 'node_modules'))) {
    console.error(`profile 下没有 node_modules：${profile}`);
    process.exit(2);
}

/** 递归列出 dir 下的相对文件路径（忽略点开头的文件/目录）。 */
function walk(dir) {
    const result = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) result.push(...walk(path));
        else if (entry.isFile()) result.push(path);
    }
    return result;
}

/** 两个路径是否是同一个 inode（硬链接即同一个文件）。 */
function sameInode(a, b) {
    const left = statSync(a);
    const right = statSync(b);
    return left.dev === right.dev && left.ino === right.ino;
}

const packages = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();

let checked = 0;
let problems = 0;
let fixed = 0;
const lines = [];

for (const name of packages) {
    const sourceLib = join(packagesDir, name, 'lib');
    const installedRoot = join(profile, 'node_modules', name);
    const installedLib = join(installedRoot, 'lib');
    // 没装进这个 profile、或源码还没构建（lib/ 是 gitignore 产物），都不归本脚本管。
    if (!existsSync(installedLib)) continue;
    checked += 1;
    if (!existsSync(sourceLib)) {
        lines.push(`${name}: 源码没有 lib/（尚未构建？），跳过`);
        continue;
    }

    const sourceFiles = walk(sourceLib).map((path) => path.slice(sourceLib.length + 1));
    const installedFiles = new Set(walk(installedLib).map((path) => path.slice(installedLib.length + 1)));
    const missing = [];
    const detached = [];
    let linked = 0;

    for (const rel of sourceFiles) {
        const source = join(sourceLib, rel);
        const target = join(installedLib, rel);
        if (!existsSync(target)) missing.push(rel);
        else if (!sameInode(source, target)) detached.push(rel);
        else linked += 1;
    }

    // 不是硬链接安装（registry 包的拷贝、或整包被重新 `pnpm install` 成普通目录）：
    // 本服务只负责硬链接安装的写穿一致性，这种包交给版本核对，别报一堆 detached。
    if (linked === 0) {
        const note = missing.length > 0
            ? `；另有 ${missing.length} 个源码文件没装进去（${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ' …' : ''}）`
            : '';
        lines.push(`${name}: 不是硬链接安装，跳过（${installedLib}）${note}`);
        problems += missing.length;
        continue;
    }

    const extra = [...installedFiles].filter((rel) => !sourceFiles.includes(rel));
    const issues = [...missing.map((rel) => `missing  ${rel}`), ...detached.map((rel) => `detached ${rel}`)];
    if (issues.length > 0 || extra.length > 0) {
        lines.push(`${name}:`);
        for (const line of issues) lines.push(`  ${line}`);
        for (const rel of extra) lines.push(`  extra    ${rel}（源码没有，建议删掉）`);
    }
    problems += issues.length;

    if (fix && (missing.length > 0 || detached.length > 0)) {
        for (const rel of [...missing, ...detached]) {
            const source = join(sourceLib, rel);
            const target = join(installedLib, rel);
            mkdirSync(dirname(target), { recursive: true });
            if (existsSync(target)) unlinkSync(target);
            linkSync(source, target);
            if (!sameInode(source, target)) throw new Error(`补链接后 inode 仍不一致：${target}`);
            fixed += 1;
        }
        lines.push(`  → 已补 ${missing.length + detached.length} 个硬链接`);
    }
}

console.log(`profile: ${profile}`);
console.log(`检查 ${checked} 个已安装包${fix ? '（--fix）' : ''}`);
for (const line of lines) console.log(line);

if (problems === 0) {
    console.log('结论：installed 的 lib/ 与源码一致（每个文件都是同一个 inode）');
    process.exit(0);
}
if (fix) {
    console.log(`结论：修了 ${fixed} 处链接；extra 项仍需手工确认`);
    process.exit(0);
}
console.log('');
console.log(`结论：${problems} 处不一致。新增文件不会随 build 进 profile：`);
console.log('  pnpm --dir <profile> remove <name> && pnpm --dir <profile> add --ignore-scripts <file:路径>');
console.log('  或者直接 node scripts/verify-profile-links.mjs --fix');
console.log('  改完记得让宿主重新 import（补链接后改 profile 的 cordis.patch.yml 可触发 hmr 重组；实在不行再重启）。');
process.exit(1);
