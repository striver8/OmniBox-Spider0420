// Batch probe: fork one.js per spider with concurrency + hard timeout, aggregate a report.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const CONC = Number(process.env.PROBE_CONC || 8);
const HARD_MS = Number(process.env.PROBE_HARD_MS || 150000);
const SKIP_DIRS = new Set(["node_modules", ".git", "tests", "模板", "配置", "拦截器", "定时任务", "probe", "本地调试"]);

function walk(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(p, acc);
    } else if (ent.name.endsWith(".js")) {
      const src = fs.readFileSync(p, "utf8");
      if (src.includes("runner.run(")) acc.push(path.relative(ROOT, p).replace(/\\/g, "/"));
    }
  }
  return acc;
}

const only = process.argv.slice(2);
const targets = only.length ? only : walk(ROOT).sort();
console.log(`[probe] ${targets.length} spiders, concurrency=${CONC}`);

const results = [];
let idx = 0, done = 0;
const t0 = Date.now();

function runOne(rel) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, "one.js"), rel], {
      cwd: ROOT,
      env: {
        ...process.env,
        // Expose the vendored SDK shims so a fresh clone / CI can probe without node_modules hacks.
        NODE_PATH: [path.join(__dirname, "shims"), process.env.NODE_PATH || ""].filter(Boolean).join(path.delimiter),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, HARD_MS);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", () => {});
    child.on("close", () => {
      clearTimeout(timer);
      const m = out.match(/PROBE_JSON:(\{.*\})\s*$/m);
      let rec;
      if (m) { try { rec = JSON.parse(m[1]); } catch (_) { rec = null; } }
      if (!rec) rec = { file: rel, loadOk: false, steps: {}, verdict: "broken", loadErr: killed ? "HARD_TIMEOUT " + HARD_MS + "ms" : "no probe output" };
      results.push(rec);
      done++;
      const v = rec.verdict;
      console.log(`[${done}/${targets.length}] ${v.padEnd(7)} ${rel}${rec.loadErr ? "  <- " + rec.loadErr.slice(0, 120) : ""}`);
      resolve();
    });
  });
}

(async () => {
  const queue = [...targets];
  const workers = Array.from({ length: CONC }, async () => {
    while (queue.length) {
      const rel = queue.shift();
      await runOne(rel);
    }
  });
  await Promise.all(workers);
  results.sort((a, b) => (a.file < b.file ? -1 : 1));
  fs.writeFileSync(path.join(__dirname, "report.json"), JSON.stringify({ generatedAt: new Date().toISOString(), keyword: process.env.PROBE_KEYWORD || "庆余年", results }, null, 2));
  const ok = results.filter((r) => r.verdict === "ok").length;
  const partial = results.filter((r) => r.verdict === "partial").length;
  const broken = results.filter((r) => r.verdict === "broken").length;
  console.log(`\n[probe] done in ${((Date.now() - t0) / 1000).toFixed(0)}s  ok=${ok} partial=${partial} broken=${broken}`);
})();
