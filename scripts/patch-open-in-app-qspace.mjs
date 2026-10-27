#!/usr/bin/env node
/**
 * 让 DSH 会话头部的「打开方式」多一个 QSpace Pro，并且排第一（即该菜单的默认项），访达保留。
 *
 * 为什么要改 App 包：应用目录来自内核包 @deepseek-ai/dsh-host-open-in-app 的编译期白名单
 * （README 明说「部署无法从 cordis.yml 增加应用」，custom handler 仍是延后工作），
 * 浏览器半边 @deepseek-ai/dsh-client-ui-open-in-app 又用自己那张 APP_LABEL_KEY 表过滤宿主
 * 返回的 id —— 两边都得插一行，才既有条目又有名字。
 *
 * 用法：
 *   node scripts/patch-open-in-app-qspace.mjs --check     只报告两个补丁点的状态
 *   node scripts/patch-open-in-app-qspace.mjs --apply     打补丁（幂等，重复跑不改动）
 *   node scripts/patch-open-in-app-qspace.mjs --revert    还原（只删自己插的行）
 *   node scripts/patch-open-in-app-qspace.mjs --verify    真跑一遍宿主解析：apps 列表 + 图标
 *   都可加 --app <DSH.app 路径> 指定别的安装位置
 *
 * DSH 桌面端升级会整体替换 .app，补丁随之消失 —— 升级后重跑一次 --apply --verify 即可。
 * QSpace Pro 换名/搬家的话，改 HOST_ENTRY 里的 bundle 名。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_APP = "/Applications/DSH Desktop Beta.app";
const RESOURCES = "Contents/Resources/app";
const HOST_FILE = join(RESOURCES, "node_modules/@deepseek-ai/dsh-host-open-in-app/lib/index.js");
const CLIENT_FILE = join(RESOURCES, "node_modules/@deepseek-ai/dsh-client-ui-open-in-app/lib/client.js");

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

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};
const appDir = value("--app", DEFAULT_APP);
const modes = ["--check", "--apply", "--revert", "--verify"].filter(flag);
if (modes.length !== 1) {
  console.error("用法：node scripts/patch-open-in-app-qspace.mjs --check|--apply|--revert|--verify [--app <路径>]");
  process.exit(2);
}
const mode = modes[0];

function read(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
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

// 删掉自己插入的那一段（按字面量匹配，不猜别的改动）。
function removeLines(source, anchor, lines) {
  const at = source.indexOf(anchor);
  if (at === -1) return source;
  const after = at + anchor.length;
  const indent = /^([ \t]*)\S/.exec(source.slice(after))?.[1] ?? "";
  const body = lines.map((line) => (line === "" ? "" : indent + line)).join("\n") + "\n";
  if (!source.startsWith(body, after)) return source;
  return source.slice(0, after) + source.slice(after + body.length);
}

function stateOf(name, file) {
  const source = read(file);
  if (source === null) return { name: name, file: file, present: false, patched: false, missing: true };
  const patched = name === "host"
    ? source.includes(MARK)
    : source.includes(CLIENT_LABEL_LINE) && source.includes(CLIENT_NAMES_LINE);
  return { name: name, file: file, present: true, patched: patched, missing: false };
}

const targets = [
  stateOf("host", join(appDir, HOST_FILE)),
  stateOf("client", join(appDir, CLIENT_FILE)),
];

function requireTargets() {
  for (const target of targets) {
    if (target.missing) {
      console.error("找不到 " + target.file + " —— 确认 --app 指向 DSH 桌面端 .app");
      process.exit(1);
    }
  }
}

// 每次都重新读文件判断：apply/revert 之后报告要说的是写完之后的状态。
function report() {
  for (const target of targets) {
    const state = stateOf(target.name, target.file);
    console.log("[" + target.name + "] " + (state.patched ? "已打补丁" : "未打补丁") + "  " + target.file);
  }
}

if (mode === "--check") {
  report();
  process.exit(targets.every((target) => target.patched) ? 0 : 1);
}

if (mode === "--apply") {
  requireTargets();
  for (const target of targets) {
    if (target.patched) continue;
    let source = read(target.file);
    if (target.name === "host") {
      source = insertLines(source, HOST_ANCHOR, HOST_ENTRY);
    } else {
      source = insertLines(source, CLIENT_LABEL_ANCHOR, [CLIENT_LABEL_LINE]);
      source = insertLines(source, CLIENT_NAMES_ANCHOR, [CLIENT_NAMES_LINE]);
    }
    writeFileSync(target.file, source);
    console.log("已写入 " + target.file);
  }
  report();
  console.log("重启 DSH 桌面端后生效（宿主半边在插件初始化时就把目录定死了）。");
  process.exit(0);
}

if (mode === "--revert") {
  requireTargets();
  for (const target of targets) {
    if (!target.patched) continue;
    let source = read(target.file);
    if (target.name === "host") {
      source = removeLines(source, HOST_ANCHOR, HOST_ENTRY);
    } else {
      source = removeLines(source, CLIENT_LABEL_ANCHOR, [CLIENT_LABEL_LINE]);
      source = removeLines(source, CLIENT_NAMES_ANCHOR, [CLIENT_NAMES_LINE]);
    }
    writeFileSync(target.file, source);
    console.log("已还原 " + target.file);
  }
  report();
  process.exit(0);
}

if (mode === "--verify") {
  requireTargets();
  const failures = [];
  const client = read(join(appDir, CLIENT_FILE));
  if (!client.includes(CLIENT_LABEL_LINE)) failures.push("浏览器半边缺 APP_LABEL_KEY 登记，菜单会把 qspace 过滤掉");
  if (!client.includes(CLIENT_NAMES_LINE)) failures.push("浏览器半边缺 app.qspace 词典项，菜单会是空名字");
  const tmpDir = process.env.TMPDIR ?? "/tmp";
  for (const entry of [["host", HOST_FILE], ["client", CLIENT_FILE]]) {
    const tmp = join(tmpDir, "qspace-" + entry[0] + "-" + String(process.pid) + ".mjs");
    writeFileSync(tmp, read(join(appDir, entry[1])));
    try {
      execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
    } catch (error) {
      const detail = String(error.stderr ?? error.message).trim();
      failures.push(entry[0] + " 语法检查失败：" + detail);
    }
  }

  // 真走一遍宿主解析：加载打了补丁的模块，调 apps 与 icon 两个路由。
  const moduleUrl = pathToFileURL(join(appDir, HOST_FILE)).href + "?t=" + String(Date.now());
  const mod = await import(moduleUrl);
  const routes = new Map();
  const ctx = {
    get: () => void 0,
    effect: (fn) => fn(),
    webServer: { register: (route) => { routes.set(route.path, route); return () => {}; } },
    connection: { requestRejection: () => void 0 },
    subprocess: { resolveExecutable: async () => null },
  };
  mod.apply(ctx, { probeTimeoutMs: 10000, iconTimeoutMs: 10000, launchWatchMs: 1000 });
  const response = () => ({
    statusCode: 0,
    headers: {},
    body: Buffer.alloc(0),
    setHeader(key, v) { this.headers[String(key).toLowerCase()] = v; },
    end(chunk) { this.body = chunk === void 0 ? Buffer.alloc(0) : Buffer.from(chunk); },
  });
  const request = (path, method) => ({ method: method ?? "GET", url: path, headers: { accept: "application/json", host: "localhost" } });

  const appsRes = response();
  await routes.get("/open-in-app/apps").handler(request("/open-in-app/apps"), appsRes);
  const apps = JSON.parse(appsRes.body.toString("utf8")).apps;
  if (apps[0] !== "qspace") failures.push("apps 列表第一项不是 qspace：" + JSON.stringify(apps));
  if (!apps.includes("finder")) failures.push("访达条目丢了：" + JSON.stringify(apps));

  const iconRes = response();
  await routes.get("/open-in-app/icon").handler(request("/open-in-app/icon/qspace"), iconRes);
  if (iconRes.statusCode !== 200) failures.push("图标路由返回 " + String(iconRes.statusCode));
  else if (iconRes.body.length < 1024) failures.push("图标只有 " + String(iconRes.body.length) + " 字节");

  console.log(JSON.stringify({
    app: appDir,
    apps: apps,
    qspaceFirst: apps[0] === "qspace",
    finder: apps.includes("finder"),
    icon: { status: iconRes.statusCode, type: iconRes.headers["content-type"], bytes: iconRes.body.length },
  }, null, 2));
  if (failures.length > 0) {
    for (const failure of failures) console.error("FAIL " + failure);
    process.exit(1);
  }
  console.log("OK");
  process.exit(0);
}
