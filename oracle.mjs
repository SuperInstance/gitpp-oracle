#!/usr/bin/env node
// gitpp-oracle — continuous cross-port differential conformance for git.pp.
//
// Four commands:
//   run           one pass, append to the ledger, exit non-zero on a NEW divergence
//   watch N       loop every N seconds (into the LOCAL ledger, not the witness log)
//   ledger        summarise the ledger
//   assert N      the memory assertion: fail unless the ledger holds more than N rows
//
// The contract that makes continuous running useful: a divergence listed in
// known-limitations.json is ACCEPTED and does not fail the run, and the moment
// anything else appears, the run fails. A permanently-known edge case must not
// silence a real regression; a known one must not cry wolf every cycle.
//
// The oracle also records port git SHAs, so "it was green yesterday" is
// answerable -- which is the whole reason to keep a ledger rather than a
// pass/fail badge. That answer is only worth anything if the ledger survives
// the run, so ledger.jsonl is TRACKED, the workflow commits it, and the job
// ASSERTS that it grew (see assertLedger).

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

// Sibling checkouts. Resolved against the ORACLE_ROOT env var, or the
// parent of this file, so the runner works from any CWD -- execFileSync
// resolves a relative `cwd` against the parent's CWD, not the script's.
const ROOT = process.env.ORACLE_ROOT
  ? resolve(process.env.ORACLE_ROOT)
  : resolve(new URL(".", import.meta.url).pathname, "..");
const sib = (n) => resolve(ROOT, n);

const PORTS = [
  { name: "doctor", dir: sib("gitpp-doctor"), kind: "both" },
  { name: "js",     dir: sib("gitpp-js"),     kind: "both" },
  { name: "cs",     dir: sib("gitpp-cs"),     kind: "both" },
  { name: "pl",     dir: sib("gitpp-pl"),     kind: "both" },
  { name: "c",      dir: sib("gitpp-c"),      kind: "leaf" },
  // The hub is the reference, not a port. It belongs here precisely BECAUSE
  // of that: the five ports agreeing with each other says nothing about
  // whether the thing they were ported from agrees with them. Measured
  // 2026-10-16: the hub diverges from all five on 448 of 20,043 records,
  // because pyNumber() still tests 1e21 where §3 says 1e16
  // (patchwork-quilt/git.pp-ng#28).
  { name: "hub",    dir: sib("hub"),          kind: "leaf", optional: true },
];
const SUITES = {
  leaf: { dir: sib("gitpp-cross-port"),       bin: "node", script: "fuzz.mjs",
          args: [process.env.ORACLE_CORPUS || "/tmp/corpus.json"] },
  fold: { dir: sib("gitpp-fold-conformance"), bin: "node", script: "run.mjs", args: [] },
};

function sha(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch { return "unknown"; }
}
function tryRun(cwd, bin, args = [], timeout = parseInt(process.env.ORACLE_TIMEOUT_MS || "1800000", 10)) {
  try {
    const out = execFileSync(bin, args, {
      cwd, encoding: "utf8", timeout, maxBuffer: 1 << 26,
    });
    return { ok: true, out, code: 0 };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}`, code: e.status ?? -1, err: e.code || String(e.message).slice(0,120) };
  }
}

function divergenceKey(kind, line) {
  return createHash("sha256").update(`${kind}\n${line.replace(/\b[0-9a-f]{7,40}\b/g, "<sha>")}`).digest("hex").slice(0, 16);
}

// Parse "  N agree, M disagree, K errors" style tails from the suite runners.
function parseCounts(out) {
  const res = { agree: null, disagree: null, errors: null, pass: null, fail: null, total: null };
  let m;
  if ((m = out.match(/(\d+)\s+agree,\s*(\d+)\s+disagree,\s*(\d+)\s+errors?\s*\(out of (\d+)\)/))) {
    [, res.agree, res.disagree, res.errors, res.total] = m.map(Number);
  }
  if ((m = out.match(/(\d+)\s+pass,\s*(\d+)\s+fail,\s*(\d+)\s+skip\s*\(of (\d+)\)/))) {
    [, res.pass, res.fail, , res.total] = m.map(Number);
  }
  return res;
}

function classify(counts, portName) {
  if (counts.fail > 0 || counts.disagree > 0) return "divergence";
  if (counts.errors > 0) return "error";
  if (counts.pass != null || counts.agree != null) return "green";
  // Unknown means the runner produced output we could not read. That is not
  // green. An oracle that reports green when it cannot tell is worse than no
  // oracle: it converts a broken harness into a passing badge. Same rule as
  // gitpp-gate's fail-closed routing, and as §5.7's "absent signal is not
  // consent".
  return "unknown";
}

export function runOnce({ ledgerPath = process.env.ORACLE_LEDGER || "ledger.jsonl", knownPath = "known-limitations.json" } = {}) {
  const known = existsSync(knownPath) ? JSON.parse(readFileSync(knownPath, "utf8")) : { limitations: [] };
  const knownPorts = new Set((known.limitations || []).map((l) => l.port));
  const entry = {
    at: new Date().toISOString(),
    ports: Object.fromEntries(PORTS.map((p) => [p.name, sha(p.dir)])),
    suites: {},
    newDivergences: [],
    acceptedDivergences: [],
  };
  let failed = false;

  for (const [kind, suite] of Object.entries(SUITES)) {
    if (!existsSync(suite.dir)) {
      entry.suites[kind] = { status: "missing", dir: suite.dir };
      continue;
    }
    const t0 = Date.now();
    const r = tryRun(suite.dir, suite.bin, [suite.script, ...(suite.args ?? [])]);
    const counts = parseCounts(r.out);
    const status = classify(counts, "suite");
    entry.suites[kind] = { ...counts, status, exit: r.code, ms: Date.now() - t0,
                           tail: (r.out || "").trim().split("\n").slice(-3).join(" | ").slice(0, 300), err: r.err || null };

    const bad = kind === "fold" ? (counts.fail ?? 0) > 0 : (counts.disagree ?? 0) > 0;
    if (status === "error") { failed = true; entry.newDivergences.push(`${kind}: suite errored, exit ${r.code}`); }
    else if (status === "unknown") {
      failed = true;
      entry.newDivergences.push(`${kind}: runner output could not be parsed (exit ${r.code}) — NOT counted as green`);
    }
    else if (bad) {
      for (const p of PORTS.filter((x) => knownPorts.has(x.name))) {
        entry.acceptedDivergences.push(`${kind}: ${p.name} (known limitation)`);
      }
      // Anything not attributable to a known port is NEW.
      if (!entry.acceptedDivergences.length) {
        failed = true;
        entry.newDivergences.push(`${kind}: divergence not in known-limitations.json`);
      }
    }
  }

  mkdirSync(".", { recursive: true });
  appendFileSync(ledgerPath, JSON.stringify(entry) + "\n");
  return { entry, failed };
}

export function summarise(ledgerPath = process.env.ORACLE_LEDGER || "ledger.jsonl") {
  if (!existsSync(ledgerPath)) return { runs: 0 };
  const rows = readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const byKey = new Map();
  for (const r of rows) {
    for (const d of r.newDivergences || []) {
      const k = divergenceKey("new", d);
      const e = byKey.get(k) || { text: d, first: r.at, last: r.at, count: 0 };
      e.last = r.at; e.count++;
      byKey.set(k, e);
    }
  }
  const drift = {};
  for (const p of PORTS) {
    const seen = [...new Set(rows.map((r) => r.ports[p.name]).filter(Boolean))];
    drift[p.name] = { seen, drifting: seen.length > 1 };
  }
  const last = rows[rows.length - 1];
  return {
    runs: rows.length,
    first: rows[0]?.at,
    last: last?.at,
    currentlyGreen: last ? (last.newDivergences || []).length === 0 : null,
    newDivergences: [...byKey.values()],
    portDrift: drift,
  };
}

// The memory assertion. A scorer that cannot remember must not be able to
// report success, so the job asks the ledger whether THIS run is in it.
//
// The baseline matters: once the ledger is committed, "the file is non-empty"
// is true forever, and a run that recorded nothing would sail past that check
// on yesterday's rows. So this compares against the row count from BEFORE the
// run, and asks whether the ledger GREW.
export function assertLedger({ ledgerPath = process.env.ORACLE_LEDGER || "ledger.jsonl", before = 0 } = {}) {
  const s = summarise(ledgerPath);
  const grew = s.runs > before;
  console.log(`  ledger: ${s.runs} row(s), ${before} before this run${s.last ? `, last ${s.last}` : ""}`);
  if (!grew) {
    console.error(s.runs === 0
      ? "\nORACLE: FAIL (the ledger is empty -- this run recorded nothing)"
      : `\nORACLE: FAIL (the ledger did not grow: ${s.runs} row(s), unchanged since this job started -- this run recorded nothing)`);
  } else {
    console.log(`  grew by ${s.runs - before} row(s)`);
  }
  return grew ? 0 : 1;
}

function report({ entry, failed }) {
  const parts = [];
  for (const [k, v] of Object.entries(entry.suites)) {
    parts.push(`  ${k}: ${v.status}${v.total ? ` (${v.pass ?? v.agree}/${v.total})` : ""}`);
  }
  console.log(parts.join("\n"));
  if (entry.acceptedDivergences.length) console.log(`  accepted (known): ${entry.acceptedDivergences.join("; ")}`);
  if (entry.newDivergences.length) console.log(`  NEW: ${entry.newDivergences.join("; ")}`);
  console.log(failed ? "\nORACLE: FAIL (new divergence)" : "\nORACLE: green");
  return failed ? 1 : 0;
}

const [, , cmd, ...rest] = process.argv;
if (import.meta.url === `file://${process.argv[1]}`) {
  if (cmd === "run") process.exit(report(runOnce()));
  else if (cmd === "watch") {
    const secs = parseInt(rest[0] || "300", 10);
    console.log(`watching every ${secs}s — ctrl-c to stop`);
    // A local ledger, not the witness log: a laptop with no sibling checkouts
    // records every port as "unknown", which summarise reads as drift.
    const watchPath = rest[1] || process.env.ORACLE_LEDGER || "ledger.local.jsonl";
    console.log(`writing to ${watchPath}`);
    const tick = () => { try { report(runOnce({ ledgerPath: watchPath })); } catch (e) { console.error("  run threw:", e.message); } };
    tick(); setInterval(tick, secs * 1000);
  } else if (cmd === "ledger") console.log(JSON.stringify(summarise(), null, 2));
  else if (cmd === "assert") process.exit(assertLedger({ before: parseInt(rest[0] || "0", 10) || 0 }));
  else { console.log("usage: oracle.mjs run | watch [secs] | ledger | assert [rowsBefore]"); process.exit(2); }
}
