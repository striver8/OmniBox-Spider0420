# probe/ — OmniBox-Spider 自动探活工具

对仓库内所有可运行爬虫（源码含 `runner.run(` 的 `.js`）做端到端探险：
加载脚本 → `home` → `category` → `search` → `detail` → `play`，逐步骤校验返回结构，
输出机器可读报告与人工可读维护报告。

## 为什么需要它

仓库里的脚本依赖第三方站点，站点改版、域名失效、加 JS 校验都会让脚本静默返回空列表。
手动一个个点开测不现实（127 个脚本），所以用本地 shim 把 OmniBox 运行时补全，批量跑。

## 组成

| 文件 | 作用 |
| --- | --- |
| `one.js` | 单脚本探针：进程内加载脚本，按顺序调用 5 个 handler，校验结果，打印 `PROBE_JSON:{...}` |
| `run.js` | 批量调度：每个脚本一个子进程，带并发与硬超时，聚合 `report.json`。可传路径只跑指定脚本 |
| `axios-patch.js` | 给 axios 打补丁：Windows `curl.exe` 作为降级传输（很多站点按 TLS 指纹拦 Node，只放行 Schannel） |
| `classify.js` | 站点级分类：抓脚本里的候选域名根路径，判定 `ALIVE / DNS_DEAD / PARKED / CHALLENGE / SPA / HTTP_4xx` |
| `archive-dead.js` | 把域名已死亡/已出售的脚本移入 `已失效待修复/`，并打 `@status dead` 标记头 |
| `gen-report.js` | 生成仓库根目录的 `维护报告.md` |

shim 本体在 `node_modules/omnibox_sdk` 与 `node_modules/spider_runner`（`npm install` 后由本目录脚本或手工放置；
shim 只用于本地探活，不随脚本发布）。

## 用法

```bash
npm install                                   # 运行期依赖：cheerio / crypto-js
node probe/run.js                             # 全量（默认并发 8）
PROBE_CONC=10 PROBE_HARD_MS=120000 node probe/run.js
node probe/run.js "影视/采集/HDmoli.js"        # 单脚本
node probe/classify.js                        # 站点存活分类 → classify.json
node probe/archive-dead.js --dry              # 预演归档，去掉 --dry 才真正移动
node probe/gen-report.js                      # → 维护报告.md
```

## 判定口径

- **ok**：五步全部通过（未导出的 handler 自动跳过）
- **partial**：`home/category/detail` 通过，仅 `search` 或 `play` 失败
- **broken**：`home/category/detail` 任一硬失败，或脚本加载失败
- **unverifiable**：失败原因只是本地 shim 缺少能力（如网盘 `getDriveFileList`），不代表脚本坏了

搜索关键词默认取自站点自身真实条目（`category` 第一条的标题），避免固定关键词造成假阴性。

## 已知局限

1. 网盘类脚本依赖 OmniBox 的 `getDrive*` API，本地只能验证到 `detail` 之前；结论以客户端内实测为准。
2. JS/WAF 校验（`ge_js_validator`、Cloudflare challenge）无法在 shim 内绕过，探针会直接暴露为 `CHALLENGE`。
3. 站点按 IP/地域限流时，结果与出口网络相关，重复跑会有抖动。
