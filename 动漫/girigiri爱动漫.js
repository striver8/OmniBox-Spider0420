// @name girigiri爱动漫
// @author 梦
// @description 刮削：支持，弹幕：支持，嗅探：官方 JSON 接口（/api.php）直取 m3u8 直链
// @version 2.0.0
// @downloadURL https://gh-proxy.org/https://github.com/Silent1566/OmniBox-Spider/raw/refs/heads/main/动漫/girigiri爱动漫.js

/**
 * ============================================================================
 * girigiri爱动漫
 * 站点：https://ani.girigirilove.com/（旧域 bgm.girigirilove.com 已 301 跳转）
 * 接口：https://m3u8.girigirilove.com/api.php/<Section>/<Action>（ThinkPHP path-info，GET）
 * 分类：日番 / 美番 / 真人番剧 / 剧场版 / BD副音轨 / 演唱会及其他
 *
 * 说明：
 * - 旧版是 MacCMS 页面解析（/show/<id>-----------/ + player_aaaa），站点改版为
 *   Vite + React SPA，HTML 里没有片子，全部数据由 /api.php 以 JSON 下发，
 *   播放地址也直接在 Vod/get_detail 的 vod_play_url 里，是 akua.girigirilove.com 的 m3u8 直链。
 * - detail 使用新版 vod_play_sources 数组结构，同时保留 vod_play_from/vod_play_url 兼容。
 * ============================================================================
 */
const OmniBox = require("omnibox_sdk");

const SITE_URL = "https://ani.girigirilove.com";
const API_BASE = "https://m3u8.girigirilove.com/api.php";
const IMG_BASE = "https://jpg.girigirilove.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0";
const PAGE_LIMIT = 24;
const HOME_SECTION_LIMIT = 12;
const DANMU_API = process.env.DANMU_API || "";

const CLASS_LIST = [
  { type_id: "2", type_name: "日番" },
  { type_id: "3", type_name: "美番" },
  { type_id: "26", type_name: "演唱会及其他" },
  { type_id: "20", type_name: "真人番剧" },
  { type_id: "21", type_name: "剧场版" },
  { type_id: "24", type_name: "BD副音轨" }
];

// 接口 orderby 取值：''（最新）/ hits（最热）/ score（评分）
const ORDER_MAP = {
  latest: "",
  time: "",
  hits: "hits",
  hot: "hits",
  score: "score",
  rating: "score"
};

function _stringify(data) {
  try {
    return JSON.stringify(data);
  } catch (_) {
    return String(data);
  }
}

async function _log(level, message, extra) {
  const suffix = typeof extra === "undefined" ? "" : ` | ${_stringify(extra)}`;
  try {
    await OmniBox.log(level, `[girigiri爱动漫] ${message}${suffix}`);
  } catch (_) {
    /* 探针/宿主无日志通道时静默 */
  }
}

function _bodyText(res) {
  const body = res && res.body !== undefined ? res.body : res;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  if (typeof body === "object" && body !== null) return JSON.stringify(body);
  return String(body == null ? "" : body);
}

function _statusOf(res) {
  if (!res) return 0;
  const raw = res.statusCode !== undefined ? res.statusCode : res.status;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

// ---------- 官方接口 ----------

function _queryString(query) {
  const parts = [];
  for (const key of Object.keys(query || {})) {
    const value = query[key];
    // 空值必须整条省略：站点把空的 type_id 当成有效筛选条件，会命中 0 条
    if (value === undefined || value === null) continue;
    const text = String(value);
    if (text === "") continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(text)}`);
  }
  return parts.join("&");
}

async function _apiGet(action, query) {
  const qs = _queryString(query);
  const url = `${API_BASE}/${action}${qs ? `?${qs}` : ""}`;
  const res = await OmniBox.request(url, {
    method: "GET",
    headers: {
      "User-Agent": UA,
      "Accept": "application/json, text/plain, */*",
      "Referer": `${SITE_URL}/`,
      "Origin": SITE_URL
    },
    timeout: 20000
  });

  const status = _statusOf(res);
  const text = _bodyText(res);
  if (status && status !== 200) throw new Error(`接口 ${action} HTTP ${status}`);
  if (!text) throw new Error(`接口 ${action} 空响应`);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`接口 ${action} 非 JSON 响应: ${text.slice(0, 120)}`);
  }
  if (!parsed || Number(parsed.code) !== 1) {
    throw new Error(`接口 ${action} 业务失败: ${(parsed && parsed.msg) || "unknown"}`);
  }
  return parsed.info;
}

// 列表（同时用于分类、搜索、首页推荐）
async function _getList(options = {}) {
  const limit = Math.max(1, Number(options.limit) || PAGE_LIMIT);
  const offset = Math.max(0, Number(options.offset) || 0);
  const info = await _apiGet("Vod/get_list", {
    type_id: options.type_id ? String(options.type_id) : "",
    offset,
    limit,
    vod_weekday: "",
    vod_letter: "",
    vod_tag: "",
    vod_name: options.vod_name || "",
    vod_blurb: "",
    vod_area: options.vod_area || "",
    vod_year: options.vod_year || "",
    orderby: options.orderby || "",
    vod_class: options.vod_class || "",
    vod_lang: "",
    vod_version: options.vod_version || "",
    vod_state: options.vod_state || "",
    user_id: ""
  });
  const data = info && typeof info === "object" ? info : {};
  const rows = Array.isArray(data.rows) ? data.rows : [];
  return { rows, total: Number(data.total) || 0, offset, limit };
}

async function _getDetail(vodId) {
  const info = await _apiGet("Vod/get_detail", { vod_id: String(vodId) });
  return info && typeof info === "object" ? info : null;
}

// ---------- 数据映射 ----------

function _absPic(u) {
  const s = String(u || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("//")) return "https:" + s;
  return `${IMG_BASE}/${s.replace(/^\/+/, "")}`;
}

function _stripHtml(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function _toVod(row) {
  if (!row || !row.vod_id) return null;
  const name = String(row.vod_name || "").trim();
  if (!name) return null;
  return {
    vod_id: String(row.vod_id),
    vod_name: name,
    vod_pic: _absPic(row.vod_pic || row.vod_pic_thumb),
    vod_remarks: String(row.vod_remarks || row.vod_sub || "").trim(),
    vod_year: String(row.vod_year || "").trim(),
    vod_area: "",
    vod_actor: String(row.vod_actor || "").replace(/\s*\/\s*/g, " / "),
    vod_director: String(row.vod_director || "").trim(),
    vod_score: String(row.vod_score || "").trim(),
    vod_content: _stripHtml(row.vod_blurb || row.vod_content || "")
  };
}

function _mapList(rows) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const vod = _toVod(row);
    if (!vod || seen.has(vod.vod_id)) continue;
    seen.add(vod.vod_id);
    out.push(vod);
  }
  return out;
}

function _encodePlayId(meta) {
  return JSON.stringify({
    v: String(meta.vod_id || ""),
    f: Number(meta.line) || 0,
    i: Number(meta.index) || 0,
    n: String(meta.name || "")
  });
}

function _decodePlayId(raw) {
  let meta = null;
  try {
    meta = JSON.parse(raw);
  } catch (_) {
    meta = null;
  }
  if (!meta || typeof meta !== "object") return null;
  const vodId = meta.v || meta.vod_id || "";
  if (!vodId) return null;
  return {
    vod_id: String(vodId),
    line: Number(meta.f ?? meta.line ?? 0) || 0,
    index: Number(meta.i ?? meta.index ?? 0) || 0,
    name: String(meta.n || meta.name || "")
  };
}

// 解析 MacCMS 形态的 vod_play_from / vod_play_url
function _parsePlayGroups(info) {
  const froms = String((info && info.vod_play_from) || "").split("$$$");
  const groups = String((info && info.vod_play_url) || "").split("$$$");
  const sources = [];
  for (let gi = 0; gi < groups.length; gi += 1) {
    const raw = groups[gi];
    if (!raw) continue;
    const episodes = [];
    for (const item of raw.split("#")) {
      const text = String(item || "").trim();
      if (!text) continue;
      const pos = text.indexOf("$");
      const epName = pos > 0 ? text.slice(0, pos).trim() : `第${episodes.length + 1}集`;
      const epUrl = pos > 0 ? text.slice(pos + 1).trim() : text;
      if (!epUrl) continue;
      episodes.push({ name: epName || `第${episodes.length + 1}集`, url: epUrl });
    }
    if (!episodes.length) continue;
    sources.push({ name: String(froms[gi] || "").trim() || `线路${sources.length + 1}`, episodes });
  }
  return sources;
}

function _cleanEpisodeName(name) {
  return String(name || "").trim() || "正片";
}

// ---------- 弹幕（可选，DANMU_API 配置后启用） ----------

function _preprocessTitle(title) {
  if (!title) return "";
  return String(title)
    .replace(/4[kK]|[xX]26[45]|720[pP]|1080[pP]|2160[pP]/g, " ")
    .replace(/[hH]\.?26[45]/g, " ")
    .replace(/BluRay|WEB-DL|HDR|REMUX/gi, " ")
    .replace(/\.mp4|\.mkv|\.avi|\.flv/gi, " ");
}

function _chineseToArabic(cn) {
  const map = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (!isNaN(cn)) return parseInt(cn, 10);
  if (cn.length === 1) return map[cn] || cn;
  if (cn.length === 2) {
    if (cn[0] === "十") return 10 + map[cn[1]];
    if (cn[1] === "十") return map[cn[0]] * 10;
  }
  if (cn.length === 3) return map[cn[0]] * 10 + map[cn[2]];
  return cn;
}

function _extractEpisode(title) {
  if (!title) return "";
  const processed = _preprocessTitle(title).trim();
  const cn = processed.match(/第\s*([零一二三四五六七八九十0-9]+)\s*[集话章节回期]/);
  if (cn) return String(_chineseToArabic(cn[1]));
  const se = processed.match(/[Ss](?:\d{1,2})?[-._\s]*[Ee](\d{1,3})/i);
  if (se) return se[1];
  const ep = processed.match(/\b(?:EP|E)[-._\s]*(\d{1,3})\b/i);
  if (ep) return ep[1];
  const bracket = processed.match(/[\[\(【(](\d{1,3})[\]\)】)]/);
  if (bracket && !["720", "1080", "480"].includes(bracket[1])) return bracket[1];
  return "";
}

function _danmuFileName(vodName, episodeTitle) {
  if (!vodName) return "";
  if (!episodeTitle || episodeTitle === "正片" || episodeTitle === "播放") return vodName;
  const digits = _extractEpisode(episodeTitle);
  if (digits) {
    const num = parseInt(digits, 10);
    if (num > 0) return num < 10 ? `${vodName} S01E0${num}` : `${vodName} S01E${num}`;
  }
  return vodName;
}

async function _matchDanmu(fileName) {
  if (!DANMU_API || !fileName) return [];
  try {
    const res = await OmniBox.request(`${DANMU_API}/api/v2/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ fileName }),
      timeout: 15000
    });
    if (_statusOf(res) !== 200) return [];
    const data = JSON.parse(_bodyText(res) || "{}");
    if (!data.isMatched) return [];
    const first = (data.matches || [])[0];
    if (!first || !first.episodeId) return [];
    return [
      {
        name: [first.animeTitle, first.episodeTitle].filter(Boolean).join(" - ") || "弹幕",
        url: `${DANMU_API}/api/v2/comment/${first.episodeId}?format=xml`
      }
    ];
  } catch (_) {
    return [];
  }
}

// ---------- 五个 handler ----------

async function home() {
  try {
    const results = await Promise.all(
      CLASS_LIST.map(async (cls) => {
        try {
          const { rows } = await _getList({
            type_id: cls.type_id,
            offset: 0,
            limit: HOME_SECTION_LIMIT,
            orderby: ""
          });
          return rows;
        } catch (e) {
          await _log("warn", `home 分类拉取失败: ${cls.type_name}`, String((e && e.message) || e));
          return [];
        }
      })
    );
    const list = _mapList([].concat(...results));
    await _log("info", "home 完成", { classCount: CLASS_LIST.length, listCount: list.length });
    return {
      class: CLASS_LIST.map((it) => ({ type_id: it.type_id, type_name: it.type_name })),
      list
    };
  } catch (e) {
    await _log("error", "home 失败", String((e && e.message) || e));
    return { class: CLASS_LIST, list: [] };
  }
}

async function category(params) {
  const p = params || {};
  const typeId = String(p.type_id || p.typeId || p.cat_id || p.categoryId || p.id || CLASS_LIST[0].type_id).trim();
  const page = Math.max(1, Number(p.page || p.pageNum || 1) || 1);
  const limit = Math.max(1, Number(p.page_size || p.limit || PAGE_LIMIT) || PAGE_LIMIT);
  const rawOrder = String(p.orderby || p.order || p.sort || "").trim();
  const orderby = ORDER_MAP[rawOrder.toLowerCase()] !== undefined ? ORDER_MAP[rawOrder.toLowerCase()] : rawOrder;

  try {
    const { rows, total } = await _getList({
      type_id: typeId,
      offset: (page - 1) * limit,
      limit,
      orderby,
      vod_year: String(p.year || p.vod_year || ""),
      vod_area: String(p.area || p.vod_area || ""),
      vod_class: String(p.class || p.vod_class || ""),
      vod_version: String(p.version || p.vod_version || ""),
      vod_state: String(p.state || p.vod_state || "")
    });
    const list = _mapList(rows);
    const pagecount = total > 0 ? Math.ceil(total / limit) : page;
    await _log("info", "category 完成", { typeId, page, limit, total, listCount: list.length });
    return { page, pagecount, limit, total, list };
  } catch (e) {
    await _log("error", "category 失败", { typeId, page, err: String((e && e.message) || e) });
    return { page, pagecount: page, limit, total: 0, list: [] };
  }
}

async function search(params) {
  const p = params || {};
  const keyword = String(p.keyword || p.wd || p.w || p.name || p.q || p.k || "").trim();
  const page = Math.max(1, Number(p.page || p.pageNum || 1) || 1);
  const limit = Math.max(1, Number(p.page_size || p.limit || PAGE_LIMIT) || PAGE_LIMIT);
  if (!keyword) return { page, pagecount: page, limit, total: 0, list: [] };

  try {
    const { rows, total } = await _getList({
      vod_name: keyword,
      offset: (page - 1) * limit,
      limit,
      orderby: ""
    });
    const list = _mapList(rows);
    const pagecount = total > 0 ? Math.ceil(total / limit) : page;
    await _log("info", "search 完成", { keyword, page, total, listCount: list.length });
    return { page, pagecount, limit, total, list };
  } catch (e) {
    await _log("error", "search 失败", { keyword, err: String((e && e.message) || e) });
    return { page, pagecount: page, limit, total: 0, list: [] };
  }
}

async function detail(params) {
  const p = params || {};
  const rawId = String(p.videoId || p.vod_id || p.id || p.video_id || "").trim();
  if (!rawId) return { list: [] };

  try {
    const info = await _getDetail(rawId);
    if (!info) throw new Error("详情接口无数据");

    const vod = _toVod(info) || {
      vod_id: rawId,
      vod_name: rawId,
      vod_pic: "",
      vod_remarks: "",
      vod_year: "",
      vod_area: "",
      vod_actor: "",
      vod_director: "",
      vod_score: "",
      vod_content: ""
    };
    vod.vod_id = String(info.vod_id || rawId);
    vod.vod_pic = _absPic(info.vod_pic || info.vod_pic_thumb || vod.vod_pic);
    vod.vod_area = String(info.vod_lang || "").trim();
    vod.vod_content = [
      _stripHtml(info.vod_content || info.vod_blurb || ""),
      info.vod_director ? `导演：${String(info.vod_director).replace(/\s*\/\s*/g, " / ")}` : "",
      info.vod_actor ? `声优：${String(info.vod_actor).replace(/\s*\/\s*/g, " / ")}` : ""
    ]
      .filter(Boolean)
      .join("\n");

    const groups = _parsePlayGroups(info);
    const vodPlaySources = groups.map((group, gi) => ({
      name: group.name,
      episodes: group.episodes.map((ep, ei) => ({
        name: _cleanEpisodeName(ep.name),
        playId: _encodePlayId({ vod_id: vod.vod_id, line: gi, index: ei, name: _cleanEpisodeName(ep.name) })
      }))
    }));

    if (!vodPlaySources.length) {
      vodPlaySources.push({
        name: "默认线路",
        episodes: [
          { name: "正片", playId: _encodePlayId({ vod_id: vod.vod_id, line: 0, index: 0, name: "正片" }) }
        ]
      });
    }

    const result = {
      list: [
        Object.assign(vod, {
          vod_play_sources: vodPlaySources,
          vod_play_from: groups.map((g) => g.name).join("$$$"),
          vod_play_url: groups
            .map((g) => g.episodes.map((ep) => `${ep.name}$${ep.url}`).join("#"))
            .join("$$$")
        })
      ]
    };

    await _log("info", "detail 完成", {
      id: vod.vod_id,
      name: vod.vod_name,
      sources: vodPlaySources.length,
      episodes: vodPlaySources.reduce((n, s) => n + s.episodes.length, 0)
    });
    return result;
  } catch (e) {
    await _log("error", "detail 失败", { id: rawId, err: String((e && e.message) || e) });
    return { list: [] };
  }
}

async function play(params) {
  const p = params || {};
  const raw = String(p.playId || p.play_id || p.id || p.url || "").trim();

  const buildResult = (urls, referer, danmaku) => {
    const response = {
      urls,
      parse: 0,
      flag: "girigiri",
      header: {
        "User-Agent": UA,
        "Referer": referer || `${SITE_URL}/`,
        "Origin": SITE_URL
      }
    };
    if (danmaku && danmaku.length) response.danmaku = danmaku;
    return response;
  };

  try {
    if (!raw) throw new Error("播放标识为空");

    // 直接给地址的情况
    if (/^https?:\/\//i.test(raw) && /\.(m3u8|mp4|flv)(\?|$)/i.test(raw)) {
      return buildResult([{ name: "直链播放", url: raw }], `${SITE_URL}/`);
    }

    const meta = _decodePlayId(raw);
    if (!meta) throw new Error("播放标识无法解析");

    const info = await _getDetail(meta.vod_id);
    if (!info) throw new Error("详情接口无数据");
    const groups = _parsePlayGroups(info);
    if (!groups.length) throw new Error("详情无播放线路");

    const urls = [];
    const main = groups[meta.line];
    if (main) {
      const ep = main.episodes[meta.index] || main.episodes[0];
      if (ep && ep.url) urls.push({ name: `${main.name} · ${ep.name}`, url: ep.url });
    }
    // 其他线路同集作为备用
    for (let gi = 0; gi < groups.length; gi += 1) {
      if (gi === meta.line) continue;
      const ep = groups[gi].episodes[meta.index];
      if (ep && ep.url) urls.push({ name: `${groups[gi].name} · ${ep.name}`, url: ep.url });
    }
    if (!urls.length) {
      for (const group of groups) {
        const ep = group.episodes[0];
        if (ep && ep.url) {
          urls.push({ name: `${group.name} · ${ep.name}`, url: ep.url });
          break;
        }
      }
    }
    if (!urls.length) throw new Error("未取到播放地址");

    const referer = `${SITE_URL}/detail/${meta.vod_id}`;
    const danmaku = await _matchDanmu(_danmuFileName(info.vod_name, meta.name));
    await _log("info", "play 完成", { id: meta.vod_id, line: meta.line, index: meta.index, urls: urls.length });
    return buildResult(urls, referer, danmaku);
  } catch (e) {
    await _log("error", "play 失败", { raw: raw.slice(0, 120), err: String((e && e.message) || e) });
    const fallback = /^https?:\/\//i.test(raw) ? raw : `${SITE_URL}/`;
    return buildResult([{ name: "页面播放", url: fallback }], `${SITE_URL}/`);
  }
}

module.exports = { home, category, search, detail, play };

const runner = require("spider_runner");
runner.run(module.exports);
