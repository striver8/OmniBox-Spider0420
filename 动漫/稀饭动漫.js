// @name 稀饭动漫
// @author 梦
// @description 刮削：已接入，弹幕：未接入，嗅探：官方播放签发接口直取多线路地址（Next 站点数据源）
// @dependencies none
// @version 2.0.0
// @downloadURL https://gh-proxy.org/https://github.com/Silent1566/OmniBox-Spider/raw/refs/heads/main/%E5%8A%A8%E6%BC%AB/%E7%A8%80%E9%A5%AD%E5%8A%A8%E6%BC%AB.js

/**
 * ============================================================================
 * 稀饭动漫（next.xifanacg.com）
 *
 * 站点整站已从 dm.xifanacg.com 的 PHP 版（/index.php/ds_api/vod）迁移到
 * Next.js App Router + Supabase 后端，旧接口全部 404。新链路：
 *   1. 列表/详情数据：Supabase PostgREST  https://api.xifanacg.com/rest/v1/{animes,episodes,anime_types}
 *      - anon publishable key 随前端 bundle 下发，读权限对 animes/episodes/anime_types 开放
 *      - 分页用 limit/offset，总数取响应的 content-range: 0-23/2877
 *   2. 播放地址：Edge Function  POST https://api.xifanacg.com/functions/v1/issue-web-playback
 *      body {action:"fallback", episode_id}，返回 candidates[] 多条线路的签名直链（带 sign/t 过期）
 *   3. 播放页 /anime/{id}/play/{episodeId}?source=xxx 只渲染播放器外壳，HTML 内无 m3u8/mp4
 *
 * 分类：1 连载新番 / 2 完结旧番 / 3 剧场版 / 4 美漫（anime_types 表可动态取）
 * ============================================================================
 */

const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");

const BASE_URL = "https://next.xifanacg.com";
const API_BASE = "https://api.xifanacg.com";
const SB_KEY = "sb_publishable_OBIVAWACIX6lPXrO98_z24_HcsmalkA";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

const PAGE_SIZE = 24;
const FALLBACK_CLASS = [
  { type_id: "1", type_name: "连载新番" },
  { type_id: "2", type_name: "完结旧番" },
  { type_id: "3", type_name: "剧场版" },
  { type_id: "4", type_name: "美漫" }
];

function _json(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

async function _log(level, msg, extra) {
  const suffix = typeof extra === "undefined" ? "" : ` | ${_json(extra)}`;
  try {
    await OmniBox.log(level, `[稀饭动漫] ${msg}${suffix}`);
  } catch (_) {
    /* 无日志通道时静默 */
  }
}

function _bodyText(res) {
  const body = res && res.body !== undefined ? res.body : res;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  if (body && typeof body === "object") return JSON.stringify(body);
  return String(body == null ? "" : body);
}

function _status(res) {
  if (!res) return 0;
  const n = Number(res.statusCode !== undefined ? res.statusCode : res.status);
  return Number.isFinite(n) ? n : 0;
}

function _header(res, name) {
  const h = res && res.headers;
  if (!h) return "";
  const key = String(name).toLowerCase();
  if (typeof h.get === "function") {
    const v = h.get(name) || h.get(key);
    if (v) return String(v);
  }
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === key) return String(h[k]);
  }
  return "";
}

// PostgREST 需要保留 * ( ) . , 这些操作符字符，其余可编码
function _enc(s) {
  return encodeURIComponent(String(s))
    .replace(/%2A/g, "*")
    .replace(/%28/g, "(")
    .replace(/%29/g, ")")
    .replace(/%2C/g, ",")
    .replace(/%2E/g, ".");
}

async function _rest(table, params, opts) {
  const o = opts || {};
  const qs = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== "")
    .map((k) => `${k}=${_enc(params[k])}`)
    .join("&");
  const url = `${API_BASE}/rest/v1/${table}${qs ? "?" + qs : ""}`;
  const res = await OmniBox.request(url, {
    method: "GET",
    headers: {
      "User-Agent": UA,
      "apikey": SB_KEY,
      "Authorization": `Bearer ${SB_KEY}`,
      "Accept": "application/json",
      "Prefer": o.count ? "count=exact" : "count=none"
    },
    timeout: 20000
  });
  const status = _status(res);
  const text = _bodyText(res);
  if (status && status !== 200 && status !== 206) {
    throw new Error(`REST ${table} HTTP ${status}: ${text.slice(0, 120)}`);
  }
  let rows = [];
  try {
    rows = JSON.parse(text);
  } catch (e) {
    throw new Error(`REST ${table} 非 JSON 响应`);
  }
  let total = 0;
  if (o.count) {
    const range = _header(res, "content-range");
    const m = String(range).match(/\/(\d+)$/);
    if (m) total = Number(m[1]) || 0;
  }
  return { rows: Array.isArray(rows) ? rows : [], total };
}

async function _issuePlayback(episodeId) {
  const res = await OmniBox.request(`${API_BASE}/functions/v1/issue-web-playback`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "apikey": SB_KEY,
      "Authorization": `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      "Origin": BASE_URL,
      "Referer": BASE_URL + "/"
    },
    body: JSON.stringify({ action: "fallback", episode_id: Number(episodeId) || episodeId }),
    timeout: 25000
  });
  const status = _status(res);
  const text = _bodyText(res);
  if (status && status !== 200) throw new Error(`签发接口 HTTP ${status}: ${text.slice(0, 120)}`);
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new Error("签发接口返回非 JSON");
  }
  if (!data || data.ok !== true) throw new Error(`签发失败: ${(data && data.error) || "unknown"}`);
  return data;
}

// ---------------- 数据映射 ----------------

function _vodFromAnime(a) {
  if (!a || a.id === undefined || a.id === null) return null;
  const remarks = String(a.remarks || "").trim()
    || (a.total_episodes ? `共${a.total_episodes}话` : (a.is_finished ? "已完结" : "连载中"));
  return {
    vod_id: String(a.id),
    vod_name: String(a.title || "").trim(),
    vod_pic: a.cover_url || "",
    vod_remarks: remarks,
    vod_year: a.release_year ? String(a.release_year) : "",
    vod_area: a.region || "",
    vod_douban_score: a.bangumi_score ? String(a.bangumi_score) : "",
    vod_content: String(a.description || "").trim(),
    type_id: a.type_id !== undefined && a.type_id !== null ? String(a.type_id) : "",
    type_name: ""
  };
}

function _mapList(rows) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const vod = _vodFromAnime(row);
    if (!vod || !vod.vod_name) continue;
    if (seen.has(vod.vod_id)) continue;
    seen.add(vod.vod_id);
    out.push(vod);
  }
  return out;
}

function _encPlayId(episodeId, episodeName) {
  return JSON.stringify({ e: Number(episodeId) || episodeId, n: episodeName || "" });
}

function _decPlayId(raw) {
  let meta = null;
  try {
    meta = JSON.parse(raw);
  } catch (_) {
    meta = null;
  }
  if (meta && typeof meta === "object") {
    const id = meta.e !== undefined ? meta.e : meta.episode_id !== undefined ? meta.episode_id : meta.id;
    if (id !== undefined && id !== null && id !== "") {
      return { episode_id: id, name: String(meta.n || meta.name || "") };
    }
  }
  if (/^\d+$/.test(String(raw))) return { episode_id: Number(raw), name: "" };
  return null;
}

function _episodeLabel(ep) {
  const num = ep.episode_number;
  const title = String(ep.title || "").trim();
  if (num !== undefined && num !== null && num !== "") {
    const n = Number(num);
    const base = Number.isInteger(n) ? `第${n}话` : `第${n}话`;
    return title ? `${base} ${title}` : base;
  }
  return title || `剧集${ep.id}`;
}

// ---------------- 五个 handler ----------------

async function home() {
  let classList = FALLBACK_CLASS;
  try {
    const { rows } = await _rest("anime_types", {
      select: "id,legacy_type_id,name,slug,sort_order,is_active",
      "is_active": "eq.true",
      order: "sort_order.asc"
    });
    const mapped = rows
      .map((t) => ({ type_id: String(t.legacy_type_id || t.id || ""), type_name: String(t.name || "") }))
      .filter((t) => t.type_id && t.type_name);
    if (mapped.length) classList = mapped;
  } catch (e) {
    await _log("warn", "分类表读取失败，用内置分类", String(e && e.message || e));
  }

  let list = [];
  try {
    const { rows } = await _rest("animes", {
      select: "id,title,cover_url,remarks,release_year,region,total_episodes,current_episodes,is_finished,type_id,bangumi_score",
      "is_published": "eq.true",
      order: "updated_at.desc",
      limit: PAGE_SIZE * 2
    });
    list = _mapList(rows);
  } catch (e) {
    await _log("error", "home 列表失败", String(e && e.message || e));
  }

  await _log("info", "home 完成", { classCount: classList.length, listCount: list.length });
  return { class: classList, list };
}

async function category(params) {
  const p = params || {};
  const typeId = String(p.type_id || p.typeId || p.cat_id || p.categoryId || "").trim();
  const page = Math.max(1, Number(p.page || p.pageNum || 1) || 1);
  const pageSize = Math.max(1, Number(p.page_size || p.limit || PAGE_SIZE) || PAGE_SIZE);
  const offset = (page - 1) * pageSize;

  const query = {
    select: "id,title,cover_url,remarks,release_year,region,total_episodes,current_episodes,is_finished,type_id,bangumi_score",
    "is_published": "eq.true",
    order: "updated_at.desc",
    limit: pageSize,
    offset
  };
  if (typeId) query["type_id"] = `eq.${typeId}`;

  try {
    const { rows, total } = await _rest("animes", query, { count: true });
    const list = _mapList(rows);
    const pagecount = total > 0 ? Math.max(1, Math.ceil(total / pageSize)) : (list.length >= pageSize ? page + 1 : page);
    await _log("info", "category 完成", { typeId, page, total, listCount: list.length });
    return { page, pagecount, limit: pageSize, total: total || list.length, list };
  } catch (e) {
    await _log("error", "category 失败", { typeId, page, err: String(e && e.message || e) });
    return { page, pagecount: page, limit: pageSize, total: 0, list: [] };
  }
}

async function detail(params) {
  const p = params || {};
  const id = String(p.videoId || p.vod_id || p.id || "").trim();
  if (!id) return { list: [] };

  try {
    const { rows } = await _rest("animes", {
      select: "*",
      id: `eq.${id}`,
      limit: 1
    });
    const anime = rows[0];
    if (!anime) throw new Error("anime 不存在");

    const vod = _vodFromAnime(anime) || { vod_id: id, vod_name: id, vod_pic: "", vod_remarks: "", vod_content: "" };
    const meta = [];
    if (anime.release_date) meta.push(`首播 ${anime.release_date}`);
    else if (anime.release_year) meta.push(`年份 ${anime.release_year}`);
    if (anime.region) meta.push(anime.region);
    if (anime.total_episodes) meta.push(`共${anime.total_episodes}话`);
    if (anime.status === undefined && anime.is_finished) meta.push(anime.is_finished ? "已完结" : "");
    const extras = [];
    if (anime.director) extras.push(`导演：${anime.director}`);
    if (Array.isArray(anime.actors) && anime.actors.length) extras.push(`声优：${anime.actors.slice(0, 6).join("、")}`);
    if (Array.isArray(anime.aliases) && anime.aliases.length) extras.push(`别名：${anime.aliases.slice(0, 3).join(" / ")}`);
    vod.vod_content = [meta.filter(Boolean).join(" · "), String(anime.description || "").trim(), extras.join("\n")]
      .filter(Boolean)
      .join("\n");

    const { rows: eps } = await _rest("episodes", {
      select: "id,episode_number,title,kind,release_date",
      anime_id: `eq.${id}`,
      order: "episode_number.asc,id.asc",
      limit: 3000
    });

    const episodes = (eps || []).map((ep) => {
      const label = _episodeLabel(ep);
      return { name: label, playId: _encPlayId(ep.id, label) };
    });
    if (!episodes.length) {
      episodes.push({ name: "正片", playId: _encPlayId("", "正片") });
    }

    await _log("info", "detail 完成", { id, name: vod.vod_name, episodes: episodes.length });
    return {
      list: [
        {
          ...vod,
          vod_play_from: "稀饭动漫",
          vod_play_url: episodes.map((it) => `${it.name}$${it.playId}`).join("#"),
          vod_play_sources: [{ name: "稀饭动漫", episodes }]
        }
      ]
    };
  } catch (e) {
    await _log("error", "detail 失败", { id, err: String(e && e.message || e) });
    return { list: [] };
  }
}

async function search(params) {
  const p = params || {};
  const wd = String(p.wd || p.keyword || p.keywords || p.searchKey || "").trim();
  const page = Math.max(1, Number(p.page || 1) || 1);
  const pageSize = Math.max(1, Number(p.page_size || p.limit || PAGE_SIZE) || PAGE_SIZE);
  if (!wd) return { list: [] };

  const or = `(title.ilike.*${wd}*,title_original.ilike.*${wd}*,search_title.ilike.*${wd}*)`;
  try {
    const { rows } = await _rest("animes", {
      select: "id,title,cover_url,remarks,release_year,region,total_episodes,is_finished,type_id,bangumi_score",
      "is_published": "eq.true",
      or,
      order: "updated_at.desc",
      limit: pageSize,
      offset: (page - 1) * pageSize
    });
    const list = _mapList(rows);
    await _log("info", "search 完成", { wd, page, listCount: list.length });
    return { list };
  } catch (e) {
    await _log("error", "search 失败", { wd, err: String(e && e.message || e) });
    return { list: [] };
  }
}

async function play(params) {
  const p = params || {};
  const raw = String(p.playId || p.play_id || p.url || p.id || "").trim();

  try {
    if (!raw) throw new Error("播放标识为空");
    if (/\.(m3u8|mp4|flv)(\?|$)/i.test(raw)) {
      return {
        parse: 0,
        flag: "xifan",
        url: raw,
        urls: [{ name: "直链播放", url: raw }],
        header: { "User-Agent": UA, "Referer": BASE_URL + "/" },
        headers: { "User-Agent": UA, "Referer": BASE_URL + "/" }
      };
    }

    const meta = _decPlayId(raw);
    if (!meta || !meta.episode_id) throw new Error("无法解析 episode_id");

    const data = await _issuePlayback(meta.episode_id);
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    const urls = [];
    const seen = new Set();
    for (const c of candidates) {
      const url = String(c && c.url || "").trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      urls.push({ name: String(c.source_name || c.source_code || "线路"), url });
    }
    if (!urls.length && data.url) urls.push({ name: "默认线路", url: String(data.url) });

    if (!urls.length) throw new Error("签发接口未返回地址");

    const headers = {
      "User-Agent": UA,
      "Referer": BASE_URL + "/",
      "Origin": BASE_URL
    };
    await _log("info", "play 完成", { episodeId: meta.episode_id, urls: urls.length, expiresAt: data.expires_at });
    return {
      parse: 0,
      flag: "xifan",
      url: urls.length === 1 ? urls[0].url : undefined,
      urls,
      header: headers,
      headers
    };
  } catch (e) {
    await _log("error", "play 失败", { raw: String(raw).slice(0, 120), err: String(e && e.message || e) });
    const fallbackUrl = /^https?:\/\//i.test(raw) ? raw : BASE_URL + "/";
    const headers = { "User-Agent": UA, "Referer": BASE_URL + "/" };
    return {
      parse: 1,
      flag: "xifan",
      url: fallbackUrl,
      urls: [{ name: "页面播放", url: fallbackUrl }],
      header: headers,
      headers
    };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
