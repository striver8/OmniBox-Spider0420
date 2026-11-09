// Single-spider probe: load one spider with SDK shims, run home/category/search/detail/play.
// v2: dynamic keyword from real site data, multi-class retry, drive-shim limits reported as "unsupported".
"use strict";
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const rel = process.argv[2];
const abs = path.join(ROOT, rel);
const FIXED_KW = process.env.PROBE_KEYWORD || process.env.KEYWORD || "";
const STEP_MS = Number(process.env.PROBE_STEP_MS || 40000);

require("./axios-patch").install();
const ctx = { baseURL: "", headers: {}, sourceId: "probe", from: "web" };
const out = { file: rel.replace(/\\/g, "/"), loadOk: false, exports: [], steps: {}, verdict: "broken" };

function withTimeout(p, ms, label) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error("STEP_TIMEOUT " + label + " " + ms + "ms")), ms); }),
  ]);
}
function errStr(e) {
  const m = (e && (e.message || e.toString())) || "unknown";
  return String(m).replace(/\s+/g, " ").slice(0, 400);
}
function arr(x) { return Array.isArray(x) ? x : []; }
// 宿主 SDK 才有的能力（网盘取文件列表 / 媒体库）在探针里只能用桩，脚本多半会 catch 住错误
// 并返回空结果，所以除了错误文本本身，还要扫它写进 __logs 的日志才能判出"不可验证"。
const UNSUPPORTED = /unavailable|not implemented|probe: .*stub|listMediaItems|is not a function|getDriveFileList|getDriveVideoPlayInfo|getDriveVideoList|getDriveInfoByShareURL|网盘接口/i;
const DRIVE_LOG = /getDriveFileList|getDriveVideoPlayInfo|getDriveVideoList|getDriveInfoByShareURL|listMediaItems|unavailable|not a function/i;
// 需要用户先填配置（服务器地址 / token / API KEY）才能跑的脚本，不算"失效"，单独归类。
const CONFIG_REQUIRED = /配置缺失|请先填写|请先设置|请先在|未配置|FEINIU_HOST|ALIST_[A-Z_]+|TMDB_KEY|EMBY_[A-Z_]+/i;
// 脚本源码本身就把后端指向本机服务（如 alist-tvbox 的 127.0.0.1:4567）或留空的 env 变量，
// 在没有对应服务/配置的环境里必然空列表 —— 这类要在源码层面识别。
const NEEDS_LOCAL_SERVICE = /process\.env\.[A-Z0-9_]+(?:\s*\|\|\s*process\.env\.[A-Z0-9_]+)?\s*\|\|\s*["'`]https?:\/\/(?:127\.0\.0\.1|localhost)[^"'`]*["'`]/;
// 只认"后端地址类"的 env 变量（_API/_HOST/_URL/... 且默认留空）；Cookie/Token 之类不算，
// 否则会把"站点已停运但需要填 cookie"的脚本误判成配置型。
// NOTE: 弹幕接口 `DANMU_API = process.env.DANMU_API || ""` 几乎每个脚本都有，属可选增强，
//       必须排除，不然任何失败脚本都会被误判成"没填配置"。
const NEEDS_ENV_VAR = /process\.env\.(?!DANMU)[A-Z0-9_]*(?:_API|_HOST|_URL|_ENDPOINT|_SERVER|_DOMAIN|_BASE|_TOKEN|_KEY)\s*(?:\|\|\s*process\.env\.[A-Z0-9_]+)?\s*\|\|\s*["'`]{2}/;

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const r = await withTimeout(fn(), STEP_MS, name);
    out.steps[name] = { ok: true, ms: Date.now() - t0, note: r };
    return true;
  } catch (e) {
    const msg = errStr(e);
    let bad = UNSUPPORTED.test(msg);
    let logHint = "";
    if (!bad) {
      // 扫描脚本自己写下的日志：命中网盘/媒体库桩的报错也算"探针不可验证"。
      try {
        const logs = require(path.join(__dirname, "shims", "omnibox_sdk", "index.js")).__logs || [];
        const hits = logs.slice(-60).map((l) => `${l[0]}:${l[1]}`).filter((t) => DRIVE_LOG.test(t));
        if (hits.length) {
          logHint = hits.slice(-2).join(" | ").slice(0, 240);
          if (/unavailable|not a function|getDrive|listMediaItems/.test(logHint)) bad = true;
        }
      } catch (_) {}
    }
    out.steps[name] = { ok: false, ms: Date.now() - t0, err: msg, unsupported: bad, logHint: logHint || undefined };
    return false;
  }
}

function pickKeyword(pool) {
  if (FIXED_KW) return FIXED_KW;
  for (const it of pool) {
    const name = String(it.vod_name || it.name || it.title || "").trim();
    if (!name) continue;
    const clean = name.replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】|第\s*\d+\s*[集话期季]/g, "").trim();
    if (clean.length >= 2) return clean.slice(0, 12);
  }
  return "庆余年";
}

// 多关键词候选：原词 → 分隔符截断 → 逐级缩短；再从同一池子里挑"干净短标题"补位。
function keywordVariants(base, pool) {
  const out = [];
  const push = (v) => {
    const s = String(v || "").trim();
    if (s.length >= 2 && s.length <= 24 && !out.includes(s)) out.push(s);
  };
  const raw = String(base || "").trim();
  push(raw);
  const parts = raw.split(/[丨|｜·・•∙\-—–_/\\:：,，。.、!！?？~～\s"'"'（）()【】\[\]]+/).filter(Boolean);
  if (parts.length) {
    const head = parts[0];
    if (head.length > 6) push(head.slice(0, 6));
    if (head.length > 4) push(head.slice(0, 4));
    push(head);
  }
  for (const it of arr(pool)) {
    const name = String(it.vod_name || it.name || it.title || "").trim();
    if (!name) continue;
    const clean = name.replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】|第\s*\d+\s*[集话期季]|[丨|｜·・•\-—–_]+/g, "").trim();
    if (clean.length >= 2 && clean.length <= 8 && !/^\d+$/.test(clean)) push(clean);
    if (out.length >= 6) break;
  }
  return out.slice(0, 6);
}

(async () => {
  let mod;
  try {
    mod = require(abs);
  } catch (e) {
    out.loadErr = errStr(e);
    emit();
    return;
  }
  out.loadOk = true;
  // 源码层面的"配置型"判定：后端指向本机服务，或关键 env 变量留空默认值。
  try {
    const src = require("fs").readFileSync(abs, "utf8");
    out.needsLocalService = NEEDS_LOCAL_SERVICE.test(src);
    out.needsEnvVar = NEEDS_ENV_VAR.test(src);
    out.needsConfig = out.needsLocalService || out.needsEnvVar;
  } catch (_) {}
  const runnerMod = require("spider_runner");
  const registered = (typeof runnerMod.getHandlers === "function" && runnerMod.getHandlers()) || global.__SPIDER_HANDLERS;
  if (registered && Object.keys(registered).length) mod = registered;
  const fns = ["home", "category", "detail", "search", "play"].filter((k) => typeof mod[k] === "function");
  out.exports = fns;
  if (!out.exports.length) {
    out.loadErr = "no exported handlers";
    emit();
    return;
  }

  let home = null, cat = null, search = null, detail = null, play = null;

  if (fns.includes("home")) {
    await step("home", async () => {
      home = await mod.home({}, ctx);
      const cls = arr(home && home.class);
      if (!cls.length) throw new Error("home: empty class list");
      return { class: cls.length, list: arr(home.list).length, homeListEmpty: arr(home.list).length === 0, filters: Object.keys((home && home.filters) || {}).length, banner: arr(home && home.banner).length };
    });
  }

  if (fns.includes("category")) {
    const cls = arr(home && home.class);
    const tried = [];
    const ids = [];
    for (const c of cls) {
      const id = c && (c.type_id || c.typeId || c.id);
      if (id !== undefined && id !== null && !ids.some((x) => String(x) === String(id))) ids.push(id);
      if (ids.length >= 4) break;
    }
    if (!ids.length) ids.push("1");
    let ok = false, lastErr = "category: empty list";
    for (const id of ids) {
      const good = await step("category", async () => {
        cat = await mod.category({ categoryId: String(id), type_id: String(id), page: 1, filters: {} }, ctx);
        const list = arr(cat && cat.list);
        if (!list.length) throw new Error("category: empty list (type_id=" + id + ")");
        return { type_id: String(id), list: list.length, pagecount: cat && cat.pagecount, total: cat && cat.total };
      });
      tried.push(String(id));
      if (good) { ok = true; break; }
      lastErr = out.steps.category.err;
    }
    if (!ok) {
      const prev = out.steps.category || {};
      out.steps.category = { ok: false, ms: prev.ms || 0, err: lastErr, tried, unsupported: prev.unsupported, logHint: prev.logHint };
    } else {
      out.steps.category.note.tried = tried;
    }
  }

  const pool = arr(cat && cat.list).length ? cat.list : arr(home && home.list);
  const keyword = pickKeyword(pool);

  if (fns.includes("search")) {
    // 站点首条标题常常是"歌单/合集"式长串（含 丨、·、~ 等分隔符），搜索索引里查不到，
    // 会造成假阴性（实例：芸芸音乐 category 首条「华语经典丨不容错过的神级…」搜不到，
    // 换成「华语经典」即 30 条）。因此按"原词 → 截断 → 更短"依次重试。
    const variants = keywordVariants(keyword, pool);
    const attempts = [];
    let ok = false;
    for (const kw of variants) {
      const good = await step("search", async () => {
        search = await mod.search({ keyword: kw, page: 1, quick: false }, ctx);
        const list = arr(search && search.list);
        if (!list.length) throw new Error("search: empty list for keyword=" + kw);
        return { keyword: kw, list: list.length, pagecount: search && search.pagecount };
      });
      attempts.push(kw);
      if (good) {
        ok = true;
        out.steps.search.note.tried = attempts;
        break;
      }
    }
    if (!ok) {
      const prev = out.steps.search || {};
      out.steps.search = { ok: false, ms: prev.ms || 0, err: `search: empty list for tried=${attempts.join(" / ")}`, tried: attempts, unsupported: prev.unsupported, logHint: prev.logHint };
    }
  }

  if (fns.includes("detail")) {
    await step("detail", async () => {
      const cand = arr(search && search.list).length ? search.list : arr(cat && cat.list).length ? cat.list : arr(home && home.list);
      if (!cand.length) throw new Error("detail: no candidate videoId (search+category+home all empty)");
      const vid = cand[0].vod_id || cand[0].videoId || cand[0].id;
      if (!vid) throw new Error("detail: candidate has no vod_id");
      detail = await mod.detail({ videoId: String(vid) }, ctx);
      const item = arr(detail && detail.list)[0];
      if (!item) throw new Error("detail: empty list for videoId=" + vid);
      const srcs = arr(item.vod_play_sources);
      const ep = srcs.reduce((n, s) => n + arr(s && s.episodes).length, 0);
      if (!srcs.length || !ep) throw new Error("detail: no playable episodes (sources=" + srcs.length + ", episodes=" + ep + ")");
      return { name: String(item.vod_name || "").slice(0, 40), sources: srcs.length, episodes: ep };
    });
  }

  if (fns.includes("play")) {
    await step("play", async () => {
      const item = arr(detail && detail.list)[0];
      const srcs = arr(item && item.vod_play_sources);
      const episodes = srcs.flatMap((s) => arr(s && s.episodes));
      if (!episodes.length) throw new Error("play: no episode from detail");
      const ep = episodes[0];
      play = await mod.play({ playId: ep.playId, flag: ep.name || "" }, ctx);
      const urls = arr(play && play.urls);
      const first = (urls[0] && urls[0].url) || (typeof (play && play.url) === "string" ? play.url : "");
      if (!first) throw new Error("play: empty urls");
      return { url: String(first).slice(0, 120), n: urls.length, parse: play && play.parse };
    });
  }

  const s = out.steps;
  const failed = (k) => s[k] && !s[k].ok;
  const hard = (k) => failed(k) && !s[k].unsupported;
  const soft = (k) => failed(k) && s[k].unsupported;
  const cfg = (k) => failed(k) && CONFIG_REQUIRED.test(String(s[k].err || ""));
  // 站点的网络层是否已经不正常（连不上 / 5xx）。这种情况即使脚本读 env 变量，也是站点故障而不是"没填配置"。
  const reqs = (() => {
    let all = [];
    try { all = all.concat(require(path.join(__dirname, "shims", "omnibox_sdk", "index.js")).__reqs || []); } catch (_) {}
    // 走 axios 的脚本由 probe/axios-patch.js 记录（transport=axios），不并进来会漏判网络故障。
    try { all = all.concat(require("./axios-patch").REQS || []); } catch (_) {}
    return all;
  })();
  const netDead = reqs.some((r) => {
    const st = Number(r.status || 0);
    const u = String(r.url || "");
    return !/127\.0\.0\.1|localhost/.test(u) && (st === 0 || st >= 400);
  });
  // home 只要返回非空 class 就算通过，但很多死站会吐硬编码分类却不给任何条目（list=0）
  out.homeEmptyList = !!(s.home && s.home.ok && s.home.note && s.home.note.homeListEmpty);
  if (!out.loadOk) out.verdict = "broken";
  else if (cfg("home") || cfg("category")) out.verdict = "config";
  // 判为"配置型"的前提：脚本因为缺配置**根本没发出请求**（reqs=0）。一旦它真的请求了外站
  // 又拿不到数据，那就是站点问题，不能赖到配置头上（否则会把 403/522 的死站误标成"没填配置"）。
  else if (!netDead && reqs.length === 0 && out.needsConfig && (hard("home") || hard("category"))) out.verdict = "config";
  else if (hard("home") || hard("category")) out.verdict = "broken";
  else if (hard("detail")) out.verdict = "broken";
  else if (soft("detail") || soft("play")) out.verdict = "unverifiable";
  else if (soft("category") || soft("home")) out.verdict = "unverifiable";
  else if (hard("search") || hard("play")) out.verdict = "partial";
  else out.verdict = "ok";
  emit();
})().catch((e) => { out.loadErr = out.loadErr || errStr(e); emit(); });

function emit() {
  try { const sdk = require("omnibox_sdk"); out.reqs = [...(sdk.__reqs || []), ...(global.__AXIOS_REQS || [])].slice(-14); } catch (_) {}
  process.stdout.write("PROBE_JSON:" + JSON.stringify(out) + "\n");
  process.exit(0);
}
