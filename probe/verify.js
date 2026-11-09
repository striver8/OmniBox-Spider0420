// 权威判定：对每个失败脚本抓 根域名 + 失败页，按标记归类（关站/停放/404/引导页/验证码墙/JS墙/CF/正常）
"use strict";
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const cheerio = require("cheerio");
const CURL = "C:/Windows/System32/curl.exe";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const drift = require("./drift.json");
const RULES = [
  [/关站公告|停止运营|本站已(正式)?(停止|关闭)|资源调整公告|永久关闭|江湖再见/i, "CLOSED_公告"],
  [/domain.{0,12}for sale|域名出售|域名转让|购买此域名/i, "PARKED"],
  [/永久(地址|域名)发布页|地址发布页|引导页|请(收藏|记住)(本站|本页)|最新网址|防失联/i, "JUMP_发布页"],
  [/系统安全验证|请输入验证码|人机验证|滑动验证|安全验证/i, "WALL_验证码"],
  [/ge_js_validator/, "WALL_JS_COOKIE"],
  [/cf-browser-verification|challenge-platform|Just a moment/i, "WALL_CF"],
  [/<title>\s*404|404 Not Found|页面不存在/i, "HTTP_404"],
];
function grab(url) {
  const tmp = path.join(__dirname, ".v.html");
  const r = spawnSync(CURL, ["-sS", "-L", "--compressed", "-m", "20", "-A", UA, "-H", "Accept-Language: zh-CN,zh;q=0.9", "-o", tmp, "-w", "%{http_code} %{size_download} %{url_effective}"], { encoding: "utf8", timeout: 30000, input: "" });
  return r;
}
function fetch2(url) {
  const tmp = path.join(__dirname, ".v.html");
  const r = spawnSync(CURL, ["-sS", "-L", "--compressed", "-m", "20", "-A", UA, "-H", "Accept-Language: zh-CN,zh;q=0.9", "-o", tmp, "-w", "%{http_code} %{size_download} %{url_effective}", url], { encoding: "utf8", timeout: 30000 });
  const [code, size, eff] = String(r.stdout || "").trim().split(" ");
  let body = ""; try { body = fs.readFileSync(tmp, "utf8"); } catch (_) {}
  return { code: +code || 0, size: +size || 0, eff: eff || url, body };
}
function origin(u) { try { const x = new URL(u); return x.origin + "/"; } catch (_) { return null; } }
function classify(p) {
  for (const [rx, tag] of RULES) if (rx.test(p.body)) return tag;
  if (p.code === 0) return "DNS_DEAD";
  if (p.code === 404) return "HTTP_404";
  if (p.code >= 500) return "HTTP_" + p.code;
  const $ = cheerio.load(p.body);
  const cards = $(".public-list-box, .module-item, .module-item-pic, .stui-vodlist__box, .hl-list-item, .video-content, li.video, .box, .movie-list-item").length;
  const detailLinks = (p.body.match(/href=["'][^"']*\/(detail|voddetail|vod\/detail|v|anime|subject|play)\/[\w-]+/g) || []).length;
  if (p.size < 20000 && /_next\/static|__NUXT__|id="app"><\/div>|webpack/i.test(p.body)) return "SPA_需重写";
  if (cards >= 3 || detailLinks >= 5) return "ALIVE_有内容";
  return "ALIVE_无条目";
}
const out = [];
for (const d of drift) {
  const lastUrl = d.lastUrl || d.url || null;
  const host = lastUrl ? origin(lastUrl) : null;
  const rec = { file: d.file, step: d.step, verdict: d.verdict, host, lastUrl };
  const p1 = host ? fetch2(host) : null;
  rec.root = p1 ? { code: p1.code, size: p1.size, eff: p1.eff, cls: classify(p1) } : null;
  let p2 = null;
  if (lastUrl && lastUrl !== host) { p2 = fetch2(lastUrl); rec.page = { code: p2.code, size: p2.size, cls: classify(p2) }; }
  rec.final = rec.page && rec.page.cls !== "ALIVE_无条目" ? rec.page.cls : (rec.root ? rec.root.cls : "NO_HOST");
  if (rec.final === "ALIVE_无条目" && rec.page) rec.final = rec.page.cls;
  out.push(rec);
  console.error(`${rec.final.padEnd(14)} ${d.file}`);
}
fs.writeFileSync(path.join(__dirname, "verify.json"), JSON.stringify(out, null, 2));
const by = {}; for (const o of out) by[o.final] = (by[o.final] || 0) + 1;
console.log(by, "total", out.length);
