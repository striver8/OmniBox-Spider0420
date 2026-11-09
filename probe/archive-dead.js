// Move scripts whose host is provably dead (DNS failure / parked domain) into 已失效待修复/,
// mirroring their directory layout, and stamp a status header so the reason survives review.
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const classify = JSON.parse(fs.readFileSync(path.join(__dirname, "classify.json"), "utf8"));
const DEAD = new Set(["DNS_DEAD", "PARKED"]);
const dry = process.argv.includes("--dry");
let moved = 0;

for (const c of classify) {
  if (!DEAD.has(c.siteCls)) continue;
  if (/^已失效待修复\//.test(c.file)) continue;
  const src = path.join(ROOT, c.file);
  if (!fs.existsSync(src)) continue;
  { const s = fs.readFileSync(src, "utf8"); if (/(HOST|BASE_URL|API)\s*=\s*["\x27][^"\x27]*\.\.\.[^"\x27]*["\x27]/.test(s)) { console.log("skip placeholder host: " + c.file); continue; } }
  const dest = path.join(ROOT, "已失效待修复", c.file);
  let body = fs.readFileSync(src, "utf8");
  if (!/@status\s+dead/.test(body)) {
    const stamp = `// @status dead | ${c.siteCls} | 原域名 ${c.host || "unknown"} 已不可用（${new Date().toISOString().slice(0, 10)} 探活）——换源后需重写解析\n`;
    const lines = body.split("\n");
    let at = 0;
    while (at < lines.length && /^\/\//.test(lines[at])) at++;
    lines.splice(at, 0, stamp.trimEnd());
    body = lines.join("\n");
  }
  console.log(`${dry ? "[dry] " : ""}${c.file}  (${c.siteCls})  ->  已失效待修复/${c.file}`);
  if (dry) continue;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body);
  fs.unlinkSync(src);
  moved++;
}
console.log(`moved=${moved}`);
