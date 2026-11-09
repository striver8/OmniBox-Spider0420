// 对每个失败脚本的"最后一条请求 URL"重新抓取，判定：墙/停放/真实内容(可修漂移)
"use strict";
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const CURL = "C:/Windows/System32/curl.exe";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const drift = require("./drift.json");
const WALL = [
  [/系统安全验证/, "WALL_CAPTCHA"],
  [/ge_js_validator/, "WALL_JS_COOKIE"],
  [/domain.{0,10}for sale|域名出售|域名转让/i, "PARKED"],
  [/cf-browser-verification|challenge-platform|Just a moment/i, "WALL_CF"],
  [/访问验证|人机验证|安全验证|滑动验证|请开启JavaScript/i, "WALL_CAPTCHA"],
  [/<title>\s*404|页面不存在|404 Not Found/i, "HTTP_404PAGE"],
];
function grab(url) {
  const tmp = path.join(__dirname, ".r.html");
  const r = spawnSync(CURL, ["-sS", "-L", "--compressed", "-m", "20", "-A", UA, "-o", tmp, "-w", "%{http_code} %{size_download} %{url_effective}", url], { encoding: "utf8", timeout: 30000 });
  const [code, size, eff] = String(r.stdout || "").trim().split(" ");
  let body = ""; try { body = fs.readFileSync(tmp, "utf8"); } catch (_) {}
  return { code: +code || 0, size: +size || 0, eff: eff || url, body };
}
const out = [];
for (const d of drift) {
  const url = d.lastUrl || d.url || null;
  if (!url) { out.push({ ...d, re: "NO_URL" }); continue; }
  const p = grab(url);
  let re = "ALIVE_UNKNOWN";
  for (const [rx, tag] of WALL) if (rx.test(p.body)) { re = tag; break; }
  if (re === "ALIVE_UNKNOWN") {
    const links = (p.body.match(/href=["'][^"']*\/(detail|voddetail|anime|play|movie|subject)\//g) || []).length;
    re = links >= 5 ? "DRIFT_LINKS_" + links : "ALIVE_NOITEMS";
  }
  out.push({ file: d.file, step: d.step, url, code: p.code, size: p.size, re });
  console.error(`${re.padEnd(18)} ${d.file}`);
}
fs.writeFileSync(path.join(__dirname, "redetect.json"), JSON.stringify(out, null, 2));
const by = {}; for (const o of out) by[o.re.replace(/_\d+$/, "")] = (by[o.re.replace(/_\d+$/, "")] || 0) + 1;
console.log(by, "total", out.length);
