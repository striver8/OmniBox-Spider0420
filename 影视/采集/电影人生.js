// @name 电影人生
// @author 梦
// @description 页面解析：原站点 dyrsok.com 已整体 302 迁移至 kingtv.vip（王者TV），本版适配其 Tailwind 新页面；播放取分集页 m3u8，已内置 SHA1 工作量证明（attack_key）过检
// @dependencies cheerio
// @version 2.0.0
// @downloadURL https://gh-proxy.org/https://github.com/Silent1566/OmniBox-Spider/raw/refs/heads/main/影视/采集/电影人生.js

const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");
const cheerio = require("cheerio");
const crypto = require("crypto");

const BASE_URL = "https://kingtv.vip";
const BOX_URL = "https://box.dyrs.com.de";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const PAGE_SIZE_GUESS = 20;

let cookieJar = "";

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

function getBodyText(res) {
  const body = res && typeof res === "object" && "body" in res ? res.body : res;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return body.toString();
  if (body && typeof body === "object") return JSON.stringify(body);
  return String(body || "");
}

function getHeader(res, name) {
  const headers = (res && res.headers) || {};
  const lower = String(name).toLowerCase();
  for (const key of Object.keys(headers)) {
    if (String(key).toLowerCase() === lower) return headers[key];
  }
  return "";
}

function rememberCookie(res) {
  const raw = getHeader(res, "set-cookie");
  if (!raw) return;
  const parts = Array.isArray(raw) ? raw : String(raw).split(/,(?=[^;]+?=)/);
  for (const part of parts) {
    const pair = String(part).trim().split(";")[0];
    if (!pair || !pair.includes("=")) continue;
    const cookieName = pair.split("=")[0];
    const rest = cookieJar
      .split(";")
      .map((item) => item.trim())
      .filter((item) => item && !item.startsWith(`${cookieName}=`));
    rest.push(pair);
    cookieJar = rest.join("; ");
  }
}

function absUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `${BASE_URL}${value}`;
  return `${BASE_URL}/${value}`;
}

function stripHtml(text) {
  return String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function sha1(text) {
  return crypto.createHash("sha1").update(String(text)).digest("hex");
}

function isChallenge(html) {
  return typeof html === "string" && html.includes("正在检测") && html.includes("var target");
}

// 站点用 SHA1 工作量证明挡爬虫：找到 i 使 sha1(hash + i) === target，再以 ?attack_key=i 重放
function solveChallenge(html) {
  const hash = (html.match(/var hash = '([0-9a-f]+)'/) || [])[1];
  const target = (html.match(/var target = '([0-9a-f]+)'/) || [])[1];
  if (!hash || !target) return -1;
  const max = 10000 * 1000;
  for (let i = 0; i < max; i++) {
    if (sha1(hash + i) === target) return i;
  }
  return -1;
}

function withParam(url, key, value) {
  const base = String(url).replace(new RegExp(`([?&])${key}=[^&]*`, "g"), "$1").replace(/[?&]$/, "").replace(/&&/g, "&");
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${key}=${encodeURIComponent(value)}`;
}

function stripParam(url, key) {
  return String(url)
    .replace(new RegExp(`([?&])${key}=[^&]*`, "g"), "$1")
    .replace(/\?&/, "?")
    .replace(/[?&]$/, "")
    .replace(/&&/g, "&");
}

async function fetchText(url, options = {}) {
  let target = url;
  let solved = false;
  let lastStatus = 0;

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await OmniBox.request(target, {
      method: options.method || "GET",
      headers: {
        "User-Agent": UA,
        Referer: BASE_URL + "/",
        Accept: "text/html,application/xhtml+xml",
        ...(cookieJar ? { Cookie: cookieJar } : {}),
        ...(options.headers || {}),
      },
      body: options.body,
      timeout: options.timeout || 25000,
    });

    lastStatus = Number(res?.statusCode) || 0;
    rememberCookie(res);
    const text = getBodyText(res);

    if (isChallenge(text)) {
      if (solved) break;
      const key = solveChallenge(text);
      if (key < 0) break;
      solved = true;
      target = withParam(url, "attack_key", key);
      continue;
    }

    if (lastStatus !== 200) {
      throw new Error(`HTTP ${lastStatus || "unknown"} @ ${url}`);
    }
    return text;
  }

  throw new Error(`challenge unsolved (HTTP ${lastStatus || 0}) @ ${url}`);
}

function buildFilters() {
  const commonMovieTv = [
    { key: "class", name: "类型", init: "", value: [{ name: "全部", value: "" }, { name: "剧情", value: "剧情" }, { name: "喜剧", value: "喜剧" }, { name: "动作", value: "动作" }, { name: "爱情", value: "爱情" }, { name: "科幻", value: "科幻" }, { name: "恐怖", value: "恐怖" }, { name: "惊悚", value: "惊悚" }, { name: "悬疑", value: "悬疑" }, { name: "犯罪", value: "犯罪" }, { name: "战争", value: "战争" }, { name: "冒险", value: "冒险" }, { name: "动画", value: "动画" }, { name: "奇幻", value: "奇幻" }, { name: "武侠", value: "武侠" }, { name: "古装", value: "古装" }] },
  ];
  const commonDm = [
    { key: "class", name: "类型", init: "", value: [{ name: "全部", value: "" }, { name: "冒险", value: "冒险" }, { name: "热血", value: "热血" }, { name: "搞笑", value: "搞笑" }, { name: "少女", value: "少女" }, { name: "科幻", value: "科幻" }, { name: "魔幻", value: "魔幻" }] },
  ];
  const commonZy = [
    { key: "class", name: "类型", init: "", value: [{ name: "全部", value: "" }, { name: "真人秀", value: "真人秀" }, { name: "脱口秀", value: "脱口秀" }, { name: "选秀", value: "选秀" }, { name: "访谈", value: "访谈" }, { name: "音乐", value: "音乐" }] },
  ];

  return {
    class: [
      { type_id: "dianying", type_name: "电影" },
      { type_id: "dianshiju", type_name: "电视剧" },
      { type_id: "dongman", type_name: "动漫" },
      { type_id: "zongyi", type_name: "综艺" },
    ],
    filters: {
      dianying: commonMovieTv,
      dianshiju: commonMovieTv,
      dongman: commonDm,
      zongyi: commonZy,
    },
  };
}

function pickBadge($a, $) {
  let badge = "";
  $a.find("div,span").each((_, el) => {
    if (badge) return;
    const text = stripHtml($(el).text());
    if (!text || text.length > 12) return;
    if (/(1080|720|480|2160|4K|HD|蓝光|完结|更新|全\d+集|第\d+集)/i.test(text)) badge = text;
  });
  return badge;
}

function parseVodCards(html) {
  const $ = cheerio.load(html);
  const list = [];
  const seen = new Set();

  $("a[title]").each((_, el) => {
    const $a = $(el);
    const href = ($a.attr("data-url") || $a.attr("href") || "").trim();
    if (!/^\/(movie|tv)\//.test(href)) return;
    const vodName = ($a.attr("title") || $a.find("img[alt]").attr("alt") || "").trim();
    if (!vodName) return;

    const vodId = href.replace(/^\//, "");
    if (seen.has(vodId)) return;
    seen.add(vodId);

    const img = $a.find("img[data-src],img[src]").first();
    const pic = absUrl((img.attr("data-src") || img.attr("src") || "").trim());

    list.push({
      vod_id: vodId,
      vod_name: vodName,
      vod_pic: pic,
      vod_url: absUrl(href),
      type_id: "",
      type_name: "",
      vod_year: "",
      vod_remarks: pickBadge($a, $),
    });
  });

  return list;
}

function guessPageCount(html, page) {
  const $ = cheerio.load(html);
  let max = 0;
  $("a[href*='page=']").each((_, el) => {
    const m = String($(el).attr("href") || "").match(/[?&]page=(\d+)/);
    if (m) max = Math.max(max, Number(m[1]));
  });
  if (max > 0) return max + 1;
  return page + 1;
}

async function home(params, context) {
  const filters = buildFilters();
  try {
    const html = await fetchText(BASE_URL + "/");
    const list = parseVodCards(html).slice(0, 36);
    await OmniBox.log("info", `[电影人生][home] 推荐数: ${list.length}`);
    return { class: filters.class, filters: filters.filters, list };
  } catch (e) {
    await OmniBox.log("error", `[电影人生][home] ${e.message}`);
    return { class: filters.class, filters: filters.filters, list: [] };
  }
}

async function category(params, context) {
  const page = Math.max(1, Number(params.page || 1) || 1);
  const categoryId = String(params.categoryId || params.type_id || "dianying");
  try {
    const filters = params.filters || {};
    const qs = new URLSearchParams();
    if (filters.class) qs.set("class", String(filters.class));
    // 站点页码从 0 开始
    if (page > 1) qs.set("page", String(page - 1));
    const url = `${BASE_URL}/${categoryId}.html${qs.toString() ? "?" + qs.toString() : ""}`;

    await OmniBox.log("info", `[电影人生][category] ${url}`);
    const html = await fetchText(url);
    const list = parseVodCards(html);
    return {
      page,
      pagecount: guessPageCount(html, page),
      total: page * PAGE_SIZE_GUESS + list.length,
      list,
    };
  } catch (e) {
    await OmniBox.log("error", `[电影人生][category] ${e.message}`);
    return { page, pagecount: 0, total: 0, list: [] };
  }
}

function encodePlayId(meta) {
  try {
    return JSON.stringify(meta);
  } catch (e) {
    return "";
  }
}

function decodePlayId(playId) {
  const raw = String(playId || "").trim();
  if (!raw) return null;
  if (raw.startsWith("{")) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }
  if (/^https?:\/\//i.test(raw)) return { a: raw };
  return null;
}

async function detail(params, context) {
  const videoId = String(params.videoId || params.id || params.vod_id || "").trim();
  if (!videoId) return { list: [] };

  try {
    const path = videoId.replace(/^\/+/, "").replace(new RegExp(`^${BASE_URL.replace(/^https?:\/\//, "")}/`), "");
    const pageUrl = /^https?:\/\//i.test(videoId) ? videoId : absUrl(path);
    const html = await fetchText(pageUrl);
    const $ = cheerio.load(html);

    const ogTitle = ($('meta[property="og:title"]').attr("content") || "").trim();
    const name = (stripHtml($("h1").first().text()) || ogTitle.split(/[-–|]/)[0].trim() || "").trim();
    const pic = absUrl($('meta[property="og:image"]').attr("content") || "");
    const rawDesc = ($('meta[property="og:description"]').attr("content") || "").trim();
    const content = rawDesc.replace(/^[^,]*,/, "").trim();
    const year = (html.match(/年份[^\d]{0,12}(\d{4})/) || [])[1] || "";
    const area = (html.match(/地區|地区[^\u4e00-\u9fa5]{0,8}([\u4e00-\u9fa5]{2,6})/) || [])[1] || "";

    const sources = [];

    // 剧集：.seqlist 内按线路分组，href 形如 ?origin=<线路>&p=<序号>
    const originOrder = [];
    const episodesByOrigin = new Map();
    $(".seqlist a.episode-button[data-origin], .seqlist a[href*='origin='][href*='p=']").each((_, el) => {
      const $a = $(el);
      const href = String($a.attr("href") || "");
      const origin = $a.attr("data-origin") || (href.match(/[?&]origin=([^&]+)/) || [])[1] || "";
      const originName = decodeURIComponent(origin || "");
      const p = (href.match(/[?&]p=(\d+)/) || [])[1];
      const epName = stripHtml($a.text()) || (p !== undefined ? `第${Number(p) + 1}集` : "正片");
      if (!episodesByOrigin.has(originName)) {
        episodesByOrigin.set(originName, []);
        originOrder.push(originName);
      }
      episodesByOrigin.get(originName).push({
        name: epName,
        playId: encodePlayId({ o: originName, p: p === undefined ? "0" : p, u: pageUrl }),
      });
    });

    for (const originName of originOrder) {
      const episodes = episodesByOrigin.get(originName) || [];
      if (episodes.length) sources.push({ name: originName || "默认线路", episodes });
    }

    // 线路标签（切换线路是整页刷新，页面只渲染当前线路的内容）
    const tabOrigins = [];
    $("button[data-origin], a[href*='origin=']").each((_, el) => {
      const $el = $(el);
      const origin = String($el.attr("data-origin") || "").trim();
      const label = origin || decodeURIComponent(String($el.attr("href") || "").match(/[?&]origin=([^&]+)/)?.[1] || "");
      if (!label || tabOrigins.includes(label)) return;
      if ($el.is("a[href*='download'],a[href*='dianying.html'],a[href*='dianshiju.html']")) return;
      tabOrigins.push(label);
    });

    if (!sources.length) {
      // 电影：没有集数列表，每条线路各自给一条 /api/m3u8 地址，播放时按线路再取
      const movieOrigins = tabOrigins.length ? tabOrigins : ["默认线路"];
      for (const originName of movieOrigins) {
        sources.push({
          name: originName,
          episodes: [
            {
              name: "正片",
              playId: encodePlayId({ u: pageUrl, o: originName === "默认线路" ? "" : originName, mv: 1 }),
            },
          ],
        });
      }
    } else if (sources.length === 1 && tabOrigins.length > 1) {
      // 剧集：其余线路按同一集序号复刻，播放时按 origin+p 重新取页
      const template = sources[0].episodes;
      const ownName = sources[0].name;
      for (const originName of tabOrigins) {
        if (originName === ownName) continue;
        sources.push({
          name: originName,
          episodes: template.map((ep) => {
            const meta = decodePlayId(ep.playId) || {};
            return { name: ep.name, playId: encodePlayId({ o: originName, p: meta.p === undefined ? "0" : meta.p, u: pageUrl }) };
          }),
        });
      }
    }

    const vodPlayFrom = sources.map((item) => item.name).join("$$$");
    const vodPlayUrl = sources
      .map((item) => item.episodes.map((ep) => `${ep.name}$${ep.playId}`).join("#"))
      .join("$$$");

    const vod = {
      vod_id: path || videoId,
      vod_name: name || path,
      vod_pic: pic,
      vod_content: content,
      vod_year: String(year),
      vod_area: area,
      vod_remarks: sources[0]?.episodes?.length ? `${sources.length}线路` : "",
      vod_play_from: vodPlayFrom,
      vod_play_url: vodPlayUrl,
      vod_play_sources: sources,
    };

    await OmniBox.log("info", `[电影人生][detail] ${name} 线路=${sources.length} 集数=${sources[0]?.episodes?.length || 0}`);
    return { list: [vod] };
  } catch (e) {
    await OmniBox.log("error", `[电影人生][detail] ${e.message}`);
    return { list: [] };
  }
}

async function search(params, context) {
  const keyword = String(params.keyword || params.wd || params.name || "").trim();
  const page = Math.max(1, Number(params.page || 1) || 1);
  if (!keyword) return { page, pagecount: 0, total: 0, list: [] };

  try {
    const qs = new URLSearchParams();
    qs.set("wd", keyword);
    if (page > 1) qs.set("page", String(page - 1));
    const url = `${BASE_URL}/search.html?${qs.toString()}`;
    const html = await fetchText(url);
    const list = parseVodCards(html);
    await OmniBox.log("info", `[电影人生][search] ${keyword} -> ${list.length}`);
    return { page, pagecount: guessPageCount(html, page), total: page * PAGE_SIZE_GUESS + list.length, list };
  } catch (e) {
    await OmniBox.log("error", `[电影人生][search] ${e.message}`);
    return { page, pagecount: 0, list: [] };
  }
}

function extractM3u8(html) {
  const matches = String(html || "").match(/https?:\/\/[^"'\s<>\\]+\.m3u8[^"'\s<>\\]*/g) || [];
  const cleaned = matches.map((u) => u.replace(/&amp;/g, "&").replace(/\\\//g, "/"));
  const unique = [...new Set(cleaned)];
  // 主播放列表优先（/index.m3u8 形态在最前）
  unique.sort((a, b) => Number(/\/index\.m3u8/.test(b)) - Number(/\/index\.m3u8/.test(a)));
  return unique;
}

async function play(params, context) {
  const headers = {
    "User-Agent": UA,
    Referer: BASE_URL + "/",
    Origin: BASE_URL,
  };

  try {
    const meta = decodePlayId(params.playId || params.play_id || params.id || params.url || "");
    if (!meta) {
      return { parse: 1, url: "", urls: [], header: headers, headers };
    }

    // 电影：带 origin 重取详情页，取该线路的 /api/m3u8?origin=&url=，再拼 box 主播放列表
    if (meta.mv) {
      const basePage = stripParam(String(meta.u || ""), "attack_key");
      const target = meta.o ? withParam(basePage, "origin", meta.o) : basePage;
      const html = await fetchText(target);
      const directUrls = extractM3u8(html);
      if (directUrls.length) {
        await OmniBox.log("info", `[电影人生][play] 电影 ${meta.o || "默认"} 直取 ${directUrls.length} 条`);
        return {
          parse: 0,
          flag: "dyrs",
          urls: directUrls.map((u, i) => ({ name: meta.o ? `${meta.o} ${i + 1}` : `线路${i + 1}`, url: u })),
          header: headers,
          headers,
        };
      }

      const hrefRaw = (html.match(/\/api\/m3u8\?[^"'\s<>]+/) || [])[0] || "";
      const apiHref = hrefRaw.replace(/&amp;/g, "&");
      const origin = (apiHref.match(/[?&]origin=([^&]+)/) || [])[1] || "";
      const videoKey = (apiHref.match(/[?&]url=([^&]+)/) || [])[1] || "";
      const originName = decodeURIComponent(origin) || meta.o || "默认线路";

      if (videoKey) {
        const masters = [
          `${BOX_URL}/api/super?id=${videoKey}&origin=${encodeURIComponent(originName)}`,
          `${BOX_URL}/api/super?id=${videoKey}&origin=vip1`,
          `${BOX_URL}/api/super?id=${videoKey}&origin=cf1`,
        ];
        await OmniBox.log("info", `[电影人生][play] 电影 ${originName} -> ${masters[0]}`);
        return {
          parse: 0,
          flag: "dyrs",
          urls: masters.map((u, i) => ({ name: i === 0 ? originName : `备用${i}`, url: u })),
          header: headers,
          headers,
        };
      }
      await OmniBox.log("warn", `[电影人生][play] 电影未取到 api 地址，回退 ${target}`);
      return { parse: 1, url: target, urls: [], header: headers, headers };
    }

    // 电影：/api/m3u8?origin=&url= → box.dyrs.com.de 主播放列表
    if (meta.a) {
      const href = String(meta.a).replace(/&amp;/g, "&");
      const origin = (href.match(/[?&]origin=([^&]+)/) || [])[1] || "";
      const videoKey = (href.match(/[?&]url=([^&]+)/) || [])[1] || "";
      const originName = decodeURIComponent(origin) || meta.n || "默认线路";

      if (videoKey) {
        const masters = [
          `${BOX_URL}/api/super?id=${videoKey}&origin=${encodeURIComponent(originName)}`,
          `${BOX_URL}/api/super?id=${videoKey}&origin=vip1`,
          `${BOX_URL}/api/super?id=${videoKey}&origin=cf1`,
        ];
        await OmniBox.log("info", `[电影人生][play] 电影 ${originName} -> ${masters[0]}`);
        return { parse: 0, flag: "dyrs", urls: masters.map((u, i) => ({ name: i === 0 ? originName : `备用${i}`, url: u })), header: headers, headers };
      }
    }

    // 剧集：带 origin + p 重取分集页，页面 preload 的就是该集真实地址
    const pageUrl = String(meta.u || "").trim();
    if (!pageUrl) return { parse: 1, url: "", urls: [], header: headers, headers };

    const basePage = stripParam(pageUrl, "attack_key");
    let target = basePage;
    if (meta.o !== undefined) target = withParam(target, "origin", meta.o);
    if (meta.p !== undefined) target = withParam(target, "p", meta.p);

    const html = await fetchText(target);
    const urls = extractM3u8(html);
    const label = meta.o ? String(meta.o) : "默认线路";

    if (urls.length) {
      await OmniBox.log("info", `[电影人生][play] ${label} p=${meta.p} -> ${urls.length} 条`);
      return {
        parse: 0,
        flag: "dyrs",
        urls: urls.map((u, i) => ({ name: urls.length > 1 ? `${label} ${i + 1}` : label, url: u })),
        header: headers,
        headers,
      };
    }

    // 电影类页面没有直接 m3u8，只有 /api/m3u8?origin=&url= → 走 box 主播放列表
    const apiHrefRaw = (html.match(/\/api\/m3u8\?[^"'\s<>]+/) || [])[0] || "";
    const apiHref2 = apiHrefRaw.replace(/&amp;/g, "&");
    const videoKey2 = (apiHref2.match(/[?&]url=([^&]+)/) || [])[1] || "";
    const origin2 = decodeURIComponent((apiHref2.match(/[?&]origin=([^&]+)/) || [])[1] || "") || label;
    if (videoKey2) {
      const masters = [
        `${BOX_URL}/api/super?id=${videoKey2}&origin=${encodeURIComponent(origin2)}`,
        `${BOX_URL}/api/super?id=${videoKey2}&origin=vip1`,
        `${BOX_URL}/api/super?id=${videoKey2}&origin=cf1`,
      ];
      await OmniBox.log("info", `[电影人生][play] ${origin2} box 主列表 -> ${masters[0]}`);
      return {
        parse: 0,
        flag: "dyrs",
        urls: masters.map((u, i) => ({ name: i === 0 ? origin2 : `备用${i}`, url: u })),
        header: headers,
        headers,
      };
    }

    await OmniBox.log("warn", `[电影人生][play] 未取到 m3u8，回退播放页 ${target}`);
    return { parse: 1, url: target, urls: [], header: headers, headers };
  } catch (e) {
    await OmniBox.log("error", `[电影人生][play] ${e.message}`);
    return { parse: 1, url: "", urls: [], header: headers, headers };
  }
}
