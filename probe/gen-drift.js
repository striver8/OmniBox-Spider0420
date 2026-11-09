// Build probe/drift.json (failed-step summary) + refresh probe/classify.json
// from the latest report.json, reusing the per-site evidence in verify.json.
"use strict";
const fs = require("fs");
const path = require("path");
const HERE = __dirname;

const report = JSON.parse(fs.readFileSync(path.join(HERE, "report.json"), "utf8"));
const rows = Array.isArray(report) ? report : report.results || [];

function readIf(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return null; }
}
const verify = readIf(path.join(HERE, "verify.json")) || [];
const oldCls = readIf(path.join(HERE, "classify.json")) || [];

const verifyByFile = new Map(verify.map((v) => [v.file, v]));
const oldClsByFile = new Map(oldCls.map((c) => [c.file, c]));

const CLS_MAP = {
  PARKED: "PARKED",
  DNS_DEAD: "DNS_DEAD",
  CLOSED_公告: "CLOSED",
  JUMP_发布页: "JUMP",
  NO_HOST: "NO_HOST",
  SPA_需重写: "SPA",
  WALL_CF: "CHALLENGE",
  WALL_验证码: "CHALLENGE",
  WALL_JS_COOKIE: "CHALLENGE",
};

const drift = [];
const classify = [];

for (const r of rows) {
  const steps = r.steps || {};
  const failing = Object.keys(steps).filter((k) => !steps[k].ok);
  const lastUrl = (r.reqs || []).length ? r.reqs[r.reqs.length - 1].url : "";

  if (failing.length) {
    drift.push({
      file: r.file,
      verdict: r.verdict,
      step: failing[0],
      steps: failing,
      err: String((steps[failing[0]] || {}).err || (steps[failing[0]] || {}).note || "").slice(0, 200),
      lastUrl,
    });
  }

  const v = verifyByFile.get(r.file);
  const o = oldClsByFile.get(r.file);
  let siteCls = "UNKNOWN";
  let host = lastUrl ? new URL(lastUrl).origin + "/" : "";
  if (v) {
    siteCls = CLS_MAP[v.final] || (String(v.final || "").startsWith("ALIVE") ? "ALIVE" : "UNKNOWN");
    host = v.host || host;
  } else if (o) {
    siteCls = o.siteCls;
    host = o.host || host;
  }
  if (o && o.siteCls === "NO_HOST" && siteCls === "UNKNOWN") siteCls = "NO_HOST";
  classify.push({ file: r.file, verdict: r.verdict, siteCls, host });
}

fs.writeFileSync(path.join(HERE, "drift.json"), JSON.stringify(drift, null, 2));
fs.writeFileSync(path.join(HERE, "classify.json"), JSON.stringify(classify, null, 2));
const byCls = {};
classify.forEach((c) => (byCls[c.siteCls] = (byCls[c.siteCls] || 0) + 1));
console.log("drift", drift.length, "classify", classify.length, JSON.stringify(byCls));
