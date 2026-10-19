---
name: code-audit
description: >
  Security gate and audit ladder for code changes. Use after editing code,
  before a PR/release, or when asked to audit a repo. The OpenCode plugin runs
  the automatic OCR gate; this skill covers the manual/final path, the 10-line
  checklist, the L0-L4 marginal-benefit ladder, bounded unverified findings,
  and the OCR-owned report contract. Never claims "no vulnerabilities".
license: Apache-2.0
compatibility: >
  Requires the `ocr` CLI and the `open-code-review` OpenCode plugin.
metadata:
  author: alibaba
  homepage: https://github.com/alibaba/open-code-review
  version: "1.0.0"
---

# Code audit

OCR is the engine. `code-review` remains the host method (Standards + Spec).
The GOAL layer owns discussion and adversarial attack; this skill owns the
security gate and its bounded report.

## Automatic path (the OpenCode plugin)

The `open-code-review` plugin is vendored in this seat and installed by
`install.sh` (`bootstrap/plugin/open-code-review.ts`); the OpenCode core does
not ship it. After an edit/write/patch (or an `apply_patch`/`multiedit` alias)
or a shell command that writes code, in a `goal`, `auto`, or `build` session it:

1. debounces 2.5s, finds the git repo, and hashes the tracked diff plus the
   content of untracked code files (a path-only hash would miss the second edit
   of a newly created file). Large data files use size+mtime; a code file past
   the 128-file cap fails closed;
2. skips an unchanged hash;
3. runs `ocr review --effort low` with `--max-tokens-budget 60000`,
   `--timeout 10`, `--concurrency 4`; a dispatch-time budget rejection
   escalates the per-run budget 60k → 120k → 160k;
4. keeps only `category ∈ {security,bug}` and `severity ∈ {critical,high}`;
5. fingerprints findings, injects a bounded `[security-gate]` system note on
   the next request (line breaks escaped, explicitly marked untrusted data),
   and stops after 3 runs, 240k total tokens, 2 empty runs, 2 injections,
   2 OCR errors, or an unchanged hash. A terminal failure injects one visible
   disable note instead of failing silently.

The gate uses OCR's configured provider/model; it never overrides them.
Disable it with `OPENCODE_SECURITY_GATE=0` (or `OCR_SECURITY_GATE=0`).

## Manual path (when the automatic gate is unavailable or failed)

```bash
ocr review --effort low --format json --audience agent \
  --provider deepseek --model deepseek-flash --max-tokens-budget 120000
```

1. Keep only `category in {security,bug}` and `severity in {critical,high}`.
2. For every blocking finding, give `file:line` + raw code, then one of:
   - a `source → sink` line (e.g. `app.js:7 req.query.id → app.js:8 db.query`);
   - one repro command that runs in <2 minutes;
   - `unverified` with a named blocker and expiry.
   `unverified` is capped at 3 per review. More than 3 → report `INCOMPLETE`.
3. Run the host `code-review` Standards axis. Run Spec only when a spec/issue
   exists; tell Spec **not** to report security (OCR covers it).
4. Report OCR version, effort, scope, counts, and unverified. Never say
   "no vulnerabilities"; say "no critical/high found in scope X at effort Y".

A full scan uses `ocr scan --path <path>`; declare weak coverage (scan has
no run-manifest and no `--effort`). The release path uses `--effort high`,
high-risk directories, and SARIF; it is not a daily path.

## Report contract

```text
OCR <version> | effort low | scope: 3 files, +24/-0
security|bug high/critical: 3
- critical app.js:8  [security] SQLi — source app.js:7 req.query.id → sink app.js:8 db.query
- critical app.js:14 [security] missing authz — no auth middleware in repo
- high     app.js:15 [bug] unvalidated id — no 400 path
unverified: 0/3
Standards: 2 (comment only) | Spec: skipped (no spec)
Verdict: BLOCKED | NEEDS-FIXES | APPROVE-WITH-NITS | APPROVE | INCOMPLETE
```

## 10-line checklist (L0, free, always in context)

1. Injection: SQL / command / template / LDAP.
2. Authentication and authorization; IDOR on every object id.
3. Secrets and keys in code, config, logs, error bodies.
4. Error leakage: stack traces, SQL errors, internal paths.
5. Unvalidated input at every trust boundary.
6. XSS / CSRF / open redirect.
7. Path traversal and unsafe file upload.
8. Unsafe deserialization / eval / dynamic import.
9. Rate limiting and brute-force protection.
10. Dependency CVE and lockfile drift.

## Marginal-benefit ladder (never a /loop)

Escalate only when the previous layer produced a **new** high/critical
fingerprint. No new fingerprint = stop.

| Level | Action | Cap |
|---|---|---|
| L0 | 10-line checklist | free, always |
| L1 | `ocr review` low on the diff | 1 per diff hash; 3 runs/session; 60k per-run budget, escalates to 120k/160k on a dispatch-time rejection; 10 min timeout |
| L2 | `ocr scan --path <file>` for a critical in auth/crypto/input/secrets | 1/session; manual |
| L3 | one repro/test only when a feedback loop exists | 1/session; <2 min |
| L4 | human/external pentest for critical findings that cannot be verified statically | handoff |

**Stop rules:** same diff hash; 2 consecutive runs with no new fingerprint;
3 runs; 240k total tokens; 2 injections; 2 OCR errors. Any one stops the gate;
a terminal failure injects one visible disable note.

**Kill criteria:** after 2 weeks, if new high/critical findings per 10 runs is
<1 or the action rate is <30%, set `OPENCODE_SECURITY_GATE=0` and keep the
manual `ocr review` path. A gate that does not pay for itself is noise.

## Mattpocock skills: roles, not substitutes

- `code-review`: Standards + Spec, two axes, no third axis. Spec excludes
  security because OCR owns that category.
- `grilling` / `grill-me`: attack the design and the findings. They do not
  execute code and cannot turn `unverified` into `verified`. This is a GOAL
  layer method, not an OpenCode default.
- `tdd` / `diagnosing-bugs`: use only when a feedback loop exists; write one
  failing test/repro. That is proof, not TDD ceremony.
- `codebase-design`: keep this layer a deep module — one skill, one command,
  one gate.
- `review-delegate`: the deep path (OCR delegate + two axes); do not duplicate
  its coverage ledger.
- `retro`: after 2–4 weeks, decide whether any capped/killed layer earned a
  return. `handoff`: carry scope/effort/unverified across sessions.

## Do not build

- A third "Security" axis.
- A custom finding schema or four-dimensional coverage ledger.
- A Prove mode / permanent sandbox.
- An unbounded `needs_validation` bucket.
- A hunter/verifier subagent pair that runs on every change.
- A daily `--effort high` or whole-repo scan.
- A claim of "no vulnerabilities".
