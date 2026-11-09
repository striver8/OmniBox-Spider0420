// @name 毒舌影视
// @author 梦
// @description 影视站：https://www.xnhrsb.com/ ，支持首页、分类、详情、搜索与播放；已适配 2026-11 改版（Xcdn 人机验证 sha256 工作量证明 + 分类/搜索路由双方案）
// @dependencies cheerio
// @version 1.1.0
// @downloadURL https://gh-proxy.org/https://github.com/Silent1566/OmniBox-Spider/raw/refs/heads/main/影视/采集/毒舌影视.js

const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");
const cheerio = require("cheerio");
const crypto = require("crypto");

const BASE_URL = (process.env.DUSHE_HOST || "https://m.xnhrsb.com").replace(/\/$/, "");
// 实测：站点前端的 Xcdn 中间件对 iPhone/Safari UA 直接 403（150 B「403 Forbidden」），
// 对桌面 Chrome UA 才回 408 + 人机验证页（可解），所以默认改用桌面 UA。
const UA = process.env.DUSHE_UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const HOME_CACHE_TTL = Number(process.env.DUSHE_HOME_CACHE_TTL || 900);
const CATEGORY_CACHE_TTL = Number(process.env.DUSHE_CATEGORY_CACHE_TTL || 900);
const DETAIL_CACHE_TTL = Number(process.env.DUSHE_DETAIL_CACHE_TTL || 1800);
const SEARCH_CACHE_TTL = Number(process.env.DUSHE_SEARCH_CACHE_TTL || 600);
const PLAY_CACHE_TTL = Number(process.env.DUSHE_PLAY_CACHE_TTL || 900);
// 站点自 2026-11 起接入 Xcdn 人机验证（HTTP 408 + <title>Bot detection</title>）：
// 需要先解一道 sha256 的工作量证明，再把 __xcdn_captcha 与 __xcdn_captcha_verified 两个 cookie 一起回放。
const XCDN_COOKIE_CACHE_KEY = "dushe:xcdn:cookies";
const XCDN_COOKIE_TTL = Number(process.env.DUSHE_XCDN_TTL || 1800);
const XCDN_MIN_SOLVE_INTERVAL = Number(process.env.DUSHE_XCDN_MIN_INTERVAL || 1200);
const XCDN_MAX_ATTEMPTS = Number(process.env.DUSHE_XCDN_ATTEMPTS || 4);
const XCDN_MAX_ROUNDS = Number(process.env.DUSHE_XCDN_MAX_ROUNDS || 2000000);
// 单次 requestText 的总时间预算：站点被 WAF 连续拦截时必须快速失败，
// 否则 5 个 handler 串行重试会把调用方（探针/宿主）拖到超时。
const XCDN_TOTAL_BUDGET_MS = Number(process.env.DUSHE_XCDN_BUDGET_MS || 9000);

let cookieJar = "";
let lastSolveAt = 0;

const CATEGORY_CONFIG = [
  { id: "1", name: "电影" },
  { id: "2", name: "电视剧" },
  { id: "3", name: "综艺" },
  { id: "4", name: "动漫" },
  { id: "5", name: "短剧" },
  { id: "duoban", name: "豆瓣" },
];

const CLASS_LIST = CATEGORY_CONFIG.map((item) => ({ type_id: item.id, type_name: item.name }));
const FILTERS = Object.fromEntries(
  CATEGORY_CONFIG.map((item) => [
    item.id,
    [
      {
        key: "type",
        name: "分类",
        value: [{ name: "全部", value: item.id }],
      },
    ],
  ])
);

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

function absUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("//")) return `https:${raw}`;
  try {
    return new URL(raw, `${BASE_URL}/`).toString();
  } catch (_) {
    return raw;
  }
}

function cleanText(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function dedupeVodList(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const key = String(item?.vod_id || item?.vod_name || "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function getHeader(res, name) {
  const headers = res?.headers || {};
  const raw = headers[name] ?? headers[String(name).toLowerCase()] ?? headers[String(name).toUpperCase()];
  return raw === undefined || raw === null ? "" : raw;
}

function cookiePairs(res) {
  const raw = getHeader(res, "set-cookie");
  if (!raw) return [];
  const parts = Array.isArray(raw) ? raw : String(raw).split(/,(?=[^;,\s]+=)/);
  const out = [];
  for (const part of parts) {
    const pair = String(part).trim().split(";")[0];
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    // 服务端会用空值下发"删除"指令（例如 verify 之后要求删掉 __xcdn_captcha）。
    // 但站点实际校验时必须两个 cookie 同时存在，所以这里忽略空值，不做删除。
    if (!name || !value) continue;
    out.push({ name, value });
  }
  return out;
}

function applyCookies(res) {
  for (const { name, value } of cookiePairs(res)) {
    cookieJar = cookieJar
      .split(";")
      .map((item) => item.trim())
      .filter((item) => item && !item.startsWith(`${name}=`));
    cookieJar.push(`${name}=${value}`);
    cookieJar = cookieJar.join("; ");
  }
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCaptchaPage(text) {
  const sample = String(text || "").slice(0, 4000);
  return /Bot detection|pow-page|__xcdn\/captcha|__xcdn_captcha/i.test(sample);
}

async function loadCachedCookies() {
  if (cookieJar) return;
  try {
    const cached = await OmniBox.getCache(XCDN_COOKIE_CACHE_KEY);
    if (cached && typeof cached === "string" && cached.includes("__xcdn_captcha")) {
      cookieJar = cached;
    }
  } catch (_) {}
}

async function solveXcdn() {
  const now = Date.now();
  if (now - lastSolveAt < XCDN_MIN_SOLVE_INTERVAL) {
    await sleep(XCDN_MIN_SOLVE_INTERVAL - (now - lastSolveAt));
  }
  lastSolveAt = Date.now();

  const headers = {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Referer: `${BASE_URL}/`,
  };
  if (cookieJar) headers.Cookie = cookieJar;

  const initRes = await OmniBox.request(`${BASE_URL}/__xcdn/captcha/api/init`, { method: "GET", headers, timeout: 15000 });
  applyCookies(initRes);
  let payload = null;
  try {
    payload = JSON.parse(typeof initRes?.body === "string" ? initRes.body : String(initRes?.body || ""));
  } catch (_) {
    payload = null;
  }
  if (!payload || !payload.challenge) {
    throw new Error(`xcdn init failed: HTTP ${initRes?.statusCode} @ ${BASE_URL}`);
  }

  const challenge = String(payload.challenge);
  const difficulty = Math.max(1, Number(payload.difficulty) || 4);
  const target = "0".repeat(difficulty);
  let nonce = 0;
  let hash = "";
  do {
    nonce += 1;
    hash = sha256Hex(challenge + nonce);
  } while (!hash.startsWith(target) && nonce < XCDN_MAX_ROUNDS);
  if (!hash.startsWith(target)) {
    throw new Error("xcdn proof-of-work not solved");
  }

  const verifyHeaders = {
    ...headers,
    Referer: `${BASE_URL}/__xcdn/`,
    "X-CDN-VERIFY-NONCE": String(nonce),
    "X-CDN-VERIFY-RESULT": hash,
  };
  if (cookieJar) verifyHeaders.Cookie = cookieJar;

  const verifyRes = await OmniBox.request(`${BASE_URL}/__xcdn/captcha/api/verify`, {
    method: "GET",
    headers: verifyHeaders,
    timeout: 15000,
  });
  applyCookies(verifyRes);
  if (!/__xcdn_captcha_verified=/.test(cookieJar)) {
    throw new Error(`xcdn verify failed: HTTP ${verifyRes?.statusCode}`);
  }
  await OmniBox.log("info", `[毒舌影视][xcdn] 验证通过 nonce=${nonce} difficulty=${difficulty}`);
  try {
    await OmniBox.setCache(XCDN_COOKIE_CACHE_KEY, cookieJar, XCDN_COOKIE_TTL);
  } catch (_) {}
  return cookieJar;
}

async function requestText(url, options = {}) {
  const method = options.method || "GET";
  const maxAttempts = Number(options.attempts || XCDN_MAX_ATTEMPTS);
  const startedAt = Date.now();
  await loadCachedCookies();
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const elapsed = Date.now() - startedAt;
    if (attempt > 1 && elapsed >= XCDN_TOTAL_BUDGET_MS) {
      await OmniBox.log("warn", `[毒舌影视][request] 超出时间预算 ${elapsed}ms，放弃重试 @ ${url}`);
      break;
    }
    const remaining = Math.max(4000, XCDN_TOTAL_BUDGET_MS - elapsed);
    const headers = {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      Referer: options.referer || `${BASE_URL}/`,
      ...(options.headers || {}),
    };
    if (cookieJar) headers.Cookie = cookieJar;

    const res = await OmniBox.request(url, {
      method,
      headers,
      body: options.body,
      timeout: Math.min(Number(options.timeout || 20000), remaining),
    });
    applyCookies(res);

    const statusCode = Number(res?.statusCode || 0);
    const body = res?.body;
    const text = typeof body === "string" ? body : String(body || "");

    if (statusCode === 200 && !isCaptchaPage(text)) {
      if (attempt > 1) {
        await OmniBox.log("info", `[毒舌影视][request] 第 ${attempt} 次尝试成功 ${method} ${url}`);
      }
      return text;
    }

    lastError = new Error(`HTTP ${statusCode || "unknown"}${isCaptchaPage(text) ? " (人机验证)" : ""} @ ${url}`);
    await OmniBox.log("warn", `[毒舌影视][request] ${lastError.message}，尝试解验证码后重试 (${attempt}/${maxAttempts})`);
    if (attempt === maxAttempts) break;
    try {
      await solveXcdn();
    } catch (err) {
      await OmniBox.log("warn", `[毒舌影视][xcdn] 解验证码失败：${err?.message || err}`);
    }
    await sleep(Math.min(700 * attempt, Math.max(0, XCDN_TOTAL_BUDGET_MS - (Date.now() - startedAt))));
  }

  throw lastError || new Error(`request failed @ ${url}`);
}

async function getCachedText(cacheKey, ttl, producer) {
  try {
    const cached = await OmniBox.getCache(cacheKey);
    if (cached) return String(cached);
  } catch (_) {}
  const text = String(await producer());
  try {
    await OmniBox.setCache(cacheKey, text, ttl);
  } catch (_) {}
  return text;
}

function buildCard($, li) {
  const node = $(li);
  const anchor = node.find("a[href]").first();
  const titleAnchor = node.find(".dytit a[href]").first();
  const href = titleAnchor.attr("href") || anchor.attr("href") || "";
  const img = node.find("img").first();
  const title = cleanText(titleAnchor.text() || img.attr("alt") || anchor.attr("title") || "");
  const pic = img.attr("data-original") || img.attr("src") || "";
  const remarks = cleanText(node.find(".hdinfo,.jidi,.bz").first().text());
  const actor = cleanText(node.find(".inzhuy").first().text().replace(/^主演[:：]?/, ""));
  return {
    vod_id: absUrl(href),
    vod_name: title,
    vod_pic: absUrl(pic),
    vod_remarks: remarks,
    vod_actor: actor,
  };
}

function parseHomeList(html) {
  const $ = cheerio.load(html);
  const list = [];
  $(".bt_img ul li").each((_, li) => list.push(buildCard($, li)));
  return dedupeVodList(list).filter((item) => item.vod_id && item.vod_name);
}

function parseCategoryList(html) {
  const $ = cheerio.load(html);
  const list = [];
  $(".bt_img ul li").each((_, li) => list.push(buildCard($, li)));

  let pagecount = 1;
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href") || "";
    // 旧路由：/dsshiyisw/<tid>--------<page>---.html
    const matches = [...href.matchAll(/-(\d+)---\.html/g)];
    for (const m of matches) {
      const n = Number(m[1] || 1);
      if (Number.isFinite(n)) pagecount = Math.max(pagecount, n);
    }
    // 新路由：/dsshiyitp/<tid>-<page>.html 或 ?page=N
    const tp = href.match(/\/dsshiyitp\/\d+-(\d+)\.html/i);
    if (tp) {
      const n = Number(tp[1]);
      if (Number.isFinite(n)) pagecount = Math.max(pagecount, n);
    }
    const qs = href.match(/[?&]page=(\d+)/i);
    if (qs) {
      const n = Number(qs[1]);
      if (Number.isFinite(n)) pagecount = Math.max(pagecount, n);
    }
  });

  return {
    list: dedupeVodList(list).filter((item) => item.vod_id && item.vod_name),
    pagecount,
  };
}

function parseMetaByLabel($, labels) {
  const needle = Array.isArray(labels) ? labels : [labels];
  let found = "";
  $("li,p,span,div").each((_, el) => {
    if (found) return;
    const text = cleanText($(el).text());
    if (!text) return;
    for (const label of needle) {
      const normalized = String(label || "");
      if (text.startsWith(normalized)) {
        found = text.replace(new RegExp(`^${normalized}`), "").trim();
        return;
      }
    }
  });
  return found;
}

function parseDetailSources($, detailUrl) {
  const sources = [];

  $(".mi_paly_box, .play_source, .playlist, .stui-content__playlist").each((_, box) => {
    const node = $(box);
    const sourceName = cleanText(
      node.find(".ypxingq_t,.option,.nav-tabs li.active,a.active,li.active,span.active,h3,h4").first().text()
    ) || `线路${sources.length + 1}`;
    const episodes = [];
    node.find(".paly_list_btn a[href], .playlist a[href], li a[href], a[href]").each((__, a) => {
      const href = $(a).attr("href") || "";
      const name = cleanText($(a).attr("title") || $(a).text());
      if (!href || !name) return;
      episodes.push({ name, playId: absUrl(href) });
    });
    if (episodes.length) sources.push({ name: sourceName, episodes });
  });

  if (!sources.length) {
    const episodes = [];
    $("a[href]").each((_, a) => {
      const href = $(a).attr("href") || "";
      const name = cleanText($(a).attr("title") || $(a).text());
      if (!/\/dsshiyipy\//.test(href)) return;
      if (!name) return;
      episodes.push({ name, playId: absUrl(href) });
    });
    if (episodes.length) {
      sources.push({ name: "在线播放", episodes: dedupeEpisodes(episodes) });
    }
  }

  if (!sources.length && detailUrl) {
    sources.push({
      name: "在线播放",
      episodes: [{ name: "立即播放", playId: String(detailUrl) }],
    });
  }

  return sources.map((source) => ({ ...source, episodes: dedupeEpisodes(source.episodes) }));
}

function shouldKeepEpisodeName(name) {
  const text = cleanText(name || "");
  if (!text) return false;
  if (text.includes("APP秒播")) return false;
  return true;
}

function dedupeEpisodes(episodes) {
  const out = [];
  const seen = new Set();
  for (const ep of Array.isArray(episodes) ? episodes : []) {
    const name = cleanText(ep?.name || "");
    const playId = String(ep?.playId || "").trim();
    const key = `${name}|${playId}`;
    if (!name || !playId || !shouldKeepEpisodeName(name) || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...ep, name, playId });
  }
  return out;
}

function parseDetail(html, detailUrl) {
  const $ = cheerio.load(html);
  const title = cleanText($("h1").first().text() || $("title").text().replace(/[-_].*$/, ""));
  const pic = absUrl($("div.dyimg img, .dyimg img, .thumb img, .poster img, img.thumb").first().attr("src") || $("img[data-original]").first().attr("data-original") || "");
  const remarks = parseMetaByLabel($, ["状态：", "备注：", "更新："]);
  const year = parseMetaByLabel($, ["年份：", "年代："]);
  const area = parseMetaByLabel($, ["地区："]);
  const typeName = parseMetaByLabel($, ["类型："]);
  const actor = parseMetaByLabel($, ["主演："]);
  const director = parseMetaByLabel($, ["导演："]);
  const lang = parseMetaByLabel($, ["语言："]);
  const douban = parseMetaByLabel($, ["豆瓣：", "评分："]);
  const content = cleanText($(".yp_context,.moviedteail_content,.content,.jianjie,.vod_content").first().html() || $("meta[name='description']").attr("content") || "");
  const vod_play_sources = parseDetailSources($, detailUrl);

  return {
    vod_id: String(detailUrl || ""),
    vod_name: title,
    vod_pic: pic,
    vod_remarks: remarks,
    vod_year: year,
    vod_area: area,
    type_name: typeName,
    vod_actor: actor,
    vod_director: director,
    vod_lang: lang,
    vod_douban_score: douban,
    vod_content: content,
    vod_play_sources,
  };
}

function resolvePlayUrl(rawUrl) {
  let playUrl = String(rawUrl || "").trim();
  if (!playUrl) return "";
  playUrl = playUrl.replace(/\\\//g, "/").replace(/\\/g, "");
  if (/^https?:\/\//i.test(playUrl)) return playUrl;
  if (playUrl.startsWith("//")) return `https:${playUrl}`;
  return absUrl(playUrl);
}

function extractJsonUrl(text) {
  const raw = String(text || "");
  const patterns = [
    /player_aaaa\s*=\s*([^;]+);/i,
    /MacPlayerConfig\.player_aaaa\s*=\s*([^;]+);/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match) continue;
    try {
      const data = JSON.parse(String(match[1]).replace(/'/g, '"'));
      const url = data?.url || data?.src || "";
      if (url) return url;
    } catch (_) {}
  }

  const directPatterns = [
    /["']url["']\s*[,:=]\s*["']([^"']+\.(?:m3u8|mp4)(?:[^"']*)?)["']/i,
    /["']src["']\s*[,:=]\s*["']([^"']+\.(?:m3u8|mp4)(?:[^"']*)?)["']/i,
    /sourceUrl\s*[=:]\s*["']?([^"'\s]+)["']?/i,
    /video\.src\s*=\s*["']?([^"'\s]+)["']?/i,
    /playUrl\s*[=:]\s*["']?([^"'\s]+)["']?/i,
  ];
  for (const pattern of directPatterns) {
    const match = raw.match(pattern);
    if (match?.[1]) return match[1];
  }
  return "";
}

async function resolvePlayPage(playPageUrl, referer) {
  const html = await requestText(playPageUrl, { referer });
  let playUrl = extractJsonUrl(html);
  if (playUrl) return resolvePlayUrl(playUrl);

  const apiMatch = html.match(/\$\.getJSON\(['"]([^'"]+)['"]/i);
  if (apiMatch?.[1]) {
    try {
      const apiUrl = absUrl(apiMatch[1]);
      const body = await requestText(apiUrl, { referer: playPageUrl });
      try {
        const json = JSON.parse(body);
        const nested = json?.url || json?.data?.url || json?.data?.src || "";
        if (nested) return resolvePlayUrl(nested);
      } catch (_) {}
    } catch (_) {}
  }

  const $ = cheerio.load(html);
  const iframeSrc = $("iframe").first().attr("src") || "";
  if (iframeSrc) {
    const iframeUrl = absUrl(iframeSrc);
    try {
      const iframeHtml = await requestText(iframeUrl, { referer: playPageUrl });
      playUrl = extractJsonUrl(iframeHtml);
      if (playUrl) return resolvePlayUrl(playUrl);
    } catch (_) {}
  }

  return "";
}

async function home() {
  try {
    const html = await getCachedText("dushe:home", HOME_CACHE_TTL, () => requestText(`${BASE_URL}/`));
    const list = parseHomeList(html).slice(0, 24);
    await OmniBox.log("info", `[毒舌影视][home] count=${list.length}`);
    return {
      class: CLASS_LIST,
      filters: FILTERS,
      list,
    };
  } catch (e) {
    await OmniBox.log("error", `[毒舌影视][home] failed: ${e.message || e}`);
    return {
      class: CLASS_LIST,
      filters: FILTERS,
      list: [],
    };
  }
}

// 站点在 2026-11 改版后首页导航改为 /dsshiyitp/<tid>.html（tid: 1 电影 / 2 电视剧 / 3 综艺 / 4 动漫 / 5 短剧），
// 旧路由 /dsshiyisw/<tid>--------<page>---.html 是否仍可用未知，因此两种都试，谁先出卡片用谁。
function buildCategoryUrls(tid, page) {
  const id = encodeURIComponent(String(tid));
  const urls = [];
  if (page <= 1) {
    urls.push(`${BASE_URL}/dsshiyitp/${id}.html`);
  } else {
    urls.push(`${BASE_URL}/dsshiyitp/${id}-${page}.html`);
    urls.push(`${BASE_URL}/dsshiyitp/${id}/${page}.html`);
  }
  urls.push(`${BASE_URL}/dsshiyisw/${id}--------${page}---.html`);
  return urls;
}

async function category(params = {}) {
  const tid = String(params.type_id || params.categoryId || params.tid || "1");
  const page = Math.max(1, Number(params.page || params.pg || 1));
  const emptyResult = {
    page,
    pagecount: 1,
    limit: 0,
    total: 0,
    filters: FILTERS[tid] || {},
    list: [],
  };

  for (const url of buildCategoryUrls(tid, page)) {
    try {
      const html = await getCachedText(`dushe:category:${tid}:${page}:${url}`, CATEGORY_CACHE_TTL, () => requestText(url));
      const parsed = parseCategoryList(html);
      if (!parsed.list.length && url !== buildCategoryUrls(tid, page).slice(-1)[0]) {
        await OmniBox.log("warn", `[毒舌影视][category] ${url} 无条目，尝试下一个路由`);
        continue;
      }
      await OmniBox.log("info", `[毒舌影视][category] tid=${tid} page=${page} url=${url} count=${parsed.list.length} pagecount=${parsed.pagecount}`);
      return {
        page,
        pagecount: parsed.pagecount || page,
        limit: parsed.list.length,
        total: parsed.list.length,
        filters: FILTERS[tid] || {},
        list: parsed.list,
      };
    } catch (e) {
      await OmniBox.log("warn", `[毒舌影视][category] ${url} 失败：${e.message || e}`);
    }
  }

  await OmniBox.log("error", `[毒舌影视][category] 所有候选路由均失败 tid=${tid} page=${page}`);
  return emptyResult;
}

async function detail(params = {}) {
  try {
    const vodId = absUrl(params.vod_id || params.videoId || params.id || "");
    if (!vodId) {
      await OmniBox.log("warn", `[毒舌影视][detail] empty id params=${JSON.stringify(params || {})}`);
      return { list: [] };
    }
    const html = await getCachedText(`dushe:detail:${vodId}`, DETAIL_CACHE_TTL, () => requestText(vodId));
    const vod = parseDetail(html, vodId);
    await OmniBox.log("info", `[毒舌影视][detail] vod=${vod.vod_name || vodId} sources=${vod.vod_play_sources?.length || 0}`);
    return { list: [vod] };
  } catch (e) {
    await OmniBox.log("error", `[毒舌影视][detail] failed: ${e.message || e}`);
    return { list: [] };
  }
}

// 站点首页搜索表单是 GET /dsshiyisc/-------------.html?wd=<kw>（改版后的真实用法），
// 旧脚本用的是把关键词拼进路径的 /dsshiyisc/<kw>----------<page>---.html，两种都试。
function buildSearchUrls(wd, page) {
  const kw = encodeURIComponent(String(wd));
  const urls = [`${BASE_URL}/dsshiyisc/-------------.html?wd=${kw}${page > 1 ? `&page=${page}` : ""}`];
  urls.push(`${BASE_URL}/dsshiyisc/${kw}----------${page}---.html`);
  return urls;
}

async function search(params = {}) {
  const wd = String(params.wd || params.keyword || "").trim();
  const page = Math.max(1, Number(params.page || 1));
  if (!wd) {
    return { page, pagecount: 1, limit: 0, total: 0, list: [] };
  }

  for (const url of buildSearchUrls(wd, page)) {
    try {
      const html = await getCachedText(`dushe:search:${wd}:${page}:${url}`, SEARCH_CACHE_TTL, () => requestText(url, { referer: `${BASE_URL}/` }));
      const parsed = parseCategoryList(html);
      if (!parsed.list.length) {
        await OmniBox.log("warn", `[毒舌影视][search] ${url} 无结果，尝试下一个路由`);
        continue;
      }
      await OmniBox.log("info", `[毒舌影视][search] wd=${wd} page=${page} url=${url} count=${parsed.list.length}`);
      return {
        page,
        pagecount: parsed.pagecount || page,
        limit: parsed.list.length,
        total: parsed.list.length,
        list: parsed.list,
      };
    } catch (e) {
      await OmniBox.log("warn", `[毒舌影视][search] ${url} 失败：${e.message || e}`);
    }
  }

  await OmniBox.log("error", `[毒舌影视][search] 所有候选路由均失败 wd=${wd} page=${page}`);
  return {
    page,
    pagecount: 1,
    limit: 0,
    total: 0,
    list: [],
  };
}

async function play(params = {}) {
  try {
    const playId = String(params.playId || params.id || "").trim();
    if (!playId) return { parse: 0, url: "", urls: [], header: {} };

    if (/\.(m3u8|mp4)(\?|#|$)/i.test(playId)) {
      const url = resolvePlayUrl(playId);
      return { parse: 0, url, urls: [{ name: "播放", url }], header: {} };
    }

    const cacheKey = `dushe:play:${playId}`;
    const resolved = await getCachedText(cacheKey, PLAY_CACHE_TTL, async () => {
      const absolutePlayId = absUrl(playId);
      if (/\/dsshiyipy\//.test(absolutePlayId)) {
        const url = await resolvePlayPage(absolutePlayId, `${BASE_URL}/`);
        return url || "";
      }
      if (/\/dsshiyidt\//.test(absolutePlayId)) {
        const detailHtml = await requestText(absolutePlayId);
        const vod = parseDetail(detailHtml, absolutePlayId);
        const first = vod?.vod_play_sources?.[0]?.episodes?.[0]?.playId || "";
        if (first && first !== absolutePlayId) {
          if (/\.(m3u8|mp4)(\?|#|$)/i.test(first)) return resolvePlayUrl(first);
          if (/\/dsshiyipy\//.test(first)) {
            const url = await resolvePlayPage(first, absolutePlayId);
            return url || first;
          }
          return first;
        }
      }
      return "";
    });

    if (resolved) {
      const url = resolvePlayUrl(resolved);
      await OmniBox.log("info", `[毒舌影视][play] parse=0 url=${url}`);
      return { parse: 0, url, urls: [{ name: "播放", url }], header: {} };
    }

    const fallback = absUrl(playId);
    await OmniBox.log("warn", `[毒舌影视][play] fallback parse=1 url=${fallback}`);
    return { parse: 1, url: fallback, urls: [{ name: "播放", url: fallback }], header: {} };
  } catch (e) {
    await OmniBox.log("error", `[毒舌影视][play] failed: ${e.message || e}`);
    return { parse: 0, url: "", urls: [], header: {} };
  }
}
