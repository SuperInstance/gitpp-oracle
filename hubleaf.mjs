#!/usr/bin/env node
// Leaf wrapper for the TypeScript hub.
//
// The hub is the REFERENCE implementation, which is exactly why it needed
// measuring: "all five ports agree" was a claim about five ports and said
// nothing about the reference they were all ported from. It does not.
//
// Requires the hub compiled to ESM first (tsc -> OUT_DIR), since the oracle
// must not assume a build system it does not control.
import fs from "node:fs";

const modPath = process.env.HUB_BUILD || "/tmp/hub-build/fold.js";
const { recordLeaf } = await import(modPath);

const recs = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const out = [];
for (const r of recs) {
  try { out.push(recordLeaf(r)); } catch (e) { out.push("ERR:" + String(e.message).slice(0, 80)); }
}
fs.writeFileSync(process.argv[3], out.join("\n") + "\n");
