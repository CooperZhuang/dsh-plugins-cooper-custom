#!/usr/bin/env node
/**
 * 让 DSH 会话头部的「打开方式」多一个 QSpace Pro，并且排第一（即该菜单的默认项），访达保留。
 *
 * 为什么要改 App 包：应用目录来自内核包 @deepseek-ai/dsh-host-open-in-app 的编译期白名单
 * （README 明说「部署无法从 cordis.yml 增加应用」，custom handler 仍是延后工作），
 * 浏览器半边 @deepseek-ai/dsh-client-ui-open-in-app 又用自己那张 APP_LABEL_KEY 表过滤宿主
 * 返回的 id —— 两边都得插一行，才既有条目又有名字。
 *
 * DSH 桌面端 2.0.19 起把应用源码打进 Contents/Resources/app.asar（之前是 Resources/app 目录），
 * 两种布局都支持：asar 模式重建归档，并按 Electron 的规则改写 Info.plist 里的
 * ElectronAsarIntegrity.hash（= header JSON 字符串的 SHA256）。重建保序：不施加改动时产物
 * 与原归档逐字节相同。
 *
 * 用法：
 *   node scripts/patch-open-in-app-qspace.mjs --check    只报告补丁状态
 *   node scripts/patch-open-in-app-qspace.mjs --apply    打补丁 -> 自检 -> 重签 -> 不过就自动回滚
 *   node scripts/patch-open-in-app-qspace.mjs --revert   还原（asar 模式从 .dsh-bak 恢复）
 *   node scripts/patch-open-in-app-qspace.mjs --verify   自检：结构 + 全量 integrity + 语法 + 真跑路由
 *   可选：--app <DSH.app 路径>  --runner <Electron 可执行文件>（隔离自检用）
 *
 * 生效要重启桌面端（宿主半边在插件初始化时就把目录定死了）。DSH 升级会整体替换 .app，
 * 补丁随之消失 —— 升级后重跑一次 --apply。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readArchive, headerJsonHash, rebuildArchive, sha256 } from "./lib/asar.mjs";

const DEFAULT_APP = "/Applications/DSH Desktop Beta.app";
const HOST_PKG = "node_modules/@deepseek-ai/dsh-host-open-in-app/lib/index.js";
const CLIENT_PKG = "node_modules/@deepseek-ai/dsh-client-ui-open-in-app/lib/client.js";

// 宿主半边：插在 OPEN_IN_APP_CATALOG 数组开头，第一条即默认项。
const HOST_ANCHOR = "const OPEN_IN_APP_CATALOG = [\n";
const HOST_ENTRY = [
  "// dsh-qspace-patch（scripts/patch-open-in-app-qspace.mjs 写入；DSH 升级后重跑）",
  "{",
  '\tid: "qspace",',
  '\tplatforms: { darwin: macApp("QSpace Pro.app") }',
  "},",
];

// 浏览器半边：APP_LABEL_KEY 登记 id -> 词典键；PRODUCT_NAMES 登记产品名（中英文共用）。
const CLIENT_LABEL_ANCHOR = "const APP_LABEL_KEY = {\n";
const CLIENT_LABEL_LINE = 'qspace: "app.qspace",';
const CLIENT_NAMES_ANCHOR = "const PRODUCT_NAMES = {\n";
const CLIENT_NAMES_LINE = '"app.qspace": "QSpace Pro",';

const MARK = "dsh-qspace-patch";
const TMP = process.env.TMPDIR ?? "/tmp";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};
const appDir = value("--app", DEFAULT_APP);
const runnerOverride = value("--runner", null);
const modes = ["--check", "--apply", "--revert", "--verify"].filter(flag);
if (modes.length !== 1) {
  console.error("用法：node scripts/patch-open-in-app-qspace.mjs --check|--apply|--revert|--verify [--app <路径>] [--runner <Electron>]");
  process.exit(2);
}
const mode = modes[0];

const resources = join(appDir, "Contents/Resources");
const asarPath = join(resources, "app.asar");
const useAsar = existsSync(asarPath);
const plistPath = join(appDir, "Contents/Info.plist");
// 备份必须放在 .app 之外：包内多一个文件就让 codesign 拒绝签名
// （"code object is not signed at all, In subcomponent: ...dsh-bak"），
// 而改过 Info.plist 的包本来就必须重新签名，见 resignApp()。
const backupDir = join(homedir(), "Library", "Application Support", "DSH Desktop Beta", "patch-backups");
const asarBackup = join(backupDir, "app.asar.dsh-bak");
const plistBackup = join(backupDir, "Info.plist.dsh-bak");
const targetPath = (rel) => (useAsar ? asarPath + "/" + rel : join(resources, "app", rel));

function fail(message) {
  console.error("FAIL " + message);
  process.exit(1);
}

/**
 * 改过 Info.plist 的包必须重新签名。
 *
 * 补丁会重写 Info.plist 里的 ElectronAsarIntegrity.hash，而 Info.plist 被签名
 * 覆盖，所以打补丁后 codesign --verify 必然报 "invalid Info.plist
 * (plist or signature have been modified)"，宿主每次启动/派生进程都刷一行
 * SecCodeCheckValidity -67030。重签成 ad-hoc 并保留 entitlements（Electron 需要
 * JIT / unsigned executable memory / disable-library-validation），签名即可恢复有效。
 *
 * 代价：ad-hoc 签名没有 Developer ID，Squirrel 自动更新可能在比对签名时拒绝安装，
 * 升级需要手动下载安装包；装回官方包后签名恢复为官方签名。
 *
 * @returns 失败原因，成功时 null。
 */
function resignApp() {
  try {
    execFileSync("codesign", [
      "--force", "--sign", "-",
      "--preserve-metadata=entitlements,requirements,flags,runtime",
      appDir,
    ], { stdio: "pipe" });
  } catch (error) {
    return "codesign 失败：" + String(error.stderr ?? error.message).trim();
  }
  try {
    execFileSync("codesign", ["--verify", "--strict", appDir], { stdio: "pipe" });
  } catch (error) {
    return "重签后校验仍失败：" + String(error.stderr ?? error.message).trim();
  }
  return null;
}

/** 当前签名状态，供报告显示；出错时返回 null。 */
function signatureState() {
  try {
    execFileSync("codesign", ["--verify", "--strict", appDir], { stdio: "pipe" });
    return "有效";
  } catch {
    return "无效（需要重新签名：--apply 会自动重签）";
  }
}

/** 读一个目标文件：asar 里取条目，目录布局直接读文件。 */
function readTarget(rel) {
  if (!useAsar) {
    try {
      return readFileSync(join(resources, "app", rel));
    } catch {
      return null;
    }
  }
  return readArchive(asarPath).readFile(rel);
}

function stateOf(rel, name) {
  const bytes = readTarget(rel);
  if (bytes === null) return { name: name, rel: rel, present: false, patched: false };
  const text = bytes.toString("utf8");
  const patched = name === "host"
    ? text.includes(MARK)
    : text.includes(CLIENT_LABEL_LINE) && text.includes(CLIENT_NAMES_LINE);
  return { name: name, rel: rel, present: true, patched: patched };
}

function state() {
  return [stateOf(HOST_PKG, "host"), stateOf(CLIENT_PKG, "client")];
}

function report() {
  console.log("布局：" + (useAsar ? "asar" : "目录") + "  " + (useAsar ? asarPath : join(resources, "app")));
  for (const entry of state()) {
    console.log("[" + entry.name + "] " + (entry.patched ? "已打补丁" : "未打补丁") + "  " + entry.rel);
  }
  if (useAsar) console.log("备份：" + (existsSync(asarBackup) ? asarBackup : "（无）"));
  const signed = signatureState();
  if (signed !== null) console.log("签名：" + signed);
}

// 在锚点行后插入若干行，缩进跟随锚点后面第一个非空行。
function insertLines(source, anchor, lines) {
  const at = source.indexOf(anchor);
  if (at === -1) throw new Error("锚点没找到：" + anchor.trim());
  const after = at + anchor.length;
  const indent = /^([ \t]*)\S/.exec(source.slice(after))?.[1] ?? "";
  const body = lines.map((line) => (line === "" ? "" : indent + line)).join("\n") + "\n";
  return source.slice(0, after) + body + source.slice(after);
}

function removeLines(source, anchor, lines) {
  const at = source.indexOf(anchor);
  if (at === -1) return source;
  const after = at + anchor.length;
  const indent = /^([ \t]*)\S/.exec(source.slice(after))?.[1] ?? "";
  const body = lines.map((line) => (line === "" ? "" : indent + line)).join("\n") + "\n";
  if (!source.startsWith(body, after)) return source;
  return source.slice(0, after) + source.slice(after + body.length);
}

/** 补齐两个文件的补丁内容，返回 Map<归档内路径, Buffer>（只含需要写的）。 */
function buildEdits(entries) {
  const edits = new Map();
  for (const entry of entries) {
    if (entry.patched) continue;
    const bytes = readTarget(entry.rel);
    if (bytes === null) fail("读不到 " + entry.rel + " —— 确认 --app 指向 DSH 桌面端 .app");
    let text = bytes.toString("utf8");
    if (entry.name === "host") {
      text = insertLines(text, HOST_ANCHOR, HOST_ENTRY);
    } else {
      text = insertLines(text, CLIENT_LABEL_ANCHOR, [CLIENT_LABEL_LINE]);
      text = insertLines(text, CLIENT_NAMES_ANCHOR, [CLIENT_NAMES_LINE]);
    }
    edits.set(entry.rel, Buffer.from(text, "utf8"));
  }
  return edits;
}

/** 把新的 header JSON 哈希写回 Info.plist（Electron 的 asar 完整性校验只比这一个值）。 */
function writePlistHash(hash) {
  const code = [
    "import plistlib, sys",
    "path, value = sys.argv[1], sys.argv[2]",
    "with open(path, 'rb') as fh: info = plistlib.load(fh)",
    "entry = (info.get('ElectronAsarIntegrity') or {}).get('Resources/app.asar')",
    "if not entry: sys.exit('ElectronAsarIntegrity.Resources/app.asar 不存在')",
    "entry['hash'] = value",
    "info['ElectronAsarIntegrity']['Resources/app.asar'] = entry",
    "with open(path, 'wb') as fh: plistlib.dump(info, fh, fmt=plistlib.FMT_BINARY)",
  ].join("\n");
  try {
    execFileSync("/usr/bin/python3", ["-c", code, plistPath, hash], { stdio: "pipe" });
    execFileSync("/usr/bin/plutil", ["-lint", plistPath], { stdio: "pipe" });
  } catch (error) {
    fail("写 Info.plist 失败：" + String(error.stderr ?? error.message).trim());
  }
}

function plistHash() {
  // 键名里带 "/" 和 "."，plutil 的 keypath 表达不了，直接用 plistlib 读。
  const code = [
    "import plistlib, sys",
    "with open(sys.argv[1], 'rb') as fh: info = plistlib.load(fh)",
    "entry = (info.get('ElectronAsarIntegrity') or {}).get('Resources/app.asar') or {}",
    "print(entry.get('hash', ''))",
  ].join(String.fromCharCode(10));
  try {
    return execFileSync("/usr/bin/python3", ["-c", code, plistPath], { stdio: "pipe" }).toString("utf8").trim() || null;
  } catch {
    return null;
  }
}

/** 跑 Electron 的 node 模式（asar 布局）或普通 node 来执行自检脚本。 */
function electronRunner() {
  if (runnerOverride !== null) return runnerOverride;
  try {
    const name = execFileSync("/usr/bin/plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", plistPath], { stdio: "pipe" }).toString("utf8").trim();
    return join(appDir, "Contents/MacOS", name);
  } catch {
    return null;
  }
}

function runHarness(harness, iconOut) {
  const env = { ...process.env, QSPACE_ICON_OUT: iconOut };
  try {
    if (useAsar) {
      const runner = electronRunner();
      if (runner === null || !existsSync(runner)) fail("找不到 Electron 可执行文件（可用 --runner 指定）");
      return execFileSync(runner, [harness], { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "pipe", timeout: 180000 }).toString("utf8");
    }
    return execFileSync(process.execPath, [harness], { env: env, stdio: "pipe", timeout: 180000 }).toString("utf8");
  } catch (error) {
    fail("自检脚本执行失败：" + String(error.stderr ?? error.message).trim().slice(0, 900));
  }
}

/**
 * 用一个临时脚本在目标运行时里跑三件事：
 *  1) 从 asar 直接 import 宿主插件（会连带解析一串 node_modules —— 上次坏就坏在这条路上）
 *  2) 调 GET /open-in-app/apps，确认 qspace 排第一、访达还在
 *  3) 调 GET /open-in-app/icon/qspace，确认图标真抽出来了
 */
function verifyRoutes() {
  const harness = join(TMP, "qspace-harness-" + String(process.pid) + ".mjs");
  const iconOut = join(TMP, "qspace-icon-" + String(process.pid) + ".png");
  const hostUrl = pathToFileURL(targetPath(HOST_PKG)).href;
  const probeUrl = pathToFileURL(targetPath("node_modules/@deepseek-ai/dsh-launch-environment/lib/index.js")).href;
  const source = [
    'import { writeFileSync } from "node:fs";',
    "const probe = await import(" + JSON.stringify(probeUrl) + ");",
    "const mod = await import(" + JSON.stringify(hostUrl) + ");",
    "const routes = new Map();",
    "const ctx = {",
    "  get: () => void 0,",
    "  effect: (fn) => fn(),",
    "  webServer: { register: (route) => { routes.set(route.path, route); return () => {}; } },",
    "  connection: { requestRejection: () => void 0 },",
    "  subprocess: { resolveExecutable: async () => null },",
    "};",
    "mod.apply(ctx, { probeTimeoutMs: 10000, iconTimeoutMs: 10000, launchWatchMs: 1000 });",
    "const response = () => ({ statusCode: 0, headers: {}, body: Buffer.alloc(0),",
    "  setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },",
    "  end(chunk) { this.body = chunk === void 0 ? Buffer.alloc(0) : Buffer.from(chunk); } });",
    "const request = (path, method) => ({ method: method ?? 'GET', url: path, headers: { accept: 'application/json', host: 'localhost' } });",
    "const appsRes = response();",
    "await routes.get('/open-in-app/apps').handler(request('/open-in-app/apps'), appsRes);",
    "const apps = JSON.parse(appsRes.body.toString('utf8')).apps;",
    "const iconRes = response();",
    "await routes.get('/open-in-app/icon').handler(request('/open-in-app/icon/qspace'), iconRes);",
    "writeFileSync(process.env.QSPACE_ICON_OUT, iconRes.body);",
    "console.log(JSON.stringify({ probeExports: Object.keys(probe).length, apps: apps, qspaceFirst: apps[0] === 'qspace',",
    "  finder: apps.includes('finder'), icon: { status: iconRes.statusCode, type: iconRes.headers['content-type'], bytes: iconRes.body.length } }));",
    "",
  ].join("\n");
  writeFileSync(harness, source);
  try {
    const stdout = runHarness(harness, iconOut);
    const lines = stdout.trim().split("\n");
    return { result: JSON.parse(lines[lines.length - 1]), iconOut: iconOut };
  } finally {
    rmSync(harness, { force: true });
  }
}

/** 语法闸：把目标文件抄成 .mjs 让 node --check 按模块目标解析。 */
function syntaxGate(entries) {
  const failures = [];
  for (const entry of entries) {
    const bytes = readTarget(entry.rel);
    if (bytes === null) { failures.push(entry.rel + " 读不到"); continue; }
    const tmp = join(TMP, "qspace-" + entry.name + "-" + String(process.pid) + ".mjs");
    writeFileSync(tmp, bytes);
    try {
      execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
    } catch (error) {
      failures.push(entry.name + " 语法检查失败：" + String(error.stderr ?? error.message).trim().slice(0, 400));
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  return failures;
}

/** 归档自洽：所有打包条目落在数据区内，且每个文件内容与 header 里的 integrity 一致。 */
function archiveChecks(failures) {
  const archive = readArchive(asarPath);
  const actual = plistHash();
  const expected = headerJsonHash(archive.header);
  if (actual === null) failures.push("Info.plist 里没有 ElectronAsarIntegrity 哈希");
  else if (actual !== expected) failures.push("Info.plist 哈希与 asar header 不一致");
  const packed = [];
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = prefix === "" ? name : prefix + "/" + name;
      if (child.files) walk(child, path);
      else if (!child.link && !child.unpacked) packed.push([path, child]);
    }
  };
  walk(archive.header, "");
  let end = archive.dataStart;
  let mismatched = 0;
  for (const [path, child] of packed) {
    end = Math.max(end, archive.dataStart + Number(child.offset) + child.size);
    const bytes = archive.readFile(path);
    if (bytes === null || bytes.length !== child.size) { mismatched += 1; failures.push(path + " 大小不符"); continue; }
    if (child.integrity && sha256(bytes) !== child.integrity.hash) { mismatched += 1; failures.push(path + " integrity 不符"); }
  }
  if (end !== statSync(asarPath).size) failures.push("归档长度自洽失败：" + String(end) + " != " + String(statSync(asarPath).size));
  console.log("归档自洽：全量 " + String(packed.length) + " 个条目 integrity 校验，失配 " + String(mismatched) + " 个，总长 " + String(end) + " 字节");
}

/** 完整自检：补丁在场 + 语法 + 归档自洽 + 真跑路由。返回失败清单。 */
function runChecks() {
  const entries = state();
  const failures = [];
  for (const entry of entries) {
    if (!entry.present) failures.push("缺少 " + entry.rel);
    else if (!entry.patched) failures.push(entry.rel + " 未打补丁");
  }
  failures.push(...syntaxGate(entries));
  if (useAsar) archiveChecks(failures);
  const routes = verifyRoutes();
  if (!routes.result.qspaceFirst) failures.push("apps 列表第一项不是 qspace：" + JSON.stringify(routes.result.apps));
  if (!routes.result.finder) failures.push("访达条目丢了：" + JSON.stringify(routes.result.apps));
  if (routes.result.icon.status !== 200 || routes.result.icon.bytes < 1024) failures.push("图标路由异常：" + JSON.stringify(routes.result.icon));
  console.log(JSON.stringify({ layout: useAsar ? "asar" : "dir", ...routes.result }, null, 2));
  return failures;
}

function restoreBackup() {
  if (!useAsar) return false;
  if (!existsSync(asarBackup)) return false;
  copyFileSync(asarBackup, asarPath);
  rmSync(asarBackup, { force: true });
  if (existsSync(plistBackup)) {
    copyFileSync(plistBackup, plistPath);
    rmSync(plistBackup, { force: true });
  }
  return true;
}

if (mode === "--check") {
  report();
  process.exit(state().every((entry) => entry.patched) ? 0 : 1);
}

if (mode === "--apply") {
  let entries = state();
  if (entries.some((entry) => !entry.present)) fail("读不到目标包 —— 确认 --app 指向 DSH 桌面端 .app");
  if (entries.some((entry) => !entry.patched)) {
    const edits = buildEdits(entries);
    if (useAsar) {
      mkdirSync(backupDir, { recursive: true });
      if (!existsSync(asarBackup)) {
        copyFileSync(asarPath, asarBackup);
        console.log("已备份 " + asarBackup);
      }
      if (existsSync(plistPath) && !existsSync(plistBackup)) {
        copyFileSync(plistPath, plistBackup);
        console.log("已备份 " + plistBackup);
      }
      const before = statSync(asarPath).size;
      const archive = readArchive(asarPath);
      const temp = asarPath + ".dsh-new";
      rebuildArchive({ sourcePath: asarPath, destPath: temp, header: archive.header, edits: edits });
      renameSync(temp, asarPath);
      const rebuilt = readArchive(asarPath);
      console.log("已重建 asar：" + String(before) + " -> " + String(statSync(asarPath).size) + " 字节");
      const hash = headerJsonHash(rebuilt.header);
      writePlistHash(hash);
      console.log("已更新 Info.plist ElectronAsarIntegrity.hash = " + hash.slice(0, 16) + "...");
    } else {
      for (const [rel, bytes] of edits) writeFileSync(join(resources, "app", rel), bytes);
      console.log("已写入 " + String(edits.size) + " 个文件（Resources/app 目录布局）");
    }
    entries = state();
  }
  const failures = runChecks();
  if (failures.length > 0) {
    for (const failure of failures) console.error("FAIL " + failure);
    const restored = restoreBackup();
    console.error(restored ? "自检没过，已自动回滚到补丁前的 app.asar / Info.plist。" : "自检没过，没有备份可回滚。");
    process.exit(1);
  }
  const signError = resignApp();
  if (signError !== null) {
    console.error("FAIL " + signError);
    const restored = restoreBackup();
    console.error(restored ? "签名失败，已回滚到补丁前的 app.asar / Info.plist。" : "签名失败，没有备份可回滚。");
    process.exit(1);
  }
  report();
  console.log("自检通过，已重新签名。重启 DSH 桌面端后生效。");
  process.exit(0);
}

if (mode === "--revert") {
  const restored = restoreBackup();
  if (restored) {
    console.log("已从备份恢复 app.asar 与 Info.plist");
  } else if (!useAsar) {
    for (const entry of state()) {
      if (!entry.patched) continue;
      const file = join(resources, "app", entry.rel);
      let text = readFileSync(file, "utf8");
      if (entry.name === "host") text = removeLines(text, HOST_ANCHOR, HOST_ENTRY);
      else {
        text = removeLines(text, CLIENT_NAMES_ANCHOR, [CLIENT_NAMES_LINE]);
        text = removeLines(text, CLIENT_LABEL_ANCHOR, [CLIENT_LABEL_LINE]);
      }
      writeFileSync(file, text);
    }
    console.log("已移除补丁插入行（Resources/app 目录布局）");
  } else {
    console.log("没有备份可恢复");
  }
  const signError = resignApp();
  if (signError !== null) fail(signError);
  report();
  console.log("已重新签名（ad-hoc）。重启 DSH 桌面端后生效。");
  process.exit(0);
}

if (mode === "--verify") {
  const failures = runChecks();
  if (failures.length > 0) {
    for (const failure of failures) console.error("FAIL " + failure);
    process.exit(1);
  }
  console.log("OK");
  process.exit(0);
}
