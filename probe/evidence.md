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
