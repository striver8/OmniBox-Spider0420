// Classify failing spiders: parked domain / DNS dead / JS challenge / drift / unknown.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const CURL = "C:/Windows/System32/curl.exe";
const triage = require("./triage.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

function candidates(src) {
  const set = [];
  const push = (h) => {
    h = String(h || "").trim().replace(/['"`;,].*$/, "");
    if (!/^https?:\/\//.test(h)) return;
    let u; try { u = new URL(h); } catch (_) { return; }
    if (/github|gh-proxy|tmdb|image\.tmdb|w3\.org|localhost|127\.0\.0\.1|192\.168|example\.com/i.test(u.hostname)) return;
    if (!set.some((x) => new URL(x).hostname === u.hostname)) set.push(u.origin + "/");
  };
  for (const m of src.matchAll(/(?:const|let|var)\s+(?:BASE_URL|HOST|API_BASE|BASE|SITE|ORIGIN|apiBase|baseUrl|host)\s*=\s*['"`]([^'"`]+)['"`]/g)) push(m[1]);
  for (const m of src.matchAll(/https?:\/\/[a-zA-Z0-9._-]+/g)) push(m[0]);
  return set.slice(0, 3);
}

function probe(url) {
  const tmp = path.join(__dirname, ".c.html");
  const r = spawnSync(CURL, ["-sS", "-L", "--compressed", "-m", "15", "-A", UA, "-o", tmp, "-w", "%{http_code} %{size_download} %{url_effective}", url], { encoding: "utf8", timeout: 25000 });
  const [code, size, eff] = String(r.stdout || "").trim().split(" ");
  let body = "";
  try { body = fs.readFileSync(tmp, "utf8"); } catch (_) {}
  return { code: Number(code) || 0, size: Number(size) || 0, effective: eff || url, body };
}

const PARK = /domain (is )?for sale|域名出售|域名转让|This domain is for sale|购买此域名|parked domain/i;
const CHALLENGE = /ge_js_validator|cf-browser-verification|challenge-platform|Just a moment|安全验证|document\.cookie\s*=\s*"[a-z0-9_]*(valid|token|challenge)/i;
const SPA = /_next\/static|__NEXT_DATA__|window\.__NUXT__|<div id="app"><\/div>|webpack/i;

const out = [];
for (const t of triage) {
  if (t.cls === "LOAD_ERR") { out.push({ ...t, host: null, siteCls: t.cls }); continue; }
  const abs = path.join(ROOT, t.file);
  let src = "";
  try { src = fs.readFileSync(abs, "utf8"); } catch (_) {}
  const cands = candidates(src);
  let best = null;
  for (const c of cands) {
    const p = probe(c);
    const rec = { url: c, ...p, body: undefined };
    if (!best || (p.code === 200 && best.code !== 200) || (p.code === 200 && p.size > best.size)) best = rec;
    if (p.code === 200) break;
  }
  let siteCls = "UNKNOWN";
  if (!best) siteCls = "NO_HOST";
  else if (best.code === 0) siteCls = "DNS_DEAD";
  else if (PARK.test(best.body)) siteCls = "PARKED";
  else if (CHALLENGE.test(best.body)) siteCls = "CHALLENGE";
  else if (best.code === 200 && best.size < 20000 && SPA.test(best.body)) siteCls = "SPA";
  else if (best.code === 200) siteCls = "ALIVE";
  else siteCls = "HTTP_" + best.code;
  out.push({ ...t, host: best && best.url, hostCode: best && best.code, hostSize: best && best.size, effective: best && best.effective, siteCls });
  console.error(`${siteCls.padEnd(10)} ${t.file}`);
}
fs.writeFileSync(path.join(__dirname, "classify.json"), JSON.stringify(out, null, 2));
const by = {}; for (const o of out) by[o.siteCls] = (by[o.siteCls] || 0) + 1;
console.log(by);
