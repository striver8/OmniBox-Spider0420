// Probe shim for OmniBox SDK (local batch validation only, never shipped).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const LOGS = [];
const REQS = [];
const CACHE = new Map();
const CURL = process.env.PROBE_CURL || "C:/Windows/System32/curl.exe";
const BLOCK_CODES = new Set([403, 429, 451, 503]);
let curlSeq = 0;

function normHeaders(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.forEach === "function" && typeof h.get === "function") {
    h.forEach((v, k) => { out[k] = v; out[k.toLowerCase()] = v; });
    return out;
  }
  for (const [k, v] of Object.entries(h)) { out[k] = v; out[k.toLowerCase()] = v; }
  return out;
}

function parseRawHeaders(raw) {
  const out = {};
  for (const line of String(raw || "").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (/^HTTP\//i.test(k)) continue;
    out[k] = v;
    out[k.toLowerCase()] = v;
  }
  return out;
}

// curl-based transport: browser-like TLS (Schannel) for WAFs that block Node TLS.
function curlRequest(url, opts) {
  const method = opts.method || "GET";
  const hdrs = opts.headers || {};
  const timeout = opts.timeout || 20000;
  const tmp = path.join(os.tmpdir(), "probe-curl-" + process.pid + "-" + (++curlSeq) + ".body");
  const htmp = path.join(os.tmpdir(), "probe-curl-" + process.pid + "-" + curlSeq + ".hdr");
  const args = ["-sS", "-L", "--compressed", "--max-time", String(Math.ceil(timeout / 1000)), "-o", tmp, "-D", htmp, "-w", "%{http_code}"];
  if (method !== "GET") { args.push("-X", method); }
  for (const [k, v] of Object.entries(hdrs)) { if (v != null) args.push("-H", k + ": " + v); }
  if (opts.body != null) args.push("--data-raw", typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body));
  args.push(url);
  const r = spawnSync(CURL, args, { encoding: "utf8", timeout: timeout + 5000, maxBuffer: 64 * 1024 * 1024 });
  let body = "";
  let headers = {};
  try { body = fs.readFileSync(tmp, "utf8"); } catch (_) {}
  try { headers = parseRawHeaders(fs.readFileSync(htmp, "utf8").split(/\r?\n\r?\n/).pop()); } catch (_) {}
  try { fs.unlinkSync(tmp); } catch (_) {}
  try { fs.unlinkSync(htmp); } catch (_) {}
  const code = parseInt(String(r.stdout || "").trim().slice(-3), 10) || 0;
  if (!code) throw new Error("curl transport failed: " + String(r.stderr || r.error || "no status").replace(/\s+/g, " ").slice(0, 200));
  return { statusCode: code, status: code, headers, body, data: body, transport: "curl" };
}

async function request(url, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = { ...(options.headers || {}) };
  const timeout = Number(options.timeout || process.env.PROBE_HTTP_TIMEOUT || 20000);
  let body;
  if (options.body != null) body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  else if (options.data != null) body = typeof options.data === "string" ? options.data : (typeof FormData !== "undefined" && options.data instanceof FormData ? options.data : JSON.stringify(options.data));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("probe timeout")), timeout);
  let res = null, fetchErr = null;
  try {
    const r = await fetch(url, { method, headers, body, redirect: "follow", signal: controller.signal });
    const buf = Buffer.from(await r.arrayBuffer());
    const text = buf.toString("utf8");
    res = { statusCode: r.status, status: r.status, headers: normHeaders(r.headers), body: text, data: text, transport: "fetch" };
  } catch (e) {
    fetchErr = e;
  } finally { clearTimeout(timer); }

  const cfChallenge = res && /<title>\s*(Just a moment|Attention Required|安全验证)|cf-browser-verification|challenge-platform/i.test(res.body.slice(0, 4000));
  if (!res || BLOCK_CODES.has(res.statusCode) || cfChallenge || fetchErr) {
    try {
      const c = curlRequest(url, { method, headers, body, timeout });
      REQS.push({ url: String(url).slice(0, 200), status: c.statusCode, len: (c.body || "").length, t: "curl" });
      return c;
    } catch (e) {
      if (res) return res; // keep original response if curl also fails
      throw fetchErr || e;
    }
  }
  REQS.push({ url: String(url).slice(0, 200), status: res.statusCode, len: (res.body || "").length, t: res.transport || "fetch" });
  return res;
}

const OmniBox = {
  request,
  async log(level, msg) {
    LOGS.push([level, String(msg)]);
    if (process.env.PROBE_VERBOSE === "1") console.error("[" + level + "] " + msg);
  },
  getEnv(name, def) { return process.env[name] ?? def; },
  async getSourceFavoriteTags() { return []; },
  async getSourceCategoryData() { return { page: 1, pagecount: 1, total: 0, list: [] }; },
  async getDriveFileList() { throw new Error("probe: getDriveFileList unavailable"); },
  async getDriveVideoPlayInfo() { throw new Error("probe: getDriveVideoPlayInfo unavailable"); },
  async getDriveInfoByShareURL(shareURL) { return { driveType: "unknown", shareURL }; },
  async getDriveShareInfo() { return {}; },
  async processScraping() { return null; },
  async getScrapeMetadata() { return null; },
  async sniffVideo(url) { return { url }; },
  async getVideoMediaInfo() { return null; },
  async getDanmakuByFileName() { return []; },
  async getAnalyzeSites() { return []; },
  async addPlayHistory() { return true; },
  async getCache(key) { return CACHE.has(key) ? CACHE.get(key) : null; },
  async setCache(key, value) { CACHE.set(key, value); return true; },
  async deleteCache(key) { return CACHE.delete(key) ? 1 : 0; },
  async getProxy() { return null; },
  async sleep(ms) { return new Promise((r) => setTimeout(r, ms)); },
};
module.exports = OmniBox;
module.exports.default = OmniBox;
module.exports.__logs = LOGS;
module.exports.__reqs = REQS;
