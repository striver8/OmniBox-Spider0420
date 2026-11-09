## 七、逐站复核（第二轮，替代"看响应码猜原因"）

首轮把"响应 200 但解析空"和"403"混在一起，容易把"墙"误判成"解析漂移"。第二轮改用 `probe/verify.js`：对每条失败记录同时抓站点根路径与失败页，用有序规则表判定站点级结论（`probe/verify.json`），再决定修还是归档。

84 条失败记录的站点级判定分布：

| 判定 | 数量 | 含义与处置 |
| --- | --- | --- |
| NO_HOST | 30 | 脚本无固定域名（配置型/模板/依赖运行时 env），不属失效 |
| ALIVE_无条目 | 15 | 站点活着但目标页确无内容（改版或该类目空） |
| ALIVE_有内容 | 10 | 站点活着且有内容 —— 唯一"真能修"的集合 |
| WALL_CF | 9 | Cloudflare `Just a moment`，静态请求不可过 |
| HTTP_404 | 6 | 页面/接口已下线 |
| HTTP_522 / 521 / 520 | 4 | 源站不可达（Cloudflare 边缘报源站错误） |
| PARKED | 2 | 域名已出售，页面为停放广告 |
| JUMP_发布页 | 2 | 301 到广告农场"永久地址发布页" |
| WALL_验证码 | 2 | 强制验证码/风控页 |
| WALL_JS_COOKIE | 1 | JS 生成的 cookie 校验（`ge_js_validator_*`），cookie 每响应变化 |
| SPA_需重写 | 1 | 首屏仅外壳，需按新前端重写 |
| CLOSED_公告 | 1 | 站点公告"已停止运营" |
| DNS_DEAD | 1 | 域名不再解析 |

逐站关键证据（判定依据，避免下次重复排查）：

| 脚本 | 站点 | 实测结论 |
| --- | --- | --- |
| 影视/采集/茶杯狐.js | www.cupfox.ai | 根路径 404，另返回 2674B「系统安全验证」页，内含 `window.location.href="../404.html"` 的风控跳转 |
| 影视/采集/太二影视.js | v.tai2.lol | 站点活（首页 `.public-list-box` 可取标题），但 `/index.php/vod/search.html?wd=` 返回「系统提示请输入验证码」，搜索被门禁 |
| 影视/采集/泰剧网.js | zh.taijuwang.com | 2131B「THE END - 关站公告」："本站已正式停止运营……江湖再见 © 2026 tjw24bot" |
| 影视/采集/蛋蛋鱼.js | www.dandanyu.fun | 根与 `/vodtype/4.html` 均 nginx 404（144B） |
| 影视/采集/耐视点播.js | nsvod.me | 301 → `vxuiw.iubybk09jugroup.top` 广告发布页，正文全是"快斗吃瓜/软妹地址/香蕉漫画"类跳转 |
| 影视/采集/剧圈圈.js | www.jqqzx.cc | 301 → `www.jqqzx.one`，新域根路径 404（138B） |
| 影视/采集/FKTV.js | fktv.me | **站点活着**：`/channel?cat_id=1..4` 均 200（52KB/169KB），条目链接为 `/movie/<id16>/<slug>`，整站已是 Next.js + RSC（`self.__next_f` 15 段），需按新前端重写；当前 `/search?keyword=` 404 |
| 动漫/稀饭动漫.js | next.xifanacg.com | Next.js App Router，路由 `/browse` `/recent` `/rankings` `/anime/<id>` `/anime/<id>/play/<epid>?source=`，卡片 `a[href^="/anime/"]`+`aria-label`；无公开 JSON API，播放地址走 Next Server Action（需 POST + `Next-Action` 头），未解 |
| 动漫/Gimy剧迷.js | gimyai.tw | 列表改版为 `.poster/.poster__title`，但所有搜索路径（`/find/...?wd=`、`/search`、`/index.php/ajax/suggest`）均 403 Cloudflare |
| 听书/听友FM.js | tingyou.fm | 200/34KB 但正文仅"资源加载中"，Nuxt 客户端渲染，后端指向第三方 `api-preview.toulaopao.cc` |
| 影视/磁力/磁力熊.js | www.cilixiong.com | 2860B `<title>Redirecting...</title>` + 混淆 JS 跳转（含 prebid/ad-overlay），JS 门禁 |
| 影视/磁力/不太灵.js | web5.mukaku.com | `ge_js_validator_18` cookie 校验，cookie 每响应变化，重放无效 |
| 影视/采集/歪比巴卜.js | wbbb1.com | 403 + 140B 跳转脚本（站点级风控），非解析问题 |
| 直播/YY轮播.js | www.yy.com | `apiSearch/doSearch.json` 实测 200 且返回 13 条结果 → 脚本可用，初期 404 来自其它接口 |
| 影视/网盘/欧哥.js | woog.nxog.eu.org | 首页 `<title>网站关闭</title>`，但模板仍完整（208 个 `.module-item`）——空壳关站 |

## 八、本轮修复记录（2 个脚本，均经探针复验）

### 1. `影视/采集/电影人生.js`（v1.1.1 → v1.1.2，partial）

站点 `www.dyrsok.com` 改成 `/tv/<hash>-<id>.html` 路由后，脚本两处硬编码过滤器失效：

- 卡片过滤 `if (!href || !vodName || /\/dyrscom-/.test(href) === false) return;` 把 `/tv/...` 全丢弃 → 放宽为 `if (!/\/(tv|movie)\//.test(href) && !/\/dyrscom-/.test(href)) return;`
- 线路标签 `#originTabs a[href*='?origin='] button[data-origin]` 与集数 `.seqlist a[href*='?origin=']` 匹配不到，因新 URL 是 `?host=...&origin=...` → 两处 `'?origin='` 改为 `'origin='`

复验：home 24 条 / category 24 条（pagecount 2）/ search「狱前教育」1 条 / detail 8 线路 8 集 / play 得到 `https://www.dyrsok.com/api/m3u8?origin=超级线路&url=...`。play 给的是站内代理地址（可播，非直链），故整体判 partial。

### 2. `音乐/DJ音乐.js`（v1.0.7 → v1.0.8，ok）

三个独立缺陷，逐个实测后修掉：

1. **播放地址缺失**：页面内联 `var music = {file:'c2/16/2026/xxx'}` 是相对路径，脚本原样当 URL 返回 → 抓 `https://www.djuu.com/static/index/js/common.js` 里 `mp.create` 的实现，确认真实地址是 `setMedia({ m4a: "https://mp4.djuu.com/" + file + ".m4a" })`；新增 `buildMediaUrl(file)` 按此拼接（已 curl 验证 `200 audio/x-m4a`）。
2. **搜索返回导航链接**：搜索页解析出 109 条，第一条竟是 `https://www.djuu.com/@@DJ@@@@`（导航项），detail 拿到 `name="DJ"`、play 打到站根 → 新增 `isMusicLink(href)` = `/\/(?:play|hot)\/\d+\.html/`，列表解析与退化分支都先过滤，条数回落到 8 条且全部为真实曲目/专辑。
3. **专辑页无 music 对象**：搜索结果含 `/hot/<id>.html` 专辑页，取不到 `music` → play 里加一次降级：解析失败时抓该页第一个 `/play/\d+\.html` 再解析。

复验：home 11 类 12 条 / category 27 条 / search 8 条 / detail 1 源 1 集 / play `https://mp4.djuu.com/c3/18/2026/xxx.m4a` → **ok**。

## 九、FKTV 重写（v1.2.5 → 2.0.0，ok）

站点整站换成 Next.js App Router（Turbopack 产物），旧的 `POST /movie/detail/<id>`（表单 `link_id` + `is_switch`）与 `.meta-wrap/.hover-wrap` 卡片结构全部失效，列表/详情改为 SSR，播放地址由前端加密接口动态取。逆向结论：

- 接口基址 `/ysapi`；请求体 = `AES-128-ECB(JSON, Pkcs7)` 的 base64 串，密钥 `9ed1a661a6ab787a`，明文躺在 `/_next/static/chunks/2ekcddva4wvjy.js` 的 `fankeClientConfig` 里。
- 请求头：`version: 1.0`、`deviceType: pc`、`time: YYYY-MM-DD HH:mm:ss`、`Content-Type: application/octet-stream`。
- 明文结构：`{deviceId, token, domain, referer, user_agent, shareCode, channel, ip, data}`；响应同样是 AES-ECB 密文，解出 `{status:"y"|"n", data}`（`status!=="y"` 即业务失败）。
- 可用端点：`movie/home`（banner / main_block / other_block / new_items / rank_updated_items）、`movie/search`（同时充当分类列表：`cat_id` + `page` + `page_size`，返回 `{total,current_page,page_size,data}`）、`movie/detail`（`{id}` 或 `{id, link_id}`）、`movie/smartSearch`（`{keywords}` 联想）。
- 剧目字段：`id`（16 位 hex）、`canonical_path`、`img_x_source`（png，`img_x` 是 .bnc 不适合直连）、`links[]`（每集 `{id,name,type}`）、`play_links[]`（`{name,m3u8_url,max_preview_time}`）、`playback_v2.video_lines[]`（`{name,line,h264:{url}}`）、`m3u8_url_source`（缺 sign/time/uid 参数，直连 403）。
- 分类 cat_id：6 电影 / 5 电视剧 / 4 综艺 / 7 动漫 / 9 短剧 / 10 音乐 / 11 电影解说。

重写实现：删掉全部 cheerio 页面解析与 `_did` 硬编码 cookie，改为 `_encryptEnvelope/_decryptResponse/_apiPost` 加密客户端 + 五个 handler：

- `home` → `movie/home`；class 取 main_block+other_block 的 cat_id/cat_name，list 合并三组 items 并去重
- `category` → `movie/search` `{cat_id, keywords:"", order:"last_update", page, page_size:24}`，pagecount = ceil(total/24)
- `detail` → `movie/detail {id}`；episodes 由 `links[]` 生成，返回 `vod_play_sources:[{name:"FKTV", episodes:[{name, playId}]}]`，playId = `{"m":<id>,"l":<link_id>,"n":<集名>}`
- `play` → 解 playId → `movie/detail {id, link_id}` → 依次收 `play_links[].m3u8_url`（`max_preview_time>0` 的预览线路排到最后）、`playback_v2.video_lines[].h264.url`、带 sign 的源站地址，去重后返回 `{parse:0, flag:"fktv", urls, header}`；一条地址都没有时回退页面 `parse:1`
- `search` → `movie/search {keywords, page, page_size}`

复验（五步全通，ok）：home 7 类 107 条 / category type_id=6 24 条、pagecount 708、total 16978 / search 命中 1 条 / detail 1 源 1 集 / play 4 条地址 `parse=0`。另用 46 集长剧《庆余年第一季》单独验证：detail 46 集，取第 6 集 play 出 4 条地址，逐条 curl 全部 `200` 且为合法 `#EXTM3U`（m3c 51KB、m3v 143KB、ysapi/m3u8 2×20KB），说明分集切换正确。

> 附带观察：`影视/采集/电影人生.js`（上轮已修至 partial）本轮全量复跑时 dyrsok.com 对该批请求返回 429（`?origin=jsm3u8` 等线路页 429），play 因此空 urls。属站点突发限流，非解析回归；隔一段时间单跑 detail 仍正常（2 源 2 集）。

## 十、稀饭动漫重写（Next.js + Supabase）

`动漫/稀饭动漫.js` 原为 `dm.xifanacg.com/index.php/ds_api/vod` 的 maccms 接口；站点整站迁到 `https://next.xifanacg.com`（Next.js App Router + Turbopack），旧接口 404，新站 HTML 里只有 RSC 流（`self.__next_f`），播放页 `/anime/<id>/play/<episodeId>?source=` 不含 m3u8。

关键突破：新站前端直连 Supabase，anon key 明文在 bundle `4449yqwkvl18o.js`：

- 后端 `https://api.xifanacg.com`，`sb_publishable_OBIVAWACIX6lPXrO98_z24_HcsmalkA`
- 可读表（PostgREST `/rest/v1/<table>`，头带 `apikey` + `Authorization: Bearer`）：`animes`（`id/title/title_original/type_id/cover_url/description/total_episodes/current_episodes/is_finished/remarks/release_year/region/bangumi_score/format/search_title/series_id`）、`episodes`（`id/anime_id/episode_number/title/kind/release_date`）、`anime_types`（`id/name/slug/legacy_type_id`）
- `anime_types` 实测：1 连载新番 / 2 完结旧番 / 3 剧场版 / 4 美漫；`legacy_type_id` 才等于 `animes.type_id`
- 分页靠 `Prefer: count=exact` 读响应头 `content-range: 0-23/2877`
- 搜索 `?or=(title.ilike.*KW*,title_original.ilike.*KW*,search_title.ilike.*KW*)`，kw 必须保留 `*(),.` 的编码，否则 400
- 播放：`POST https://api.xifanacg.com/functions/v1/issue-web-playback`，body `{action:"fallback", episode_id}`，返回 `candidates[]`（`source_code/source_name/url`），实测每集 3 条线路
- 无权限：`play_sources`、`danmaku` 均为 42501（anon 被 RLS 拒绝），故线路只能走 edge function

v2.0.0 实现：`_rest()` 封装 PostgREST（含 content-range 解析）、`_issuePlayback()` 签发地址、`_encPlayId/_decPlayId` 传 `{e,n}`；home 用 `anime_types` 动态分类，category 用 `type_id=eq.` + limit/offset，detail 用 `vod_play_sources`，play 返回多线路并带 `flag:"xifan"`。

复验（ok）：home 4 类 48 条 / category type_id=1 → 24 条、pagecount 4、total 78 / search「青之箱 第二季」1 条 / detail 12 集 / play 3 条 `parse=0`；另测第 1、6 集 URL 正确递进（`/野生01.mp4` → `/3448/main/06.mp4`）。线路可达性：`apn.moedot.net` 本机超时（12s 000），`play.xfvod.pro:8088` 206 正常——故脚本返回全部 candidates 供切换，不擅自摘除。

## 十一、电影人生站点迁移（dyrsok.com → kingtv.vip）

上一节末尾记录的 429 其实是迁移的前兆：`https://www.dyrsok.com/*` 现在对任何路径返回

```
HTTP/1.1 302
Location: https://kingtv.vip/<path>?host=www.dyrsok.com
X-Cache: BYPASS
```

新站是 Tailwind 重写版（`<title>電影_王者TV_第1頁</title>`），旧 `public-list-box / module-item / .seqlist` 之外的选择器与页面组织都被替换：

- 列表卡片：`<a href="/movie/<24hex>-<id>.html" title="城迷" data-url="/movie/<hash>/<id>.html"><img data-src="/img/id/<hash>.jpg" alt="城迷"><div class="absolute top-2 right-2 ...">1080p</div>`；剧集卡片 `data-url="/tv/<hash>/<id>.html"`
- 分类页 `/{dianying|dianshiju|dongman|zongyi}.html`，页码 **0 基**（`?page=0` 才是第 1 页，pager href 最大 460 → pagecount 461）
- 剧集详情：`.seqlist a.episode-button[data-origin]`，href 形如 `?origin=<线路>&p=<序号>`；线路切换是整页刷新，一页只渲染当前线路的集数（所以其余线路按集序号复刻）
- 电影详情：`<link rel="preload" href="/api/m3u8?origin=<线路>&url=<videoid>">`，命中后 302 到 `https://box.dyrs.com.de/api/super?id=<videoid>&origin=<线路>`，返回 `#EXTM3U` 主播放列表（内嵌 `/api/direct?id=&origin=vip1|cf1` 两个子流）；部分线路（如 1080zyk）页面直接内联 `.m3u8`
- 反爬：详情/分类/搜索路径全部先回 `429` + 「正在检测」页，页面内联 SHA1 工作量证明——找 `i` 使 `sha1(hash + i) === target`，再以 `?attack_key=<i>` 重放，随后下发 `sion_id` cookie。实测 key 在 1e4~6e4 之间，Node 内 16~80ms 解出

v2.0.0 重写：`solveChallenge()` + `fetchText()` 内建 PoW 与 cookie 复用；`parseVodCards` 改按 `a[title]` + `/^\/(movie|tv)\//` 取卡片（`data-src` 取图、角标取 1080p/更新等短文本）；`guessPageCount` 读 pager；detail 同时支持剧集（seqlist 分组 + 多线路复刻）与电影（api 线路）；play 先取分集/线路页内联 m3u8，取不到再退 `box.dyrs.com.de/api/super` 主列表。

复验（ok）：home 36 条 / category dianshiju 24 条 pagecount 461 / detail《女帝2026》9 线路 × 24 集 / play 第 3 线路第 3 集 → `vvip.high26-playback.com/20260427/23143_*.m3u8`；电影《城迷》10 线路，`超級線路` 走 box 主列表 3 条、`xiguam3u8` 直取 `svip.xgplay3.com/...index.m3u8`，均 `parse=0`；search「女帝」24 条。

## 十二、Gimy 剧迷：detail 0 源与 CF 搜索兜底

`gimyai.tw` 整站改版成 `.poster*` 卡片（home 24 条、`/genre/<id>.html` 55 条），但详情页的播放源容器换成了新结构：

```html
<div class="route-title">電光雲</div>
<div class="eps episodes-route is-open" data-route-sid="1">
  <a class="ep" href="/play/927214-1-1.html">HD中字</a>
</div>
<div class="route-title">曦光雲</div>
<div class="eps episodes-route is-open" data-route-sid="4">…</div>
```

旧 `parsePlaySources()` 只认 `#playTab a[href^='#con_playlist_']` + 同名 `id` 容器，因此永远解析出 0 源（探针报 `detail: no playable episodes (sources=0, episodes=0)`）。改法：

1. 优先按 `.route-title` 与紧随其后的 `.eps` 配对（`nextAll(".eps").first()`，兜底 `nextUntil(".route-title").filter(".eps")`），线路名取标题文本，重名自动加序号；
2. 无 `.route-title` 时按 `.eps` 容器逐个收，名字退化为 `data-route-name/data-route-sid/線路N`；
3. 都拿不到再走旧版 `#playTab` 与全页 `/play/` 兜底。

播放页给的是新变量名，脚本原先只匹配 `player_data`：

```js
var player_aaaa={"flag":"play","encrypt":0, …, "url":"https://vip.dytt-see.com/20261106/46924_8de3f64f/index.m3u8","from":"dyttm8"};
var player_data=player_aaaa;
```

正则改为先试 `player_aaaa`（到 `;var player_data`/`</script>` 截断），再退 `player_data`；若 `url` 本身以 `.m3u8` 结尾直接返回 `parse:0`，不再绕 `play.gimyai.tw` 的 `parse.php`。

搜索：`/find/`、`/search/`、`/index.php/ajax/suggest`、`/vodsearch/`、`/?s=` 实测全部 403（Cloudflare 托管挑战）或 404，静态不可用。改为兜底扫描：`SEARCH_GENRES=["1","2","4","29","34"]`（电影/电视剧/动漫/综艺/短剧），每类最多 `SEARCH_SCAN_PAGES=4` 页，用现成的 `scoreSearchResult()` 按标题打分过滤并去重分页。

复验（ok）：home 6 类 24 条 / category type_id=1 → 55 条 pagecount 2 total 75 / search「复活男」「折月亮」各 1 条 / detail《复活男》6 线路各 1 集 / play `vip.dytt-see.com/20261106/46924_8de3f64f/index.m3u8` `parse=0`。版本 1.2.6 → 1.2.7。

## 十三、芸芸音乐：GD 接口被 CF 拦死后的播放通道

`music-api.gdstudio.xyz/api.php`（`types=url`）现在返回 Cloudflare 托管挑战页（403 `Just a moment...`），`api.i-meto.com/meting` 同样被拦，`music.163.com/song/media/outer/url?id=` 对多数曲目 302 到 `/404`（版权受限）。play 因此长期 `urls: []`。

可用通道：网易云自带接口无需登录即可出地址——

```
GET https://music.163.com/api/song/enhance/player/url?ids=[<songId>]&br=<br>
→ {"data":[{"id":…,"url":"http://m802.music.126.net/…/xxx.mp3?vuutv=…","br":128008,"size":…}]}
```

改法：新增 `neteaseGetUrl(songId, br)`，`gdGetUrl()` 改为「网易优先、GD 兜底」；音质档位 `br` 由 GD 的 2000/320/192/128（kbps）改为网易的 999000/320000/192000/128000（bps），四档并发取地址后去重。

复验：play 返回 4 条 `parse=0`（如 `http://m10.music.126.net/…mp3`），detail 10 集，home 20 条。探针仍报 partial 仅因 search 用歌单标题当关键词（噪声，非缺陷）。版本 1.0.2 → 1.0.3。

## 十四、PPnix：播放前不再强求解 CF，40s 超时归零

`play()` 原先无条件 `await ensureCfCookie(false, referer)`，而 `PPNIX_CF_AUTO` 打开时会尝试 FlareSolverr、失败再启 headless Chromium，单次 40s+，直接把探针 play 步骤拖到 STEP_TIMEOUT；返回的还是 `urls: []`。

实测播放地址本身并不需要 cookie：

```
GET https://www.ppnix.com/info/m3u8/9117/1080P.m3u8
→ 200 83892 application/vnd.apple.mpegurl  #EXTM3U …
（耗时 <0.3s，无 cf_clearance）
```

改法：`play()` 只读缓存 cookie（`PPNIX_CF_COOKIE` / `getCachedCfCookie()`），不主动求解；仅当 `PPNIX_REWRITE_M3U8` 分支里首次取 m3u8 失败且尚未有 cookie 时，才 `ensureCfCookie(true, referer)` 并重试一次。

复验：play 由 66s 返回空 → **1ms 返回 `https://www.ppnix.com/info/m3u8/9117/1080P.m3u8`（parse=0）**；整脚本探针 ok。版本 1.7.4 → 1.7.5。

## 十五、girigiri爱动漫重写（Vite SPA → ThinkPHP /api.php）

站点 `https://bgm.girigirilove.com` 301 → `https://ani.girigirilove.com`，前端改为 Vite + React SPA（无 SSR 卡片、无 `_next`），旧的 MacCMS 路径 `/show/<id>-----------/`、`/index.php/ajax/suggest` 全部失效。

从 `assets/client-DzOFWXhI.js` 取到客户端配置：`VITE_API_ORIGIN=https://m3u8.girigirilove.com`，接口基址 `${origin}/api.php`，ThinkPHP path-info 风格，响应统一 `{code:1,msg,info}`：

| 端点 | 说明 |
| --- | --- |
| `GET /api.php/Vod/get_list` | 列表/搜索，`info:{offset,limit,total,rows[]}` |
| `GET /api.php/Vod/get_detail?vod_id=` | 详情，含 `vod_play_from` / `vod_play_url`（MacCMS 分组串） |
| `GET /api.php/Vod/get_class`、`getAllTagOption`、`get_year`、`get_area` | 筛选项 |
| `GET /api.php/App2/bannerList`、`appConfigData` | 首页 banner / 公告 |
| `GET /api.php/Vod/history` | 需要登录（401 `authentication_required`） |

列表参数：`type_id / offset / limit / vod_weekday / vod_letter / vod_tag / vod_name / vod_blurb / vod_area / vod_year / orderby / vod_class / vod_lang / vod_version / vod_state / user_id`；`vod_name=<kw>` 即搜索（「巨人」total=15）。

**关键坑**：站点把**空的 `type_id=` 当成有效筛选**。`Vod/get_list?type_id=&vod_name=黑暗召唤师…` 返回 `total=0`，去掉 `type_id=` 后 `total=1`。因此 `_queryString()` 对空字符串参数整条省略。驼峰 action 名（`Vod/getList`）一律 404，真名是下划线式 `get_list`。

分类 ID：2 日番 / 3 美番 / 20 真人番剧 / 21 剧场版 / 24 BD副音轨 / 26 演唱会及其他。

播放地址就藏在 `vod_play_url` 里（组间 `$$$`、集间 `#`、`名$址`），实测 `https://akua.girigirilove.com/.../01/playlist.m3u8` → 200 4109 B `application/vnd.apple.mpegurl`，无需 token，也不需要前端注入的 `detail-scripts` JSON。

复验：home class=6 / list=72；category type_id=2 → 24 条 `pagecount=132` `total=3149`；search 1 条；detail sources=2 / episodes=11；play `parse=0`。版本 1.1.0 → 2.0.0。

## 十六、星星短剧：搜索参数名 `key` + `bookType=4`

`read.api.duodutek.com` 的搜索端点是 `/novel-api/basedata/book/searchBook`：

- 参数名是 **`key`**（`keyword` / `name` / `bookName` / `searchKey` / `word` / `query` 一律返回 `{"code":"1","msg":"参数错误"}`）；POST 报 405。
- **必须带 `bookType=4`**：不带时命中小说库（结果带 `haveText:true`），带上才是短剧库。实测「逆袭」→ 7 条，「千金驾到」→ 20 条 / `totalCount=21`。
- 分页元数据在 `data.page`（`{pageSize,currentPage,totalCount,needTotal}`）。分类端点 `/novel-api/app/pageModel/getResourceById?resourceId=` 同样带 `data.page.totalCount`。
- detail 用 `/novel-api/basedata/book/getChapterList?bookId=`，`shortPlayList[0].chapterShortPlayVoList[0].shortPlayUrl` 即 m3u8。
- 路由不存在时统一返回 `{"msg":"safe filter error","code":-6001}`，可据此探测端点。

改法：`search()` 改用 `key` + `bookType=4`；`pagecount` 由硬编码 999 改为 `ceil(totalCount/20)`（`PAGE_SIZE` 提为模块常量）。复验 ok：home 5 类 / category 1287 甜宠 17 条 `pagecount=3` / search 20 条 / detail 80 集 / play `parse=0`。版本 1.0.4 → 1.0.6。

## 十七、电影人生：PoW 过检加上退避，避免限速死锁

上一轮加的 SHA1 工作量证明在密集请求下会被站点限速：探针详情步骤报 `429`（8108 B），且拿旧挑战页算出的 `attack_key` 重放**仍然 429**（挑战与时间窗绑定，被限速后重放无效）。

改法（`fetchText()`）：`maxAttempts` 提到 6；命中挑战或 429 时先 `sleep(500 + attempt*700)`，再以**干净 URL** 重新取一次挑战页（站点会轮换 `hash/target`），若这次直接 200 且非挑战页即返回；否则对新旧挑战页分别解 PoW 后重放。

复验 ok：home 4 类 36 条 / category dianying 24 条 `pagecount=678` / search「城迷」24 条 / detail 1 源 1 集 / play `https://lzv34.com/.../index.m3u8` `parse=0`。

## 十八、韩小圈：模糊搜索被严格打分清空

`/api/search` 是模糊匹配（搜「末路兼职」返回「末日侵袭」这类弱相关条目），而 `refineSearchList()` 的严格打分（LCS 覆盖率 <0.68~0.75 记 0 分）会把整页过滤光，最终返回空列表。

改法：`const resultList = refinedList.length > 0 ? refinedList : allList;` —— 严格过滤只在有命中时生效，否则退回原始结果；分页/总数同步改用 `resultList`，日志增加 `loose=` 计数。复验 ok：home 5 类 20 条 / category 20 条 / search 20 条 / play `parse=0`。版本 1.0.3 → 1.0.4。

## 十九、88看球：源站没有搜索接口，改为本地过滤

`search()` 原本是返回空数组的桩。实测源站确实没有搜索路由（`/search?keyword=`、`/search?wd=`、`/so/`、`/match/search`、`/api/search` 全 404），`www.88kanqiu.cc` → 301 → `www.88kanqiu.us`。

改法：调用现成的 `getCategoryList("")` 拉全部直播，再按 `vod_name` / `vod_remarks` 包含关键词过滤（含去空格二次匹配），返回 `{list, page:1, pagecount:1, total}`。复验 ok：home 24 类 59 条 / category 17 条 / search 6 条 / play `parse=1`（源站播放页）。版本 1.1.0 → 1.2.0。

## 二十、不太灵：服务端下发的 JS 校验 cookie，取出重放即可

站点对所有请求先返回 279 B 校验页：

```html
<script>
document.cookie = "ge_js_validator_18=<ts>@18@<32hex>; path=/; max-age=99999;";
window.location.reload();
</script>
```

cookie 值由**服务端**生成（无客户端计算），从响应体里取出后原样重放即可拿到正常内容（带 cookie 的 `/prod/api/v1/getVideoList` → 200 / 66 KB JSON）。改法：新增 `pickValidatorCookieFromBody()`，`requestApi()` 最多重试 3 次，命中新 cookie 就更新并重放，耗尽才抛错。

复验：home 3 类 30 条 / category 25 条 / search 1 条恢复；detail 仍 0 源是因为该片 `movies_online_seed` 为空、且网盘分支依赖 `OmniBox.getDriveFileList`（探针环境无法提供），属网盘类不可探针验证，不是脚本缺陷。版本 1.2.6 → 1.2.7。

## 二十一、布布影视（多多影视）：MacCMS 页面 → `/api.php/web` + WASM 解码

`bubuzhuiju.com` 301 → `duoduozhuiju.com`（官方地址发布页），发布页 `js/config.js` 给出线路：

```js
window.SITE_CONFIG = { lines: [
  { name: '线路 1', host: '323433ssdfd.top' },
  { name: '线路 2', host: 'duoduosdf12223234334.top' },
  { name: '线路 3', host: 'xds2435u23422342342u.top' },
  { name: '线路 4', host: 'dduotv01.top' } ] };
```

主站是 Vue3 + Vite SPA，页面选择器全部失效，改为 JSON 接口：

| 端点 | 参数 | 说明 |
| --- | --- | --- |
| `GET /api.php/web/index/home` | – | `{data:{categories[4],hotSearch,recommend}}` |
| `GET /api.php/web/filter/vod` | `type_name`（比 `type_id` 准）、`page`、`limit`、`sort` | 分类列表 |
| `GET /api.php/web/search/index` | `wd`（不是 `keyword`） | 搜索 |
| `GET /api.php/web/vod/get_detail` | `vod_id`（不是 `id`） | 详情，含 `vod_play_from` / `vod_play_url` |
| `POST /api.php/web/decode/url` | protobuf | 解密播放地址 |

必需请求头：`X-Client: 8f3d2a1c7b6e5d4c9a0b1f2e3d4c5b6a`、`web-sign: ddtvf65f3a83d6d9ad6f`（旧脚本缺 `ddtv` 前缀）。

三个真实故障点：

1. **`vodplayer` 不再下发**，旧 `detail()` 里 `vodplayer.find(...)` 为 undefined 时直接 `return`，导致所有线路被丢弃、detail 返回空列表。改为按 `vod_play_from` / `vod_play_url` 的 `$$$` 下标一一对应解析，`playerInfo` 允许为空。
2. **wasm 资产名带内容哈希**（`/assets/web_app_wasm_bg-Bxwbrgev.wasm`），写死文件名在发版后失效。改为启动时从首页 HTML / 入口 JS 正则解析，多候选依次下载，并缓存路径。
3. **加密播放地址必须调用站点自己的 WASM**。`decode/url` 的 protobuf 请求含 `f3=时间戳 / f4=nonce / f5=签名`，签名验证失败会返回 `{"code":401,"msg":"签名验证失败: 签名已过期"}`；纯 JS 复现签名失败（315 种 sha256/hmac 组合 + 8 个候选密钥零命中），因此脚本内保留完整的 wasm-bindgen glue 手工实现（28 个 `__wbg_*` 导入与线上 wasm 的 import 表逐项一致）。

另外 `CO4K` 线路是客户端专属，服务端返回 `PLATFORM_NOT_ALLOWED`，排序时置底。

复验 ok：home 4 类 24 条 / category 电影 50 条 `pagecount=2` / search「疯狂动物城2」50 条 / detail 4 源 8 集 / play `parse=0`。版本 1.1.0 → 2.0.0。

## 二十二、判定为死站 / 门禁 / 假阴性（本轮只记录，不改码）

| 脚本 | 判定 | 依据 |
| --- | --- | --- |
| 影视/采集/新韩剧网.js | **探针假阴性，脚本正常** | 搜索是 `POST /search/`（`show=searchkey&keyboard=<kw>`）→ 302 → `/search/code.php?id=`，DOM 与解析一致；`PROBE_KEYWORD=韩剧` 时 ok。默认关键词取分类首条标题，站点索引里没有 → 假阴性 |
| 影视/采集/歪比巴卜.js | 搜索被图形验证码门禁 | `/search/-------------.html?wd=` 返回「系统安全验证」页（内含 `MAC.Ajax('/index.php/ajax/verify_check?type=search&verify='+v)`）；`suggest`/`vodsearch` 403、`search.html` 404 |
| 影视/采集/太二影视.js | 搜索被验证码门禁 | `/index.php/vod/search.html?wd=` 返回「系统提示请输入验证码」；首页/分类本身正常 |
| 影视/网盘/剧迷115.js | 站长主动停站 | 所有路径返回同一 3388 B 页，标题「抱歉，站点已暂停」 |
| 影视/采集/柯南影视.js | 站点级故障 | `www.knvod.com` 520 / 16 B |
| 影视/采集/永乐视频.js | 站点级故障 | `ylys.tv` 523 / 16 B |
| 影视/采集/毒舌影视.js | 反爬门禁 | `www.xnhrsb.com` → `m.xnhrsb.com`，408 Bot detection |
| 影视/采集/枫叶.js、枫叶4K.js | TLS 不可达 | `budaichuchen.net` 握手失败 |
| 影视/采集/片库.js | CF 挑战 | `pianku.pro` 403 `Just a moment` |
| 影视/采集/荐片.js | 域名不可达 | `h5.jianpianips1.com` 连接 000 |
| 影视/采集/哇哇影视.js | 脚本配置异常 | 脚本内唯一 URL 是 `gitee.com` |
| 音乐/枫叶音乐.js | 后端 502 | `fy-musicbox-api.mu-jie.cc` 全路径 502（openresty），`mu-jie.cc` 子域全部无解析；不归档，等站点恢复 |

## 二十三、唐人街影院：站点改版（conch 模板）适配

`https://www.trvod.com/` 仍是海螺（conch tpl `surl=/vod-search.html`，ver 3.1.5）多线路站，但 2026-11 前后改了三处结构，旧脚本五步里 category 与 search 全废：

1. **分类路径改为 slug 型**：`/vodtype/<slug>/`（`movie` / `tv-series` / `show` / `animation` / `ethical`，子类本身也是 slug，如 `cn`、`action`，综艺子类带 `show-` 前缀如 `show-jpkr`）。旧的 `/vodshow/1-....html` 一律 404（`<title>页面不存在</title>`）——这是 `category: empty list` 的根因。
2. **列表页只有第一页**：`/vodtype/movie/page/2/`、`/vodtype/animation/index-2.html` 都返回 200 / 25531 B 的 `<title>系统提示......</title>` 占位页，页内没有任何分页标记（无 `hl-page`、无「下一页」、无「共 N 页」）。因此 `category()` 改为单页语义：`pagecount = list.length ? 1 : 0`，命中占位页时返回体附 `notice`。
3. **剧集链接换了路径**：`/vod-play/<vodid>-<sid>-<nid>.html`（旧脚本正则找的是 `/vodplay/`）。详情页结构是 `.hl-plays-from a.hl-tabs-btn[data-from]`（线路名在 `alt` 属性里）+ 每条线路一个 `.hl-tabs-box[data-from]` 容器，容器内 `ul.hl-plays-list a[href*="/vod-play/"]`。解析改为按 `data-from` 逐线路取集，线路名取 `alt`，重名/缺失时退化用线路代码。
4. **`/vod-play/*` 与 `/vod/player/*` 要求移动 UA**：桌面 Chrome UA 一律 403 + 29 B `Forbidden`，换 iPhone Safari UA 立刻 200。新增 `MOBILE_USER_AGENT` 与 `pickUserAgent(url)`，只对这两类路由切 UA（分类页/详情页仍用桌面 UA）。
5. **搜索被 WAF 拦死**：`/vod-search.html?wd=` 对 curl 是 403 + 9 B `Forbidden`，对 Node TLS 是 CF 挑战页。原 `requestText()` 把任何 403 都当 CF 挑战 → 触发 FlareSolverr，而本机 `192.168.50.50:8191` 不可达，白等 40 s+ 把 search 步拖超时。改为：挑战判定必须是正文命中 CF 特征（`Just a moment|cf_chl_opt|Enable JavaScript and cookies to continue|_cf_chl_`），且搜索路由显式传 `{ skipCf: true }`；搜索失败后兜底为「并发抓 5 个分类页 + 本地标题匹配」（串行 12 s → 并发 7 s）。

播放链路（实证）：播放页 iframe 指向 `/vod/player/id/<vodid>/nid/<nid>/sid/<sid>.html`（注意 nid/sid 顺序与播放页 URL 相反），iframe 内 `var player_aaaa={"url":"https://xxx/index.m3u8","encrypt":0,...}` 即直链。整季第一集 9 条线路全部拿到直链。

复验 ok（17 s）：home 5 类 36 条 / category movie 96 条（`pagecount=1`）/ search「天使与恶徒」1 条 / detail 9 源 9 集 / play `parse=0`。版本 1.0.0 → 1.1.0。

## 二十四、探针工具缺陷修复：curl 降级遇 brotli 导致「200 但空正文」

`probe/axios-patch.js` 的 curl 降级与 `probe/shims/omnibox_sdk` 的 `curlRequest` 会把 axios 的请求头原样转发给 curl；axios 默认带 `Accept-Encoding: gzip, deflate, br`，于是站点/CDN 回 `Content-Encoding: br`，而 Windows 自带 curl（Schannel 构建）**不带 brotli**，报 `curl: (61) Unrecognized content encoding type`、正文文件 0 字节，但 `-w %{http_code}` 依旧输出 200 → 表现为「HTTP 200 但页面为空」。

两处统一改为只声明 `Accept-Encoding: gzip, deflate`。修复前后同一 URL 的正文长度 0 → 139248。

影响评估：历史报告里「HTTP 200 但解析为空（SHELL/PARSE）」一类结论可能混入该假阴性；本轮全量复跑已用修好的探针重测。修正后总体：**ok=54 / partial=6 / broken=41**（共 101 个 active 脚本）。

## 二十五、本轮归档（ParkLogic 停放）

| 脚本 | 判定 | 依据 |
| --- | --- | --- |
| 影视/磁力/磁力熊.js | PARKED | `www.cilixiong.com` 根 200 / 5568 B `<title>Redirecting...</title>`，混淆 JS `POST https://router.parklogic.com/`，内嵌 base64 载荷解出 `{"domainFull":"www.cilixiong.com","country":"SG"}` |
| 影视/采集/Auete影视.js | PARKED | `auete.top` 同一套 ParkLogic 停放页（5568 B，`parklogic: true`） |

两者已移入 `已失效待修复/` 并加盖 `// @status dead | PARKED | ...` 头注。

## 二十六、金牌：搜索接口瞬时失败 → 增加退避重试

`https://m.jiabaide.cn` 的 `/api/mw-movie/anonymous/video/searchByWordPageable` 在高频或瞬时波动时会回 4xx / `{code:非200}`（例如 `应用签名不可为空`、`签名已过期`），单次失败会让 `search()` 落进 catch 并返回空列表。脚本原本只有一次请求，因此探针间歇性报 `search: empty list`（同一脚本连跑三次：ok / partial / ok）。

改动：`fetchJson()` 拆成「重试壳 + `fetchJsonOnce()`」，最多 3 次、退避 `350ms * attempt`，失败才上抛；版本 1.1.4 → 1.1.5。连跑三次探针均 ok。

## 二十七、听友FM 新站（tingyou.fm → fmfm.tingyou.fm）API 侦察（未改脚本）

旧路由全部失效：`/categories/<id>`、`/albums/<id>` 均 404（home 之所以「过」探针，是因为它 catch 后回落到硬编码的 `CATEGORY_MAP`，属假阳性）。新站是 Nuxt 3，落地页 `/listening`（首页 177 KB，`window.location` 重定向到 `/listening`），另有 `/listening/filter`、`/feed`、`/cinema`、`/play`、`/me`。客户端配置：`apiBase=/api`（真实 host 由下面 bootstrap 决定），`headURL=https://toudnbbaa.tou1laopao.cc/api/startup-head/h5api.dat`，`trustedKeys[0]={key_id:"avh-3e92be7026555e08",algorithm:"Ed25519",public_key:"p2VRmQyFi67mrc_cxIw8zagpj7GSsUO9tba7vLApjNE"}`。

**bootstrap 解密已打通**（`h5api.dat`）：结构是 `cipher || key(32B) || iv(16B)`，即 `(len-48)%16==0`，用 `AES-CBC(key=bytes[-48:-16], iv=bytes[-16:])` 解出 JSON（外层再用 trustedKeys 的 Ed25519 验签 `signed_payload`）。解出的关键内容：

- `api_hosts` / `api_host_contracts`：`https://appp.fdhtbz.cn`（priority 1，**不带 /api，key 接口 404**）、`https://ffggewvge.dasfrvvbbhhafdgserqw.cc/api/`、`https://fsfggqwewrr.dsafasfvvaaee.cc/api/`。
- `host_policy.probe_path = "time/seconds"`（探活用），`schema=av-api-bootstrap-v2`，`expires_at=4102444799`。
- 后两个 host 的 `GET /web/security/key/current` 可用，返回 `{version:"bk-…", activatedAt, expiresAt, key(64hex), signKey(64hex)}`。

**加密请求协议已还原**（与站点 bundle `/_nuxt/Byf80rIC.js` 一致）：
1. 取 key → `{version, key, signKey}`（hex）。
2. 明文 = `JSON.stringify({...params, timestamp: floor(Date.now()/1000)})`；密文 = `AES-GCM(key, iv=随机12B)`；`payload = base64(iv || ciphertext)`。
3. 请求头：`x-gossip-browser-secure: 1`、`x-key-version`、`x-req-timestamp`（毫秒）、`x-req-nonce`（32 位 hex uuid）、`x-req-signature` = `HMAC-SHA256(signKey, `${version}.${strippedPath}.${ts}.${nonce}.${payload}`)` 的小写 hex；其中 `strippedPath` = 去掉前导 `/` 与 `web/` 前缀（如 `/web/page/bootstrap/home` → `page/bootstrap/home`）。body = `{payload}`。
4. 响应验签 `HMAC(version, `${strippedPath}:response`, ts, nonce, payload)`，再 AES-GCM 解 `payload`。

**当前卡点**：按上述协议 POST `/web/page/bootstrap/home` 等端点，服务端一律返回 **200 + 同一段固定 base64（64 B，不随请求变化）**，用 key/signKey 以 AES-GCM/AES-CBC/xchacha 各种切分均解不开 → 判定服务端在参数/设备标识不全时返回一个「固定无效响应」，需要继续在 bundle 里确认 bootstrap 系列端点的必需参数（响应头暴露的可选头有 `X-Device-Id`、`X-Listening-Timezone`、`X-Listening-Session`、`Idempotency-Key`）与响应包装格式。

**已提取的新站端点清单**（签名路径去 `/web/` 前缀）：`page/bootstrap/{home,search,label,topic,actor,person,play}`、`video/{hot,batch/list,search,detail,recommend,rank/list,browse/catalog,browse/home,browse/column,new/videos,selected/list}`、`catalog.{works,work,episodes,episode,work_filters,commentary,related,collection_items,works_recent,works_recent_completed,work_share}`、`listening.home_share`、`pages.{list,tab}`、`discovery.{get,tab}`、`rankings.{list,history}`、`search.{works,suggest,hot}`、`music.{sections,albums,album,tracks}`、`actor/{search,list,video/list}`、`gossip/{list,detail,recommend,top-clicks,archives,tags,categories,site/config}`、`advert/{findAll,findByName,listByName,catalogs,catalog}`、`v1/tv/call`（走 `operation` 字段）。

结论：站点存活、协议已还原、端点清单已拿到，**属可重写但工作量大**，本轮不改脚本，留给下一轮；`听友FM.js` 现状（v1.0.6）已完全失效，暂不归档。

## 二十八、本轮新增站点定性（补充第二十二节）

| 脚本 | 判定 | 依据 |
| --- | --- | --- |
| 影视/网盘/聚盘搜索.js、聚盘搜索分组.js | API 全路径 403 | `https://ppan.dyuzi.com/api/frontend/{home,search,ranking,...}` 一律 nginx `403 Forbidden`（548 B），根路径同样 403 |
| 影视/网盘/闪电.js | 源站 522 | `https://sd.sduc.site` CF 522（origin 超时），10s 无响应 |
| 影视/网盘/蜗牛4K.js | 源站 522 | `https://zmi.kdns.fr` CF 522 / 16 B |
| 影视/网盘/影巢.js | 数据源停放 | 依赖 `https://hdhive.com/api/open`，该域现跳 `lander` → GoDaddy「for sale」停放；且脚本本身需 TMDB Key |
| 影视/网盘/光鸭·臻影社.js | 需配置 token | `api.guangyapan.com` 返回 401（需用户填 token），`www.guangyapan.com` 正常 → 配置型，非缺陷 |
