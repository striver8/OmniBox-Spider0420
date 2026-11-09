// 用法: node probe/peek.js <url> [kw]
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs"), path = require("path");
const cheerio = require("cheerio");
const url = process.argv[2];
const kw = process.argv[3] || "";
const CURL = "C:/Windows/System32/curl.exe";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const tmp = path.join(__dirname, ".peek.html");
const r = spawnSync(CURL, ["-sS", "-L", "--compressed", "-m", "25", "-A", UA, "-H", "Accept-Language: zh-CN,zh;q=0.9", "-o", tmp, "-w", "%{http_code} %{size_download} %{url_effective}", url], { encoding: "utf8", timeout: 35000 });
console.log("HTTP:", String(r.stdout || "").trim());
const h = fs.readFileSync(tmp, "utf8");
const $ = cheerio.load(h);
console.log("TITLE:", $("title").text().trim(), "| bytes:", h.length);
const text = $("body").text().replace(/\s+/g, " ").trim();
console.log("TEXT:", text.slice(0, 300));
const classes = {};
h.replace(/class="([^"]+)"/g, (_, c) => { c.split(/\s+/).forEach((x) => { if (x && !/^(active|on|show|hide|clearfix|row|col|col-|container|mt-|mb-|pt-|pb-|d-|text-|btn|badge|icon|fa|swiper)/.test(x)) classes[x] = (classes[x] || 0) + 1; }); return ""; });
console.log("TOPCLASS:", Object.entries(classes).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k}:${v}`).join(" "));
const hrefs = {}; $("a[href]").each((i, e) => { const hr = $(e).attr("href"); const k = String(hr).replace(/[0-9a-zA-Z_-]{4,}/g, "*"); hrefs[k] = (hrefs[k] || 0) + 1; });
console.log("HREF PATTERNS:", Object.entries(hrefs).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}:${v}`).join("  "));
if (kw) { const i = h.indexOf(kw); if (i >= 0) console.log("KW CTX:", h.slice(Math.max(0, i - 260), i + 160).replace(/\s+/g, " ")); else console.log("KW CTX: not found"); }
