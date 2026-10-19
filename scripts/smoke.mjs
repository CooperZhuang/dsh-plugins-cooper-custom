/**
 * 加载冒烟：不依赖宿主，只验本插件自己的东西。
 *
 *   node scripts/smoke.mjs
 *
 * 验四件事：
 *   1. 主入口与演练台入口能加载，且导出的是 Cordis 认得的插件形状；
 *   2. 随包预设里没有内核已删除的 toolFilter，subagent 工具行按 0.2.1-rc.2 的新约定
 *      指到叶子预设；
 *   3. 装到临时 DSH_HOME 后，叶子预设真的派生出来了（子代理那份没有委派工具的组成）；
 *   4. 叶子预设能解析成注册表声明（相对路径 ./anchor-gate.mjs 解析成 file URL）。
 *
 * 演练台的工具入口（lib/redteam/tools.js）不在这里跑：它在模块加载时就要从宿主
 * 路径解析 @deepseek-ai/dsh-tools，脱离宿主必然失败——那是设计如此。
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];
let checks = 0;
function check(ok, label) {
  checks += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures.push(label);
}

// ---- 1. 入口能加载，形状对 ----
const main = await import(join(root, "lib", "index.js"));
check(main.name === "dsh-purge", `主入口 name=${main.name}`);
check(Array.isArray(main.inject) && main.inject.join(",") === "systemPrompt,tools", `主入口 inject=${main.inject?.join(",")}`);
check(typeof main.apply === "function", "主入口导出 apply()");
check(typeof main.default === "object" && main.default?.name === "dsh-purge", "主入口有 default 插件对象");

const redteam = await import(join(root, "lib", "redteam", "index.js"));
check(redteam.name === "dsh-purge-redteam", `演练台入口 name=${redteam.name}`);
check(typeof redteam.apply === "function", "演练台入口导出 apply()");

const composition = await import(join(root, "lib", "redteam", "preset-composition.js"));
check(typeof composition.readPresetDefinition === "function", "预设解析器可用");

// ---- 2. 随包预设符合 0.2.1-rc.2 的子代理约定 ----
const shipped = readFileSync(join(root, "presets", "redteam", "agent.cordis.yml"), "utf8");
check(!/^[ \t]*toolFilter:/m.test(shipped), "随包预设里没有 toolFilter（内核已删除该字段）");
check(/^[ \t]*agentPreset: redteam-worker$/m.test(shipped), "随包预设的 subagent 工具行指到叶子预设");
check(/^- id: delegation$/m.test(shipped), "随包预设保留 delegation 分组（指挥端要派活）");

// ---- 3. 装到临时 DSH_HOME：叶子预设真的派生出来 ----
const home = mkdtempSync(join(tmpdir(), "dsh-purge-smoke-"));
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = home;
try {
  const installed = redteam.installPreset({ force: true, log: () => {} });
  check(installed.action === "installed", `预设安装 action=${installed.action}`);

  const commanderFile = join(home, ".agent-presets", "redteam", "agent.cordis.yml");
  check(existsSync(commanderFile), "指挥预设已落到用户 preset 根");
  const commander = readFileSync(commanderFile, "utf8");
  check(!/^[ \t]*toolFilter:/m.test(commander), "装出来的指挥预设里没有 toolFilter");
  check(/^[ \t]*agentPreset: redteam-worker$/m.test(commander), "装出来的指挥预设指到叶子预设");

  const workerDir = join(home, ".agent-presets", "redteam-worker");
  check(existsSync(join(workerDir, "agent.cordis.yml")), "叶子预设已派生");
  check(existsSync(join(workerDir, "preset.yml")), "叶子预设的显示元数据已生成");
  check(existsSync(join(workerDir, "anchor-gate.mjs")), "叶子预设的锚点门脚本已生成");

  const worker = readFileSync(join(workerDir, "agent.cordis.yml"), "utf8");
  check(!/^- id: delegation$/m.test(worker), "叶子预设摘掉了 delegation 分组（没有委派工具）");
  check(/- id: persona/.test(worker), "叶子预设保留人设");
  check(/- id: redteam-tools/.test(worker), "叶子预设保留红队工具行");

  // ---- 4. 叶子预设能解析成注册表声明 ----
  const definition = composition.readPresetDefinition("redteam-worker", workerDir);
  check(definition.id === "redteam-worker", `注册表声明 id=${definition.id}`);
  check(Array.isArray(definition.plugins) && definition.plugins.length > 0, `注册表声明有 ${definition.plugins?.length} 行`);
  const anchor = definition.plugins.find((row) => row.id === "anchor-gate");
  check(typeof anchor?.name === "string" && anchor.name.startsWith("file://"), "锚点门的相对路径已解析成 file URL");
  check(
    !definition.plugins.some((row) => String(row.name || "").includes("dsh-tool-subagent")),
    "叶子预设里没有委派工具行",
  );

  // ---- 5. 自愈：老预设（带 toolFilter）被就地改写 ----
  const oldText = commander
    .replace(/^[ \t]*agentPreset: redteam-worker$/m, "")
    .replace(
      /^([ \t]*)maxDepth: 1$/m,
      "$1maxDepth: 1\n$1toolFilter:\n$1  deny:\n$1    - subagent_fork\n$1    - workflow\n$1    - ralph",
    );
  writeFileSync(commanderFile, oldText, "utf8");
  const repaired = redteam.installPreset({ force: false, log: () => {} });
  const after = readFileSync(commanderFile, "utf8");
  check(!/^[ \t]*toolFilter:/m.test(after), "自愈后老预设里没有 toolFilter 了");
  check(/^[ \t]*agentPreset: redteam-worker$/m.test(after), "自愈后老预设指到叶子预设");
  check(repaired.action === "repaired", `自愈 action=${repaired.action}`);
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
}

// ---- 6. 可选：拿真实内核包验子代理约定（装得到内核时才跑） ----
let kernel = null
try {
  kernel = await import("@deepseek-ai/dsh-tool-subagent")
} catch {
  kernel = null
}
if (kernel === null) {
  console.log("skip  真实内核包不在本机（装上 @deepseek-ai/dsh-tool-subagent 就能跑这段）")
} else {
  const oldConfig = {
    provider: "spawn",
    toolName: "subagent",
    modelSelectionSettings: true,
    backgroundMode: "continuable",
    maxDepth: 1,
    toolFilter: { deny: ["subagent_fork", "workflow", "ralph"] },
  }
  let oldError = null
  try {
    await kernel.apply({ get: () => undefined, on: () => () => {}, logger: { info() {}, warn() {} } }, oldConfig, undefined)
  } catch (error) {
    oldError = error
  }
  check(
    /toolFilter is no longer supported/.test(String(oldError?.message || "")),
    "真实内核：带 toolFilter 的配置被拒（0.2.1-rc.2 起 toolFilter 已删除）",
  )
}

console.log("");
if (failures.length > 0) {
  console.error(`smoke 失败 ${failures.length}/${checks}：${failures.join(" | ")}`);
  process.exit(1);
}
console.log(`smoke 通过 ${checks}/${checks}`);
