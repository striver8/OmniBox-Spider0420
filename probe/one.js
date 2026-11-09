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
const UNSUPPORTED = /unavailable|not implemented|probe: .*stub/i;

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const r = await withTimeout(fn(), STEP_MS, name);
    out.steps[name] = { ok: true, ms: Date.now() - t0, note: r };
    return true;
  } catch (e) {
    const msg = errStr(e);
    const bad = UNSUPPORTED.test(msg);
    out.steps[name] = { ok: false, ms: Date.now() - t0, err: msg, unsupported: bad };
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
      return { class: cls.length, list: arr(home.list).length, filters: Object.keys((home && home.filters) || {}).length, banner: arr(home && home.banner).length };
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
      out.steps.category = { ok: false, ms: out.steps.category ? out.steps.category.ms : 0, err: lastErr, tried };
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
      const ms = out.steps.search ? out.steps.search.ms : 0;
      out.steps.search = { ok: false, ms, err: `search: empty list for tried=${attempts.join(" / ")}`, tried: attempts };
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
  if (!out.loadOk) out.verdict = "broken";
  else if (hard("home") || hard("category")) out.verdict = "broken";
  else if (hard("detail")) out.verdict = "broken";
  else if (soft("detail") || soft("play")) out.verdict = "unverifiable";
  else if (hard("search") || hard("play")) out.verdict = "partial";
  else out.verdict = "ok";
  emit();
})().catch((e) => { out.loadErr = out.loadErr || errStr(e); emit(); });

function emit() {
  try { const sdk = require("omnibox_sdk"); out.reqs = [...(sdk.__reqs || []), ...(global.__AXIOS_REQS || [])].slice(-14); } catch (_) {}
  process.stdout.write("PROBE_JSON:" + JSON.stringify(out) + "\n");
  process.exit(0);
}
