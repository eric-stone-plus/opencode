---
name: motoko-seat-ops
description: Use when driving MOTOKO security-orchestration operations from this
  host's agent seat — engine status checks (doctor, rules, digest, health), gated
  strix launches, strix shepherd systemd units, scan-wave supervision, egress
  verification before launches, campaign harvest/banking, or importing security
  skills into the corpus. Triggers: motoko, strix, shepherd, scan wave, campaign
  audit repo, egress check, skill import.
---

# MOTOKO seat operations

The engine owns scope, tool selection, scheduling, evidence and wave feedback.
This seat supervises: it reads engine state, issues bounded launches, manages
systemd units, and files results into campaign repos. Reproducing the engine's
scheduling in a hand-written loop, or writing to a live engagement's graph
directly, is the one class of mistake that defines this seat's existence —
the graph has exactly one writer, and it is the engine.

The project rules live in the engine repo's `AGENTS.md`
(`~/Documents/Development/private/agent-design/projects/motoko/AGENTS.md`).
Where this skill and that file disagree, that file wins; where it states a
number, that file owns the number and re-measurement.

## Seat surface

The opencode seat carries a plugin whose tools wrap the gated CLI
(`engine/host/opencode/plugin.ts`): `motoko_status` (digest/health/doctor/
rules/query/events), `strix_launch` (six-gate wrapper), `shepherd_ctl`
(systemd, stop is force-gated), `ingest_strix`, `seal_verify`. A bash gate
blocks raw strix binary invocations — launches only through the gated paths.

## Before any launch

1. **Proven egress, on the process that fires.** Read the live process, not
   your shell: `tr '\0' '\n' < /proc/<pid>/environ | grep MOTOKO_EGRESS_MODE`
   for every writer, then push an IP-echo through the same lane
   (`MOTOKO_EGRESS_ECHO_URL`) and read a non-home address. An undeclared
   mode, or `proxy` with no lane variable in that process, means stop and
   relaunch — an IP that reaches a target log is permanent. `doctor` cannot
   substitute: it reads the current shell. Re-verify after every restart.
   (Rules: AGENTS.md §0, §6.0.)
2. **Authorization on record.** Read the campaign's authorization record in
   its audit repo before launching anything. New targets need the operator's
   in-session sign-off; recon on a new domain additionally needs a
   WHOIS/ASN match against that grant. (AGENTS.md §3.)
3. **Budgets are seat-visible lookups.** Concurrency ceilings are measured
   facts that AGENTS.md §6.3 owns (LLM ceiling 9 account-wide in-flight,
   strix ≤ 2 concurrent — 1 during a loop audit phase; an explicit operator
   raise supersedes for the named push; nuclei ≤ 5, Kali 1). Re-measure
   rather than extrapolate across lanes.

## Driving a scan wave

Working surface: `motoko` console script (or `python3 -m core doctor` on a
fresh host). The strix wrapper ships only in the checkout — the exported
wheel deliberately lacks `scripts/`.

1. Preflight: `motoko doctor`, then `motoko rules` — returned counts report
   readiness without exposing paths or diagnostics.
2. Read `motoko digest` and `motoko health` for the engagement. Parked
   findings come with reasons: "could not verify" is a different state than
   "found nothing", and it stays that distinction.
3. Launch as a bounded call — explicit cycle, wave and wall-time budget.
   The engine picks scanners and order inside its rule corpus; the seat
   supplies only the budget.
4. Read the `summary`: `pending`, `stop_reason`, `waves`, `by_state`. A
   clean exit code says the call ended — not that scanners succeeded or
   findings were verified. Raw evidence stays on the engine host.
5. Decide each resume on remaining work plus authorization; honor
   `retry_after_s` and cool instead of polling.

Response semantics, and what each asks of the seat:

| Engine says | Seat action |
|---|---|
| `exhausted` | Inspect health and parked work; the frontier is empty |
| `waiting` | Resolve the reported blocker; cool down first |
| `wave_budget` / `cycle_budget` | Weigh one more bounded call against the remaining work; stop the wave when the return thins |
| `interrupted` in history | Inspect recovery state — tool records went terminal, the lease released, partial feedback persisted |
| `deadline_exceeded` / `cancelled` | Inspect status before any retry |
| transport failure | The outcome is uncertain. Read digest, events and health, then decide; an automatic retry of a mutation gambles duplicated work |

Two engine-interface caveats: external scanner subprocesses can re-resolve a
hostname after the scope precheck (DNS pinning is not universal), and when
cleaning up stray engine children, terminate recorded numeric PIDs/process
groups only — cleanup by name catches the wrong processes.

`query` and `events` are one-shot read-only listings, not cursor pages: `query`
dumps every matching entity in one pass (id, state, confidence, and the
entity's own title/value — graph strings, not pseudonyms), and `events` prints
a windowed tail (`--since-seq`, strictly greater, plus `--limit`, default 20;
narrow with `--kind`/`--entity`) that includes each event's raw payload text —
payloads are never hidden. `--json` emits the parsed payload verbatim, and an
undecodable row is printed raw with a marker rather than dropped. A tail is not
the whole story by default: keep re-running with a raised `--since-seq` until
the rows run out, and only then treat the tail as complete.

## strix line

strix follows engine evidence; it never opens a campaign by itself. The
engine marks app-facing hosts (auth, portal, upload, param-rich; info-level
fingerprints do not qualify) into the campaign's `highvalue-queue.txt`, the
shepherd deep-dives that queue, and `motoko ingest-strix` feeds reports back
into the graph. (AGENTS.md §6.0.1–§6.0.2.)

- **Launches go through the gate.** `motoko strix <eng> --target …` delegates
  to `engine/scripts/launch-strix.sh` (six fail-closed gates; a missing
  wrapper exits 2 with no fallback). A strix build missing a flag prints
  usage and exits 0 — that is a refusal, not a launch. Safe passthroughs:
  `--mode {deep,standard,quick}`, `--timeout`, `--egress-class` (resolves via
  `egress.classes` in `$MOTOKO_HOME/deploy.json`), `--no-rotate` (refused for
  non-local targets), operator `--instruction-file`.
- **Per-ignition check.** Every launch — wrapper or shepherd — needs
  `MOTOKO_EGRESS_MODE=proxy`, `https_proxy`, and a well-formed
  `MOTOKO_CAIDO_UPSTREAM` in the firing process's environment, confirmed by
  the "Caido upstream wired" marker in the run dir's `strix.log` within
  90 seconds; past that window without the marker, kill the tree by numeric
  pgid. strix treats the upstream variable as optional and will egress the
  sandbox directly if the check is skipped.
- **Shepherds are systemd user units.** Units are named per campaign
  (`strix-shepherd-<campaign>[-b|-dyn-a|-dyn-b].service`, plus the canonical
  bare `strix-shepherd.service`); check with
  `systemctl --user status 'strix-shepherd-*'`. Manage them only through
  systemctl — spawning a shepherd from an agent session ties its lifecycle
  to that session, and session death takes the worker scope with it.
  `ALL_DONE` is a normal exit: leave it stopped; `Restart=on-failure` covers
  abnormal exits. A unit environment is a launch surface — audit the live
  shepherd's `/proc/<pid>/environ` before trusting it.
- **Dynamic shepherd (dyn lanes).** The `strix-shepherd-<campaign>-dyn-{a,b}`
  units run
  the scored-queue shepherd: targets ranked by breadth evidence, mode
  assigned by score (deep/standard/quick), katana pre-triage downgrade,
  no-convergence early abort, sibling boost on real findings. Before
  lighting lane B, measure the live session's LLM call rate over one
  60–90 s window; keep the total under the §6.3 ceiling and re-measure
  after B fires. Watch rate-limit refusals with a word-boundary grep — a
  bare `429` matches timestamps and hash ids.

## Harvest and banking

Campaign results live in per-org audit repos
(`private/network-audit/<org>-audit/` and per-line evidence trees): target
intel never lands in the engine tree. After a batch: write `reports/`
entries pointing into `evidence/campaign-…`, noise filtered.

Shepherd coverage is the union of STAGE ∪ EVIDIR ∪ BANK keyed on the slug
prefix (and its 32-char truncation). Failed sessions whose only output is
coverage-class SARIF stay out of EVIDIR — the worth gate. STAGE is tmpfs:
rescue transcripts that matter before they evaporate. Run artifacts under
any tools checkout are campaign-owned — sweep them into the campaign repo.

## Manual verification bar

When verifying a finding by hand: one in-flight probe per registrable
origin, scope-file discipline — every active request goes at a host on the
campaign's allowlist, off-scope redirects stop for operator confirmation —
and a verdict ladder of identified → partial (defense held) → confirmed
(observable behavior change) → critical (data or code). A blocked payload is
a candidate, not a clean bill: run the class's bypass set before recording a
false positive. Findings enter a report only at confirmed or higher, each
carrying the command that reproduces it and the output it produced. Captured
secrets go to the campaign vault whole; in any conversation or report they appear as
fingerprint prefix plus last three characters, and key-bearing files are
inspected with field-targeted filters only (AGENTS.md §6.8 owns the full
discipline).

## Corpus hygiene

- Every imported security skill passes the guard scan before entering the
  tree; "never scanned yet" is not a state. A blocked verdict is exempted
  only by a written rationale recording why the hits are descriptive
  methodology rather than executable injection.
- The import face stays permissive-licensed only; a copyleft package is
  excluded, not adapted. Payload corpora ride outside the tracked tree.
- The rs-* corpus (43 modules, upstream MIT) survives only in the retiring
  host's profile git repo (`~/.hermes/profiles/penetrate`) — and so do the
  kali-pentest and web-pentest reference trees dying with the same host.
  Clone the whole profile repo before that host is retired.
