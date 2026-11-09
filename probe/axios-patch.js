// Route axios through the same curl-fallback transport the SDK shim uses, and log calls.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const CURL = process.env.PROBE_CURL || "C:/Windows/System32/curl.exe";
const BLOCK = new Set([403, 429, 451, 503]);
const REQS = global.__AXIOS_REQS = global.__AXIOS_REQS || [];
let seq = 0;

function parseHeaders(raw) {
  const out = {};
  for (const line of String(raw || "").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    if (/^HTTP\//i.test(k)) continue;
    out[k.toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

function curlRaw(url, cfg) {
  const tmp = path.join(os.tmpdir(), "axc-" + process.pid + "-" + (++seq) + ".body");
  const htmp = path.join(os.tmpdir(), "axc-" + process.pid + "-" + seq + ".hdr");
  const timeout = Number(cfg.timeout || 20000);
  const args = ["-sS", "-L", "--compressed", "--max-time", String(Math.ceil(timeout / 1000)), "-o", tmp, "-D", htmp, "-w", "%{http_code}", "-X", String(cfg.method || "GET").toUpperCase()];
  const hdrs = cfg.headers || {};
  for (const [k, v] of Object.entries(hdrs)) if (v != null) args.push("-H", k + ": " + v);
  if (cfg.data != null) args.push("--data-raw", typeof cfg.data === "string" ? cfg.data : JSON.stringify(cfg.data));
  args.push(url);
  const r = spawnSync(CURL, args, { encoding: "utf8", timeout: timeout + 5000, maxBuffer: 64 * 1024 * 1024 });
  let body = "", headers = {};
  try { body = fs.readFileSync(tmp, "utf8"); } catch (_) {}
  try { headers = parseHeaders(fs.readFileSync(htmp, "utf8").split(/\r?\n\r?\n/).pop()); } catch (_) {}
  try { fs.unlinkSync(tmp); } catch (_) {}
  try { fs.unlinkSync(htmp); } catch (_) {}
  const code = parseInt(String(r.stdout || "").trim().slice(-3), 10) || 0;
  return { data: body, status: code, statusText: "", headers, config: cfg, request: { via: "curl" } };
}

function install() {
  let axios;
  try { axios = require("axios"); } catch (_) { return; }
  const raw = axios.defaults.adapter;
  if (raw && raw.__probeWrapped) return;
  // axios 1.x ships defaults.adapter as an array of adapter names.
  let orig = raw;
  if (Array.isArray(orig)) {
    try { orig = axios.getAdapter(["http"]) || axios.getAdapter(orig); } catch (_) { orig = null; }
  }
  if (typeof orig !== "function") {
    try { orig = require("axios/lib/adapters/http"); } catch (_) {}
  }
  if (typeof orig !== "function") return;
  const wrapped = async function probeAdapter(config) {
    let res;
    try {
      res = await orig(config);
    } catch (e) {
      const status = e && e.response && e.response.status;
      if (!BLOCK.has(status)) throw e;
      res = e.response;
    }
    const url = (typeof axios.getUri === "function" ? axios.getUri(config) : config.url) || "";
    REQS.push({ url: String(url).slice(0, 200), status: res.status, len: (res.data && (typeof res.data === "string" ? res.data.length : 1)) || 0, t: "axios" });
    if (BLOCK.has(res.status)) {
      const retryCfg = { ...config, headers: { ...(config.headers && config.headers.toJSON ? config.headers.toJSON() : config.headers) } };
      if (retryCfg.data != null && typeof retryCfg.data !== "string") {
        try { retryCfg.data = JSON.stringify(retryCfg.data); } catch (_) {}
      }
      const c = curlRaw(url, retryCfg);
      REQS[REQS.length - 1] = { url: String(url).slice(0, 200), status: c.status, len: (c.data || "").length, t: "curl", retriedFrom: res.status };
      if (c.status >= 400 && res.status) return res;
      return c;
    }
    return res;
  };
  wrapped.__probeWrapped = true;
  axios.defaults.adapter = wrapped;
}

module.exports = { install, REQS };
