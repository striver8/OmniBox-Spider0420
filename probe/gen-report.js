// Generate the maintenance report (Markdown) from the probe artifacts.
"use strict";
const fs = require("fs");
const path = require("path");
const HERE = __dirname;
const ROOT = path.resolve(HERE, "..");

const report = require("./report-merged.json");
const drift = JSON.parse(fs.readFileSync(path.join(HERE, "drift.json"), "utf8"));
const classify = JSON.parse(fs.readFileSync(path.join(HERE, "classify.json"), "utf8"));

const clsByFile = new Map(classify.map((c) => [c.file, c]));
const driftByFile = new Map(drift.map((d) => [d.file, d]));

const DRIVE = /verfied|drive/i;
const NEED_DRIVE = [];
const rows = [];

const SITE_NOTE = {
  DNS_DEAD: "域名已失效（DNS/连接失败）",
  PARKED: "域名已出售，停放页",
  CHALLENGE: "存在 JS/WAF 校验",
  SPA: "站点已改为 SPA，旧接口/选择器失效",
  ALIVE: "站点可达",
  NO_HOST: "脚本内无固定域名（需运行时配置）",
  UNKNOWN: "未知",
};

const REPORT_LIST = Array.isArray(report) ? report : report.results;
for (const r of REPORT_LIST) {
  const d = driftByFile.get(r.file);
  const c = clsByFile.get(r.file);
  const step = d && d.step;
  const err = (d && d.err) || r.loadErr || "";
  const isDrive = /影视\/网盘\//.test(r.file);
  let action = "无需处理";
  if (r.verdict === "broken") action = "修复或移入 已失效待修复/";
  else if (r.verdict === "partial") action = "修复单点（仅该步骤失效）";
  else if (r.verdict === "unverifiable") action = "须在 OmniBox 内实测（依赖宿主 SDK：网盘/媒体库）";
  else if (r.verdict === "config") action = "配置型脚本，填好环境变量即可用";
  else if (r.verdict === "ok") action = "无需处理";
  if (c && c.siteCls === "DNS_DEAD") action = "换域名或判死";
  if (c && c.siteCls === "PARKED") action = "域名已出售，判死";
  if (c && c.siteCls === "CHALLENGE") action = "需浏览器环境或补签名算法";
  if (c && c.siteCls === "SPA") action = "需按新站重写解析";
  if (isDrive && r.verdict !== "ok") action = "需在 OmniBox 内实测（依赖网盘 API）";
  rows.push({ file: r.file, verdict: r.verdict, step, err, site: c && c.siteCls, host: c && c.host, action, reqs: r.reqs || [] });
}

const byVerdict = { ok: [], partial: [], broken: [], unverifiable: [], config: [] };
for (const row of rows) (byVerdict[row.verdict] || (byVerdict[row.verdict] = [])).push(row);

const dirCount = {};
for (const row of rows) {
  const dir = row.file.split("/")[0];
  dirCount[dir] = dirCount[dir] || { ok: 0, partial: 0, broken: 0, unverifiable: 0, config: 0 };
  dirCount[dir][row.verdict] = (dirCount[dir][row.verdict] || 0) + 1;
}

const esc = (s) => String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\n/g, " ");

let md = [];
md.push("# OmniBox-Spider 维护报告（自动探活）");
md.push("");
md.push(`- 生成时间：${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`);
md.push(`- 基线提交：${process.env.BASE_COMMIT || "05098f0"}`);
md.push(`- 探活范围：${rows.length} 个可运行脚本（含 runner.run 的 .js）`);
md.push(`- 判定口径：home/category/detail 任一硬失败 = 失效；只有 search 或 play 失败 = 部分可用；依赖宿主 SDK（网盘/媒体库）而本地用桩的记为"需在宿主实测"；未填配置的记为"配置型"`);
md.push("");
md.push("## 一、总体结论");
md.push("");
md.push("| 状态 | 数量 | 占比 |");
md.push("| --- | --- | --- |");
const total = rows.length;
const VERDICT_LABEL = { ok: "正常", partial: "部分可用", broken: "失效", unverifiable: "需在宿主实测", config: "配置型（未填配置）" };
for (const k of ["ok", "partial", "unverifiable", "config", "broken"]) {
  md.push(`| ${VERDICT_LABEL[k]} | ${byVerdict[k].length} | ${((byVerdict[k].length / total) * 100).toFixed(1)}% |`);
}
md.push("");
md.push("### 按目录");
md.push("");
md.push("| 目录 | 正常 | 部分可用 | 需宿主实测 | 配置型 | 失效 |");
md.push("| --- | --- | --- | --- | --- | --- |");
for (const dir of Object.keys(dirCount).sort()) {
  const c = dirCount[dir];
  md.push(`| ${dir} | ${c.ok || 0} | ${c.partial || 0} | ${c.unverifiable || 0} | ${c.config || 0} | ${c.broken || 0} |`);
}
md.push("");
md.push("## 二、失效原因分布");
md.push("");
const reasonBuckets = {};
for (const row of rows) {
  if (row.verdict === "ok") continue;
  let key;
  if (row.site === "DNS_DEAD") key = "域名死亡（DNS/连接失败）";
  else if (row.site === "PARKED") key = "域名已出售（停放页）";
  else if (row.site === "CHALLENGE") key = "JS/WAF 校验拦截";
  else if (row.site === "SPA") key = "站点改版为 SPA，旧解析失效";
  else if (/STEP_TIMEOUT|HARD_TIMEOUT/.test(row.err || "")) key = "加载/请求超时";
  else if (/empty list/.test(row.err || "")) key = "页面可达但解析为空（改版/选择器漂移）";
  else if (/no playable episodes/.test(row.err || "")) key = /网盘/.test(row.file) ? "依赖网盘 API（本地无法验证）" : "播放源解析失效";
  else if (/HTTP 4|HTTP 5/.test(row.err || "")) key = "接口返回错误（403/404/5xx）";
  else key = "其他/需人工确认";
  (reasonBuckets[key] = reasonBuckets[key] || []).push(row);
}
md.push("| 原因 | 数量 |");
md.push("| --- | --- |");
for (const k of Object.keys(reasonBuckets).sort((a, b) => reasonBuckets[b].length - reasonBuckets[a].length)) {
  md.push(`| ${k} | ${reasonBuckets[k].length} |`);
}
md.push("");

function table(title, list, note) {
  md.push(`### ${title}（${list.length}）`);
  md.push("");
  if (note) { md.push(note); md.push(""); }
  md.push("| 脚本 | 失败步骤 | 站点状态 | 原因摘要 | 建议 |");
  md.push("| --- | --- | --- | --- | --- |");
  for (const row of list) {
    md.push(`| ${esc(row.file)} | ${esc(row.step || "-")} | ${esc(SITE_NOTE[row.site] || "-")} | ${esc((row.err || "").slice(0, 90))} | ${esc(row.action)} |`);
  }
  md.push("");
}

md.push("## 三、明细");
md.push("");
table("失效（broken）", byVerdict.broken, "home/category/detail 存在硬失败，脚本当前不可用。");
table("部分可用（partial）", byVerdict.partial, "主体可用，仅某一环节（多为搜索或播放）失效。");
table("需在宿主实测（unverifiable）", byVerdict.unverifiable, "失败只发生在依赖宿主 SDK 的环节（网盘 `getDriveFileList` / 媒体库 `listMediaItems`），本地探针用桩代替，不能据此判死。");
table("配置型（config）", byVerdict.config, "脚本要求先填环境变量（服务器地址 / Token / API Key），未填即返回空，属于预期行为。");
md.push(`### 正常（ok，${byVerdict.ok.length}）`);
md.push("");
md.push(byVerdict.ok.map((r) => r.file).join("、"));
md.push("");
md.push("## 四、处置建议");
md.push("");
md.push("1. **域名已死/已出售**：脚本无法靠改选择器救活，需重新找站；建议先移入 `已失效待修复/` 并在脚本头标注 `@status dead`，避免用户加载后空列表。");
md.push("2. **改版为 SPA / JS 校验**：纯 `request` 已无法拿到数据，需要（a）逆向新站 JSON 接口，或（b）在爬虫内实现 cookie/签名挑战。属于重写级工作，按站点逐个排期。");
md.push("3. **解析漂移（页面可达、结果为空）**：优先修复，改动集中在选择器/接口字段，验证成本最低。");
md.push("4. **网盘类（影视/网盘/*）**：本地 probe 无法提供 `getDriveFileList` 等能力，须在 OmniBox 客户端内实测后再判定，勿直接标记失效。");
md.push("5. **搜索缺失/空实现**：部分脚本 `search` 是空函数（如 `短剧/星星短剧.js`），属于功能缺口而非站点失效，应单独补实现。");
md.push("");
md.push("## 五、复现方式");
md.push("");
md.push("```bash");
md.push("npm install                      # 运行期依赖 cheerio / crypto-js");
md.push("node probe/run.js                # 全量探活（默认 8 并发）");
md.push("node probe/run.js \"影视/采集/HDmoli.js\"   # 单脚本");
md.push("node probe/classify.js           # 站点级存活/停放/挑战分类");
md.push("node probe/gen-report.js         # 生成本报告");
md.push("```");
md.push("");
md.push("产物：`probe/report.json`（单次结果）、`probe/report-merged.json`（合并基线）、`probe/classify.json`（站点分类）、`probe/drift.json`（失败摘要）、本文件。");
md.push("");

const archivedPath = path.join(HERE, "archived.json");
if (fs.existsSync(archivedPath)) {
  const arch = JSON.parse(fs.readFileSync(archivedPath, "utf8"));
  if (arch.length) {
    md.push("## 六、本轮已处置：归档到 `已失效待修复/`");
    md.push("");
    md.push(`共 ${arch.length} 个脚本的站点已确认不可用（域名出售 / 关站公告 / 跳转广告发布页 / DNS 不可达 / 强制验证码），已移入 \`已失效待修复/\` 并在脚本头打 \`@status dead\` 标记，保留 operator 追溯：`);
    md.push("");
    md.push("| 原位置 | 判定 | 原域名 |");
    md.push("| --- | --- | --- |");
    for (const a of arch) md.push(`| ${esc(a.file)} | ${esc(a.reason)} | ${esc(a.host)} |`);
    md.push("");
    md.push("> 归档不是删除：换到新域名后，把文件移回原目录、更新 `HOST`，再跑 `node probe/run.js <路径>` 验证即可。");
    md.push("");
  }
}

const evidencePath = path.join(HERE, "evidence.md");
if (fs.existsSync(evidencePath)) {
  const extra = fs.readFileSync(evidencePath, "utf8").trim();
  if (extra) { md.push(extra); md.push(""); }
}

fs.writeFileSync(path.join(ROOT, "维护报告.md"), md.join("\n"));
console.log("wrote 维护报告.md", md.join("\n").length, "chars");
console.log(byVerdict.ok.length, byVerdict.partial.length, byVerdict.broken.length, "unverifiable=" + byVerdict.unverifiable.length, "config=" + byVerdict.config.length);
