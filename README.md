# gitpp-oracle

> Continuous cross-port differential conformance for the git.pp fold. An append-only ledger, a known-limitation contract, and a rule that the oracle never reports green when it cannot tell.

## Why

A conformance suite you run once is a snapshot. The ports keep moving, the
corpus keeps growing, and the interesting failure is the one that appears at
3am on a Sunday between releases. That needs a runner that loops, keeps
history, and knows the difference between *"I broke something"* and *"this was
always broken and I already wrote it down"*.

## The contract

`known-limitations.json` is the load-bearing file. It lists divergences that
are **known, characterised and accepted**. The oracle exits **0** while only
those persist, and **non-zero the moment anything else appears**.

That is the whole design. A permanently-known edge case must not silence a
real regression, and a known one must not cry wolf every cycle.

```json
{
  "id": "perl-float64-domain",
  "port": "pl",
  "class": "bare integer literal in [2^63, 1e21)",
  "statement": "JSON::PP returns such a literal as a string (too large for a
                UV/IV) or an exact int64 (which fits), and neither is
                distinguishable from a genuine JSON string, so the port cannot
                recover the float64 the spec requires.",
  "why_not_fixed": "The information is destroyed by the decoder. Recovery needs
                    a parser that records per value whether the source text was
                    a bare number, i.e. tokenising the input."
}
```

## Fail closed

An earlier draft mapped an unparseable suite result to `green`. That converts
a broken harness into a passing badge — the same defect class that produced
seven false-green suites in this project. Now:

```
leaf: unknown        ->  ORACLE: FAIL (runner output could not be parsed)
```

Same rule as `gitpp-gate`'s routing and spec §5.7: **absent signal is not
consent.**

## The ledger

Append-only JSONL, one record per run:

```json
{
  "at": "2026-10-16T04:03:11Z",
  "ports": { "doctor": "6f040af", "js": "3461d31", "c": "c125cd1", ... },
  "suites": { "leaf": {"agree":500,"disagree":0,"errors":0,"status":"green","ms":162100},
              "fold": {"pass":26,"fail":0,"status":"green","ms":41000} },
  "newDivergences": [],
  "acceptedDivergences": ["leaf: pl (known limitation)"]
}
```

The **per-port git SHA** is the part a pass/fail badge cannot give you. After
a week of hourly runs you can answer *"it was green yesterday"* — and more
usefully, *"it went red exactly when `gitpp-pl` moved to f411bde."*

`node oracle.mjs ledger` summarises: run count, first/last, whether it is
currently green, every new divergence with first-seen/last-seen/count, and
per-port version drift.

## It measures the reference too

The suite runs five *ports*. That is a claim about five ports, and it says
nothing about the reference they were all ported from — which is the thing
that was never in the set, and the thing that turns out to diverge.

The leaf suite now measures the hub as a sixth participant and reports the two
numbers separately:

```
  ports     : 20043/20043 agree with each other
  hub (ref) : 19595/20043 agree with the ports
```

Reported separately on purpose. Folding the reference into one `agree` count
would make five conformant ports look broken because the reference diverges,
which is the opposite of what the suite is for. The ports are the subject; the
hub is what they are measured against.

The hub is compiled with `tsc` to ESM and imported by `hubleaf.mjs`. Set
`HUB_BUILD` to the compiled `fold.js`; when it is absent the runner is not
registered, and an **absent reference is reported as absent, not as agreeing**.

The Elixir port (`patchwork-quilt/gitpp-beam`) is not measured — there is no
BEAM toolchain here. Its divergence is static-analysis only and is filed as
[gitpp-beam#2](https://github.com/patchwork-quilt/gitpp-beam/issues/2). It is
listed here so the gap is visible rather than forgotten.

## Run

```bash
# siblings
for p in gitpp-doctor gitpp-js gitpp-cs gitpp-pl gitpp-c \
         gitpp-cross-port gitpp-fold-conformance; do
  git clone --depth 1 https://github.com/SuperInstance/$p ../$p
done
(cd ../gitpp-c && gcc -O2 -o CLleaf CLleaf.c -lm)
(cd ../gitpp-cross-port && dotnet build CsLeaf)

node oracle.mjs run              # one pass
node oracle.mjs watch 900        # every 15 min
node oracle.mjs ledger           # summary
```

`ORACLE_CORPUS` selects the corpus for the leaf suite (default
`/tmp/oracle-corpus.json`, 500 records). `ORACLE_TIMEOUT_MS` sets the
per-suite timeout (default 1,800,000 = 30 min).

**Corpus size used to be the throughput problem, and it was the runner's
fault, not the ports'.** The first real run used the full 20,043-record
corpus: fold came back green in 27.8s while leaf hit the 15-minute
timeout. The cause was five process spawns *per record* — 100,215 spawns
for the corpus, at ~0.55s each. The ports themselves are microseconds.

Batching the runner fixed it: the full corpus now runs in **37 seconds**,
so the default moved from a 500-record sample to the whole thing.
Sampling was solving a problem that no longer existed — and sampling is
precisely what hid two real bugs (`code_point_cmp`'s `$a`/`@a` shadowing
and its inverted prefix case), both of which only surface on keys sharing
a prefix or containing non-ASCII, i.e. the tail of the corpus.

## What hardware would add

Designed for a machine that has not arrived. Concretely:

- **Long horizons.** A laptop runs this a few times a day. Hardware runs it
  continuously, which is the only way to see the failure that only appears
  after 4 hours of accumulated state or a dependency bump on day 9.
- **Wide corpora.** The leaf suite is 20,043 records. On good hardware that is
  minutes instead of ~30, so the corpus can grow to millions and the fuzz can
  become continuous rather than sampled.
- **Differential across *time*, not just across ports.** With a long ledger,
  "did the pinned digests change without a commit?" becomes a query rather
  than a hunch — that is a supply-chain check on your own ports.
- **Redundant runners.** Two machines running the same corpus and comparing
  ledgers turns a single green into a quorum.

## Limits

- It shells out to the two suites; it does not reimplement them. If a suite's
  output format changes, the oracle reports `unknown` and fails, which is the
  intended behaviour.
- Parsing is by tail regex, so a suite that changes its summary line needs a
  parser update. Deliberate: a silent parse failure would be worse.
- The `c` port has no `derive()`, so it is excluded from the fold suite by
  construction rather than by a check.
- **The fold suite it shells out to had its own defects.** For several
  rounds `gitpp-fold-conformance/run.mjs` had `ROOT` hardcoded to a scratch
  directory, so the suite in the repo was not the suite under test, and it
  stripped `setters` values out of the comparison, so the §5.6 case could not
  fail. Both are fixed; both were found by the `gitpp-fold-conformance`
  negative control, not by this oracle. **An oracle inherits the blind spots
  of whatever it shells out to.**
