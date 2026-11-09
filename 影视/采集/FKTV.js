// @name FKTV
// @author 梦
// @description 刮削：已接入，弹幕：未接入，嗅探：官方加密接口（/ysapi）直取分级播放地址，失败时回退详情页
// @dependencies crypto-js
// @version 2.0.0
// @downloadURL https://gh-proxy.org/https://github.com/Silent1566/OmniBox-Spider/raw/refs/heads/main/影视/采集/FKTV.js

const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");
const CryptoJS = require("crypto-js");

const BASE_URL = "https://fktv.me";
const API_BASE = `${BASE_URL}/ysapi`;
const API_KEY = "9ed1a661a6ab787a";
const SITE_HOST = "fktv.me";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0";

const DEFAULT_CLASS = [
  { type_id: "6", type_name: "电影" },
  { type_id: "5", type_name: "电视剧" },
  { type_id: "4", type_name: "综艺" },
  { type_id: "7", type_name: "动漫" },
  { type_id: "9", type_name: "短剧" },
  { type_id: "10", type_name: "音乐" },
  { type_id: "11", type_name: "电影解说" }
];

const PAGE_SIZE = 24;

function _json(data) {
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

async function _log(level, message, extra) {
  const suffix = typeof extra === "undefined" ? "" : ` | ${_json(extra)}`;
  try {
    await OmniBox.log(level, `[FKTV] ${message}${suffix}`);
  } catch (_) {
    /* 探针/宿主无日志通道时静默 */
  }
}

function _getBodyText(res) {
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

// ---------- 官方接口签名/加解密 ----------

function _aesKey() {
  return CryptoJS.enc.Utf8.parse(API_KEY);
}

function _pad2(n) {
  return String(n).padStart(2, "0");
}

function _timeStr() {
  const d = new Date();
  return `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())} ${_pad2(d.getHours())}:${_pad2(d.getMinutes())}:${_pad2(d.getSeconds())}`;
}

function _deviceId() {
  // 站点用 MD5(visitorId|hostname) 作设备号；对刮削只要求稳定非空
  return CryptoJS.MD5("omnibox-spider|" + SITE_HOST).toString();
}

function _encryptEnvelope(payload) {
  return CryptoJS.AES.encrypt(JSON.stringify(payload), _aesKey(), {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7
  }).toString();
}

function _decryptResponse(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  if (raw.startsWith("{") || raw.startsWith("[")) return JSON.parse(raw);
  const plain = CryptoJS.AES.decrypt(raw, _aesKey(), {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7
  }).toString(CryptoJS.enc.Utf8);
  if (!plain) return null;
  return JSON.parse(plain);
}

async function _apiPost(endpoint, data, referer) {
  const payload = {
    deviceId: _deviceId(),
    token: "",
    domain: SITE_HOST,
    referer: referer || "",
    user_agent: UA,
    shareCode: "",
    channel: "",
    ip: "",
    data: data || {}
  };
  const url = `${API_BASE}/${endpoint}`;
  const res = await OmniBox.request(url, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Referer": BASE_URL + "/",
      "Origin": BASE_URL,
      "version": "1.0",
      "deviceType": "pc",
      "time": _timeStr(),
      "shareCode": "",
      "channel": "",
      "ip": "",
      "Content-Type": "application/octet-stream"
    },
    body: _encryptEnvelope(payload),
    timeout: 20000
  });

  const status = _statusOf(res);
  const text = _getBodyText(res);
  if (status && status !== 200) throw new Error(`接口 ${endpoint} HTTP ${status}`);
  if (!text) throw new Error(`接口 ${endpoint} 空响应`);

  let parsed;
  try {
    parsed = _decryptResponse(text);
  } catch (e) {
    throw new Error(`接口 ${endpoint} 响应解密失败: ${String(e && e.message || e).slice(0, 120)}`);
  }
  if (!parsed) throw new Error(`接口 ${endpoint} 响应为空`);
  if (parsed.status && parsed.status !== "y") {
    throw new Error(`接口 ${endpoint} 业务失败: ${parsed.error || parsed.status}`);
  }
  return parsed;
}

// ---------- 数据映射 ----------

function _absUrl(u) {
  const s = String(u || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("//")) return "https:" + s;
  return BASE_URL + (s.startsWith("/") ? s : "/" + s);
}

function _pickPic(item) {
  const candidates = [item.img_x_source, item.img_y_source, item.img_x, item.img_y];
  const usable = candidates.find((u) => u && /\.(png|jpe?g|webp|gif)$/i.test(String(u)));
  return _absUrl(usable || candidates.find((u) => !!u) || item.img || "");
}

function _pickRemarks(item) {
  const bits = [];
  const year = item.release_at || item.year || "";
  if (year) bits.push(String(year).slice(0, 4));
  const area = item.area || "";
  if (area) bits.push(area);
  const score = item.score || "";
  if (score && Number(score) > 0) bits.push(`评分 ${score}`);
  const cls = item.category || item.child_title || "";
  if (cls && !bits.length) bits.push(cls);
  return bits.join(" · ");
}

function _toVod(item) {
  if (!item || !item.id) return null;
  return {
    vod_id: String(item.id),
    vod_name: String(item.name || item.movie_name || item.child_title || "").trim(),
    vod_pic: _pickPic(item),
    vod_remarks: _pickRemarks(item),
    vod_year: String(item.release_at || item.year || "").slice(0, 4),
    vod_area: item.area || "",
    vod_actor: item.actor || item.actors || "",
    vod_director: item.director || "",
    vod_content: item.description || item.comment || item.blurb || ""
  };
}

function _mapList(items) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const vod = _toVod(item);
    if (!vod || !vod.vod_name) continue;
    if (seen.has(vod.vod_id)) continue;
    seen.add(vod.vod_id);
    out.push(vod);
  }
  return out;
}

function _encodePlayId(meta) {
  return JSON.stringify({ m: meta.movie_id || "", l: meta.link_id || "", n: meta.episode_name || "" });
}

function _decodePlayId(raw) {
  let meta = null;
  try {
    meta = JSON.parse(raw);
  } catch (_) {
    meta = null;
  }
  if (!meta || typeof meta !== "object") return null;
  const movieId = meta.m || meta.movie_id || "";
  const linkId = meta.l || meta.link_id || "";
  if (!movieId && !linkId) return null;
  return { movie_id: String(movieId), link_id: String(linkId), episode_name: String(meta.n || meta.episode_name || "") };
}

function _groupVodId(rawId) {
  return String(rawId || "").trim();
}

// ---------- 五个 handler ----------

async function home() {
  try {
    const res = await _apiPost("movie/home", {});
    const data = (res && res.data) || {};
    const blocks = [].concat(data.main_block || [], data.other_block || []);

    const classList = [];
    for (const block of blocks) {
      const id = String(block.cat_id || "");
      const name = String(block.cat_name || "").trim() || (block.cat_code === "music" ? "音乐" : block.cat_code) || "";
      if (!id || !name) continue;
      if (classList.some((it) => it.type_id === id)) continue;
      classList.push({ type_id: id, type_name: name });
    }

    const pools = [];
    for (const block of blocks) if (Array.isArray(block.items)) pools.push(...block.items);
    if (Array.isArray(data.new_items)) pools.push(...data.new_items);
    if (Array.isArray(data.rank_updated_items)) {
      for (const it of data.rank_updated_items) {
        pools.push({ id: it.movie_id, name: it.movie_name, canonical_path: it.canonical_path });
      }
    }

    const list = _mapList(pools);
    await _log("info", "home 完成", { classCount: classList.length, listCount: list.length });
    return {
      class: classList.length ? classList : DEFAULT_CLASS,
      list
    };
  } catch (e) {
    await _log("error", "home 失败", String(e && e.message || e));
    return { class: DEFAULT_CLASS, list: [] };
  }
}

async function category(params) {
  const p = params || {};
  const typeId = String(p.type_id || p.typeId || p.cat_id || p.categoryId || p.id || DEFAULT_CLASS[0].type_id).trim();
  const page = Math.max(1, Number(p.page || p.pageNum || 1) || 1);
  const pageSize = Math.max(1, Number(p.page_size || p.limit || PAGE_SIZE) || PAGE_SIZE);

  try {
    const res = await _apiPost("movie/search", {
      cat_id: typeId,
      keywords: "",
      order: "last_update",
      position: "movie",
      tag_id: "",
      page,
      page_size: pageSize
    });
    const data = (res && res.data) || {};
    const list = _mapList(data.data);
    const total = Number(data.total || 0) || 0;
    const pagecount = total > 0 ? Math.ceil(total / pageSize) : page;
    await _log("info", "category 完成", { typeId, page, pageSize, total, listCount: list.length });
    return { page, pagecount, limit: pageSize, total, list };
  } catch (e) {
    await _log("error", "category 失败", { typeId, page, err: String(e && e.message || e) });
    return { page, pagecount: page, limit: pageSize, total: 0, list: [] };
  }
}

async function detail(params) {
  const p = params || {};
  const rawId = String(p.videoId || p.vod_id || p.id || p.video_id || "").trim();
  if (!rawId) return { list: [] };

  try {
    const res = await _apiPost("movie/detail", { id: rawId }, `${BASE_URL}/movie/${rawId}`);
    const d = (res && res.data) || {};
    const vod = _toVod(d) || {
      vod_id: rawId,
      vod_name: rawId,
      vod_pic: "",
      vod_remarks: "",
      vod_content: ""
    };
    vod.vod_id = _groupVodId(d.id || rawId);
    vod.vod_content = [d.description || "", d.director ? `导演：${d.director}` : "", d.actor ? `主演：${d.actor}` : ""]
      .filter(Boolean)
      .join("\n");

    const links = Array.isArray(d.links) ? d.links : [];
    const episodes = links
      .filter((it) => it && it.id)
      .map((it) => {
        const epName = String(it.name || "").trim() || "正片";
        return {
          name: epName,
          playId: _encodePlayId({ movie_id: vod.vod_id, link_id: it.id, episode_name: epName })
        };
      });

    if (!episodes.length) {
      episodes.push({ name: "正片", playId: _encodePlayId({ movie_id: vod.vod_id, link_id: "" }) });
    }

    await _log("info", "detail 完成", { id: vod.vod_id, name: vod.vod_name, episodes: episodes.length });
    return {
      list: [
        {
          ...vod,
          vod_play_from: "FKTV",
          vod_play_url: episodes.map((it) => `${it.name}$${it.playId}`).join("#"),
          vod_play_sources: [{ name: "FKTV", episodes }]
        }
      ]
    };
  } catch (e) {
    await _log("error", "detail 失败", { id: rawId, err: String(e && e.message || e) });
    return { list: [] };
  }
}

async function search(params) {
  const p = params || {};
  const wd = String(p.wd || p.keyword || p.keywords || p.searchKey || "").trim();
  const page = Math.max(1, Number(p.page || 1) || 1);
  const pageSize = Math.max(1, Number(p.page_size || p.limit || PAGE_SIZE) || PAGE_SIZE);
  if (!wd) return { list: [] };

  try {
    const res = await _apiPost("movie/search", {
      keywords: wd,
      position: "movie",
      page,
      page_size: pageSize
    });
    const data = (res && res.data) || {};
    const list = _mapList(data.data);
    await _log("info", "search 完成", { wd, page, total: data.total, listCount: list.length });
    return { list };
  } catch (e) {
    await _log("error", "search 失败", { wd, err: String(e && e.message || e) });
    return { list: [] };
  }
}

function _buildPlayResult(urls, pageUrl) {
  const headers = {
    "User-Agent": UA,
    "Referer": pageUrl || BASE_URL + "/",
    "Origin": BASE_URL
  };
  return {
    parse: 0,
    flag: "fktv",
    url: urls.length === 1 ? urls[0].url : undefined,
    urls,
    header: headers,
    headers
  };
}

function _buildPageFallback(pageUrl, name) {
  const headers = {
    "User-Agent": UA,
    "Referer": BASE_URL + "/",
    "Origin": BASE_URL
  };
  return {
    parse: 1,
    flag: "fktv",
    url: pageUrl,
    urls: [{ name: name || "页面播放", url: pageUrl }],
    header: headers,
    headers
  };
}

function _collectUrls(d) {
  const full = [];
  const preview = [];
  for (const line of Array.isArray(d.play_links) ? d.play_links : []) {
    const url = _absUrl(line && line.m3u8_url);
    if (!url) continue;
    const item = { name: String(line.name || line.id || "线路"), url };
    const previewTime = Number(line.max_preview_time || 0) || 0;
    if (previewTime > 0) preview.push(item);
    else full.push(item);
  }

  const lines = (d.playback_v2 && Array.isArray(d.playback_v2.video_lines)) ? d.playback_v2.video_lines : [];
  for (const line of lines) {
    const h264 = (line && line.h264) || {};
    const url = _absUrl(h264.url || line.path || "");
    if (!url) continue;
    full.push({ name: String(line.name || line.line || "官方线路"), url });
  }

  const sourceUrl = String(d.m3u8_url_source || "");
  if (/[?&]sign=/.test(sourceUrl)) full.push({ name: "源站", url: _absUrl(sourceUrl) });

  const out = [];
  const seen = new Set();
  for (const it of full.concat(preview)) {
    if (!it.url || seen.has(it.url)) continue;
    seen.add(it.url);
    out.push(it);
  }
  return out;
}

async function play(params) {
  const p = params || {};
  const raw = String(p.playId || p.play_id || p.url || p.id || "").trim();

  try {
    if (!raw) throw new Error("播放标识为空");

    if (/\.(m3u8|mp4|flv)(\?|$)/i.test(raw)) {
      return _buildPlayResult([{ name: "直链播放", url: raw }], BASE_URL + "/");
    }

    const meta = _decodePlayId(raw);
    const movieId = meta ? meta.movie_id : raw;
    const linkId = meta ? meta.link_id : "";
    if (!movieId) throw new Error("缺少影片 ID");

    const referer = `${BASE_URL}/movie/${movieId}`;
    let d = null;
    if (linkId) {
      const res = await _apiPost("movie/detail", { id: movieId, link_id: linkId }, referer);
      d = (res && res.data) || null;
    }
    if (!d) {
      const res = await _apiPost("movie/detail", { id: movieId }, referer);
      d = (res && res.data) || null;
    }
    if (!d) throw new Error("详情接口无数据");

    const urls = _collectUrls(d);
    if (urls.length) {
      await _log("info", "play 完成", { movieId, linkId, urls: urls.length });
      return _buildPlayResult(urls, referer);
    }

    await _log("warn", "play 未取到直链，回退详情页", { movieId, linkId });
    return _buildPageFallback(referer, meta && meta.episode_name ? meta.episode_name : "页面播放");
  } catch (e) {
    await _log("error", "play 失败", { raw: raw.slice(0, 120), err: String(e && e.message || e) });
    const fallbackUrl = /^https?:\/\//i.test(raw) ? raw : `${BASE_URL}/`;
    return _buildPageFallback(fallbackUrl, "页面播放");
  }
}

runner.run({ home, category, detail, search, play });
