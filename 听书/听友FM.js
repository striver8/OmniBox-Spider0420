// @name 听友FM
// @author OmniBox助手
// @version 2.0.0
// @downloadURL https://gh-proxy.org/https://github.com/Silent1566/OmniBox-Spider/raw/refs/heads/main/听书/听友FM.js
// notes:
// 1) 2026-11 站点整站改版：旧版 /categories/<id>、/albums/<id> 与 /index.php 系列全部下线。
//    新版听书播放站为 https://tingyou.fm/listening（Nuxt），内容接口是一组免登录的 H5 明文 JSON 接口。
// 2) 本版不再使用页面解析与加密信封，直接调用 H5 接口：
//    GET  /api/h5/listening/rank?section=latest|hot&page=N                 榜单/首页
//    GET  /api/h5/listening/filters                                        分类与排序元数据
//    GET  /api/h5/listening/category?category=<catId>&type=<typeId>&sort=&status=&page=N
//    GET  /api/h5/listening/album/<albumId>                                专辑详情
//    GET  /api/h5/listening/chapters/<albumId>                             章节目录（一次全量）
//    POST /api/h5/listening/search {keyword,page}                          搜索
//    POST /api/h5/listening/play   {album_id,chapter_idx}                  单章音频直链（返回 {play_url}）
// 3) 必需请求头：x-listening-timezone、x-listening-session（UUIDv4，可任意生成）。
//    接口按「域名轮换」部署，不同线路的可用路径不同（例如 filters 只在部分线路可用），
//    因此统一走 API_HOSTS 顺序探测与故障切换。

const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");

const SITE = "https://tingyou.fm";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

// 站点按域名轮换部署同一套接口，按顺序探测可用线路
const API_HOSTS = [
  "https://appp.fdhtbz.cn/api",
  "https://ffggewvge.dasfrvvbbhhafdgserqw.cc/api",
  "https://fsfggqwewrr.dsafasfvvaaee.cc/api"
];

const PAGE_SIZE = 20;
const SESSION_CACHE_KEY = "tingyou:h5_session";
const HOST_CACHE_KEY = "tingyou:api_host";
const HOST_CACHE_TTL = 1800; // 线路缓存 30 分钟

const DEFAULT_CLASS = [
  { type_id: "rank:latest", type_name: "最新上架" },
  { type_id: "rank:hot", type_name: "热门榜" },
  { type_id: "cat:2", type_name: "有声小说" },
  { type_id: "cat:1", type_name: "评书" }
];

const SORT_MAP = {
  comprehensive: "comprehensive",
  popular: "popular",
  updated: "updated",
  new: "new"
};

function text(v) {
  return String(v == null ? "" : v).trim();
}

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function log(level, msg) {
  try {
    if (OmniBox && typeof OmniBox.log === "function") OmniBox.log(level, msg);
  } catch (e) {
    /* ignore */
  }
}

function pickCover(item) {
  const url = text(item && item.cover_url);
  return /^https?:\/\//i.test(url) ? url : "";
}

function mapVod(item) {
  if (!item) return null;
  const id = text(item.id);
  if (!id) return null;
  const count = num(item.count);
  const status = num(item.status, -1);
  const typeName = text(item.type);
  const catName = text(item.cat);
  const statusText = status === 0 ? "完结" : status === 1 ? "连载" : "";
  const remarks = [count ? `${count}集` : "", statusText].filter(Boolean).join(" · ");
  return {
    vod_id: id,
    vod_name: text(item.title) || "未命名专辑",
    vod_pic: pickCover(item),
    vod_remarks: remarks,
    vod_content: text(item.synopsis || item.intro || item.description),
    vod_actor: text(item.teller || item.author),
    vod_area: catName || typeName,
    vod_year: "",
    type_name: typeName,
    cat_name: catName
  };
}

function mapList(items) {
  const arr = Array.isArray(items) ? items : [];
  return arr.map(mapVod).filter(Boolean);
}

function makeSessionId() {
  try {
    const c = require("crypto");
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
  } catch (e) {
    /* ignore */
  }
  // 退化为符合 UUIDv4 形态的随机串
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 32; i += 1) out += hex[Math.floor(Math.random() * 16)];
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-4${out.slice(13, 16)}-a${out.slice(17, 20)}-${out.slice(20, 32)}`;
}

let sessionId = "";
async function getSessionId() {
  if (sessionId) return sessionId;
  try {
    const cached = await OmniBox.getCache(SESSION_CACHE_KEY);
    if (cached && /^[0-9a-f-]{36}$/i.test(String(cached))) {
      sessionId = String(cached);
      return sessionId;
    }
  } catch (e) {
    /* ignore */
  }
  sessionId = makeSessionId();
  try {
    await OmniBox.setCache(SESSION_CACHE_KEY, sessionId, 604800);
  } catch (e) {
    /* ignore */
  }
  return sessionId;
}

async function buildHeaders(extra = {}) {
  const sid = await getSessionId();
  return {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "x-listening-timezone": process.env.TINGYOU_TIMEZONE || "Asia/Shanghai",
    "x-listening-session": sid,
    Origin: SITE,
    Referer: `${SITE}/`,
    ...extra
  };
}

let activeHost = "";
async function getActiveHost() {
  if (activeHost) return activeHost;
  try {
    const cached = await OmniBox.getCache(HOST_CACHE_KEY);
    if (cached && API_HOSTS.includes(String(cached))) {
      activeHost = String(cached);
      return activeHost;
    }
  } catch (e) {
    /* ignore */
  }
  return "";
}

async function rememberHost(host) {
  if (!host || activeHost === host) return;
  activeHost = host;
  try {
    await OmniBox.setCache(HOST_CACHE_KEY, host, HOST_CACHE_TTL);
  } catch (e) {
    /* ignore */
  }
}

function candidateHosts() {
  const cached = activeHost;
  const list = API_HOSTS.filter((h) => h !== cached);
  return cached ? [cached, ...list] : list;
}

async function requestRaw(host, path, options = {}) {
  const method = options.method || "GET";
  let url = `${host}${path}`;
  if (method === "GET" && options.query) {
    const qs = new URLSearchParams(options.query).toString();
    if (qs) url += `${path.includes("?") ? "&" : "?"}${qs}`;
  }
  const headers = await buildHeaders(options.headers || {});
  const conf = { method, headers };
  if (method !== "GET" && options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    conf.body = JSON.stringify(options.body);
  }
  const res = await OmniBox.request(url, conf);
  const status = num(res && (res.statusCode || res.status), 0);
  const body = typeof res.body === "string" ? res.body : "";
  let json = null;
  try {
    json = JSON.parse(body);
  } catch (e) {
    json = null;
  }
  return { status, body, json, url };
}

// 按线路顺序请求；HTTP 层异常或非 JSON 响应时切到下一条线路
async function apiRequest(path, options = {}) {
  const hosts = candidateHosts();
  let lastErr = null;
  for (const host of hosts) {
    try {
      const r = await requestRaw(host, path, options);
      if (r.status === 200 && r.json) {
        await rememberHost(host);
        return r.json;
      }
      lastErr = new Error(`HTTP ${r.status} @ ${host}${path}`);
      log("warn", `[api] ${lastErr.message}`);
    } catch (e) {
      lastErr = e;
      log("warn", `[api] ${e.message} @ ${host}${path}`);
    }
  }
  throw lastErr || new Error(`接口不可用: ${path}`);
}

async function apiGet(path, query) {
  return apiRequest(path, { method: "GET", query });
}

async function apiPost(path, body) {
  return apiRequest(path, { method: "POST", body });
}

function parseClassId(typeId) {
  const raw = text(typeId) || "rank:latest";
  const m = raw.match(/^([a-z]+):(.+)$/i);
  if (!m) return { kind: "cat", catId: raw, typeId: "" };
  const kind = m[1].toLowerCase();
  const value = m[2];
  if (kind === "rank") return { kind: "rank", section: value === "hot" ? "hot" : "latest" };
  if (kind === "type") {
    const [catId, tId] = value.split("-");
    return { kind: "cat", catId: text(catId), typeId: text(tId) };
  }
  return { kind: "cat", catId: value, typeId: "" };
}

async function fetchFilters() {
  try {
    const json = await apiGet("/h5/listening/filters");
    return json || {};
  } catch (e) {
    log("warn", `[filters] ${e.message}`);
    return {};
  }
}

async function buildClassList() {
  const filters = await fetchFilters();
  const sorts = Array.isArray(filters.sorts) ? filters.sorts : [];
  const categories = Array.isArray(filters.categories) ? filters.categories : [];
  const classList = [
    { type_id: "rank:latest", type_name: "最新上架" },
    { type_id: "rank:hot", type_name: "热门榜" }
  ];
  for (const cat of categories) {
    const catId = text(cat.id);
    if (!catId) continue;
    classList.push({ type_id: `cat:${catId}`, type_name: text(cat.name) || `分类${catId}` });
    const types = Array.isArray(cat.types) ? cat.types : [];
    for (const t of types) {
      const tid = text(t.id);
      const tname = text(t.name);
      if (!tid || !tname) continue;
      classList.push({ type_id: `type:${catId}-${tid}`, type_name: `　${tname}` });
    }
  }
  if (classList.length <= 2) return DEFAULT_CLASS;
  return classList;
}

async function home(params, context) {
  try {
    const classList = await buildClassList();
    let list = [];
    try {
      const json = await apiGet("/h5/listening/rank", { section: "latest", page: 1 });
      list = mapList(json.items || json.data);
    } catch (e) {
      log("warn", `[home] rank 失败 ${e.message}`);
    }
    if (!list.length) {
      const json = await apiGet("/h5/listening/category", { page: 1 });
      list = mapList(json.data);
    }
    return {
      class: classList,
      list: list.slice(0, 24),
      filters: {}
    };
  } catch (e) {
    log("error", `[home] ${e.message}`);
    return { class: DEFAULT_CLASS, list: [], filters: {} };
  }
}

async function category(params, context) {
  const page = Math.max(num(params && params.page, 1), 1);
  const spec = parseClassId(params && (params.categoryId || params.type_id || params.category_id));
  const sort = SORT_MAP[text(params && (params.sort || params.orderby))] || "comprehensive";
  const statusRaw = text(params && (params.status || params.area));
  const query = { page: String(page) };
  try {
    if (spec.kind === "rank") {
      const json = await apiGet("/h5/listening/rank", { section: spec.section, page: String(page) });
      const list = mapList(json.items || json.data);
      const hasMore = json.has_more !== false;
      return {
        page,
        pagecount: hasMore ? page + 1 : page,
        total: list.length,
        list
      };
    }
    query.category = spec.catId;
    if (spec.typeId) query.type = spec.typeId;
    if (statusRaw && /^[01]$/.test(statusRaw)) query.status = statusRaw;
    query.sort = sort;
    query.refresh = "false";
    const json = await apiGet("/h5/listening/category", query);
    const list = mapList(json.data || json.items);
    const pages = num(json.pages, 0);
    const pagecount = pages > 0 ? pages : list.length ? page : 0;
    return {
      page,
      pagecount,
      total: pages > 0 ? pages * PAGE_SIZE : list.length,
      list
    };
  } catch (e) {
    log("error", `[category] ${e.message}`);
    return { page, pagecount: 0, total: 0, list: [] };
  }
}

async function detail(params, context) {
  try {
    const vid = text(params && params.videoId);
    if (!vid) return { list: [] };
    const album = await apiGet(`/h5/listening/album/${encodeURIComponent(vid)}`);
    const vod = mapVod(album) || { vod_id: vid, vod_name: "", vod_pic: "", vod_remarks: "" };
    vod.vod_id = vid;

    let chapters = [];
    try {
      const chJson = await apiGet(`/h5/listening/chapters/${encodeURIComponent(vid)}`);
      chapters = Array.isArray(chJson.chapters) ? chJson.chapters.slice() : [];
    } catch (e) {
      log("warn", `[detail] chapters 失败 ${e.message}`);
    }
    chapters.sort((a, b) => num(a.index) - num(b.index));

    const episodes = chapters.map((ch) => {
      const index = num(ch.index, 0);
      const title = text(ch.title);
      const label = title || `第${index}章`;
      const duration = num(ch.duration, 0);
      return {
        name: duration ? `${label}（${Math.round(duration / 60)}分）` : label,
        playId: JSON.stringify({ a: vid, i: index })
      };
    });

    if (!episodes.length) {
      // 目录接口异常时至少给出首章，避免详情页空白
      episodes.push({ name: "第1章", playId: JSON.stringify({ a: vid, i: 1 }) });
    }

    vod.vod_play_sources = [{ name: "听友FM", episodes }];
    vod.vod_play_from = "听友FM";
    vod.vod_play_url = episodes.map((ep) => `${ep.name}$${ep.playId}`).join("#");
    return { list: [vod] };
  } catch (e) {
    log("error", `[detail] ${e.message}`);
    return { list: [] };
  }
}

async function search(params, context) {
  const page = Math.max(num(params && params.page, 1), 1);
  const keyword = text(params && (params.keyword || params.key || params.wd));
  if (!keyword) return { page, pagecount: 0, total: 0, list: [] };
  try {
    const json = await apiPost("/h5/listening/search", { keyword, page });
    const raw = Array.isArray(json.results) ? json.results : json.items;
    const list = mapList(raw);
    const hasMore = json.has_more === true;
    return {
      page,
      pagecount: hasMore ? page + 1 : page,
      total: list.length,
      list
    };
  } catch (e) {
    log("error", `[search] ${e.message}`);
    return { page, pagecount: 0, total: 0, list: [] };
  }
}

async function play(params, context) {
  const playId = text(params && params.playId);
  const flag = text(params && params.flag) || "听友FM";
  const header = { "User-Agent": UA, Referer: `${SITE}/` };
  try {
    if (!playId) throw new Error("playId 为空");
    let albumId = "";
    let chapterIdx = 0;
    try {
      const info = JSON.parse(playId);
      albumId = text(info.a || info.album_id);
      chapterIdx = num(info.i || info.chapter_idx, 0);
    } catch (e) {
      const parts = playId.split("@");
      albumId = text(parts[0]);
      chapterIdx = num(parts[1], 0);
    }
    if (!albumId) throw new Error(`playId 无法解析: ${playId}`);

    const json = await apiPost("/h5/listening/play", { album_id: albumId, chapter_idx: chapterIdx });
    const url = text(json.play_url || json.url);
    if (!url) throw new Error(`未返回播放地址: ${JSON.stringify(json).slice(0, 200)}`);
    return {
      urls: [{ name: flag, url }],
      header,
      parse: 0,
      flag
    };
  } catch (e) {
    log("error", `[play] ${e.message}`);
    return { urls: [], header, parse: 1, flag };
  }
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
