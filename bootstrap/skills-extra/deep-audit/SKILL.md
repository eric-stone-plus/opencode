---
name: deep-audit
description: >
  Deep review/audit for the user-invoked "审查", "review", "做好代码审查",
  "深度审计", or "deep-audit". Runs the full review-delegate coverage ledger,
  OCR at medium/high effort, independent verification of critical/high
  findings, and the Cloudflare 6-phase protocol when a sandbox is available;
  returns a fail-closed verdict. Bare "审查"/"review"/"做好代码审查" defaults to
  deep review; "深度审计"/"deep-audit" selects deep audit. The normal review is
  auto-triggered by code edits in GOAL mode and is a different skill.
---

# Deep review / deep audit

This is the **user-invoked deep path**. The normal per-edit review is
`code-review-playbook`; do not run this skill automatically after edits.

## Mode selection (read the user's words)

- **"审查" / "review" / "做好代码审查"** → **deep review**: review the diff or
  repo the user named (default: the current change set) with the full
  `review-delegate` coverage ledger, OCR at medium effort, and an independent
  verifier for every critical/high finding. Do not run the full 6-phase
  sandbox protocol unless the user says "深度审计"/"deep-audit" or asks for a
  full-repo audit.
- **"深度审计" / "deep-audit"** → **deep audit**: audit the whole repository at
  a pinned commit. If an OS-enforced sandbox is available, follow the
  Cloudflare 6-phase protocol below; if not, run the static deep review and
  mark execution-dependent findings `needs_validation`. Never pretend a static
  run is a sandboxed audit.
- If the user gives both a phrase and an explicit scope, the scope wins; the
  phrase selects the mode.

## 0. Non-negotiable rules

- **Never ask** for a base/spec/approval. Choose defaults, state them, finish.
- **Review/audit only.** Do not edit target code/tests/config; do not
  "fix while reviewing". Findings go in the report.
- **No single-pass LGTM.** Run deterministic checks, the two-axis review, and
  the OCR gate; a deep audit also runs the coverage ledger and verifier.
- **No "no vulnerabilities".** Say "no critical/high found in scope X with
  checks Y at effort Z, with these limitations." Absence of evidence is not a
  proof of absence.
- **No silent skips.** If a check/tool/sandbox cannot run, say so and use
  `INCOMPLETE` or `needs_validation`; never quietly narrow the scope.
- **No new finding schema.** Use the `/review` structured-findings contract
  from `review-delegate`/`code-review` and the `code-audit` report contract.
- **No hunter/verifier pair on every change.** One fresh verifier for the
  critical/high findings that need it; not a second full review.
- **No auto-fix, no SCA/SARIF substitution.** Use the repo's own checks and
  OCR; CodeQL/Semgrep/Snyk are complementary, not a replacement.
- **Respond in the user's language.** Keep the structured headings; write the
  prose in Chinese when the user writes Chinese.

## 1. Pin the scope and read the intent

For **deep review**, use the user's base/commit/branch. If none is named, use
the same default as the normal playbook: workspace changes vs `HEAD`, else the
merge-base with `origin/HEAD`, else `HEAD~1`, else the named path. State the
base, mode, changed files, and +/− lines at the top of the report.

For **deep audit**, pin the commit: `git rev-parse HEAD`, record it, and audit
that tree. If the working tree is dirty, say so and audit the pinned commit
plus the dirty diff as a separate scope; state the chosen pin and scope. Do not
silently audit a moving tree.

Find the spec in this order: issue references in commit messages (`#123`,
`Closes #45`), a path the user named, `docs/`, `specs/`, `.scratch/`, or a
`spec.md`/`requirements.md` matching the branch/feature. Read it.

- No spec: run Standards + Security; report `Spec: skipped (no spec found)`.
- Feature with no spec: spec axis `INCOMPLETE`; say what is missing.
- Bug fix/refactor: proceed without a spec.
- High-risk areas: auth, authz, crypto, secrets, payments, PII, uploads,
  deserialization, SQL/NoSQL, command execution, SSRF, path traversal, template
  injection, CI/CD, dependency lockfiles, migrations, public API, concurrency,
  resource limits. A deep review must cover every high-risk area in scope; a
  deep audit must cover every source file.

## 2. Deterministic checks

Discover the repo's own commands from `README.md`, `CONTRIBUTING.md`,
`AGENTS.md`, `Makefile`, `justfile`, `package.json` scripts, `pyproject.toml`,
`Cargo.toml`, `go.mod`, and `.github/workflows`. Prefer the documented
`check`/`test`/`lint`/`typecheck` commands; do not invent a build system.

Run the smallest relevant set, for example:
- Node: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`;
  `pnpm` equivalents.
- Python: `python3 -m pytest`, `python3 -m unittest`, `ruff check`, `mypy`.
- Rust: `cargo test`, `cargo clippy -- -D warnings`.
- Go: `go test ./...`, `go vet ./...`.
- TypeScript: `tsc --noEmit`.

Record each exact command and its real exit code; do not hide a failure behind a
pipe. Also run `git diff --check`; run the repo's dependency audit when
lockfiles/manifests changed (`npm audit`, `pnpm audit`, `cargo audit`,
`govulncheck`) and `trivy fs --scanners secret` when secrets/auth/crypto/CI
changed, if available.

If the repo defines no checks: say "no deterministic checks defined." For a
behavioral change with no tests, `NEEDS-FIXES` unless docs/config-only; do not
call it verified.

## 3. Full two-axis with a coverage ledger

Use `review-delegate` (not the light `code-review` path):

```bash
bun ~/.config/opencode/skills/review-delegate/scripts/build-review-spec.ts \
  --repo <repo> [--from <base> --to HEAD | --commit <sha>]
```

Then follow the `review-delegate` skill's steps 3–7: load the spec and
standards, dispatch parallel Standards and Spec sub-agents, produce the
`/review` structured findings, and fill the coverage ledger.

**Override `review-delegate` step 1's "ask for a fixed point".** This skill
never asks: if the user named no base/commit/branch, choose the default from
section 1, state it, and pass it to the helper. A deep audit uses the pinned
commit, not a moving base.

- Every changed file appears exactly once: reviewed or explicitly skipped with
  a reason. For a deep audit, `review-delegate` covers the change set only; the
  full-repo coverage ledger is built in section 5 from the pinned tree. Do not
  treat the diff-only file list as full-repo coverage.
- The full-repo ledger covers every source file in the pinned commit (exclude
  generated/vendor files and say what was excluded).
- Test files in the diff are behavior signal: review them and mark them
  `reviewed`; do not inherit OCR's default test-file skip.
- Standards and Spec are separate axes; do not rerank across them. A finding
  needs `file:line`, the rule/smell or spec requirement, and a concrete fix.
- If the coverage ledger has a gap, the verdict cannot be APPROVE.

## 4. Security gate (deep)

The `open-code-review` plugin may already have run its automatic gate at
`low`/`medium` after the edit. Note its effort, scope, and critical/high
findings; reuse them. A deep run is a **deliberate escalation**, and the
`code-audit` stop rules still apply. Do not loop.

Load `code-audit` and run the manual OCR path.

**Deep review (diff/range/commit)** — `ocr review` with `medium`:

```bash
ocr review --repo <repo> [--from <base> --to HEAD | --commit <sha>] \
  --effort medium --format json --audience agent \
  --provider deepseek --model deepseek-flash \
  --max-tokens-budget 40000 --timeout 15 --concurrency 4
```

Use `high` only for a release-gate deep review of the diff; do not run the
same diff hash at the same effort twice. If the automatic gate already ran at
`medium` on this diff hash, reuse it.

**Deep audit (full tree)** — `ocr scan` (no `--effort`; declare weak coverage:
scan has no run-manifest and no effort preset):

```bash
ocr scan --repo <repo> --format json --audience agent \
  --provider deepseek --model deepseek-flash \
  --max-tokens-budget 40000 --timeout 15 --concurrency 4
```

The full-repo security gate is the scan plus the coverage ledger and the
Cloudflare protocol; the scan alone is not a full audit. If the automatic gate
already found critical/high on the diff, reuse it.

- For `ocr review`, choose the effort **before** the run: `medium` for deep
  review; `high` for a release gate. If the automatic gate already ran at the
  same effort on this diff hash, reuse it. Do not run the same effort twice;
  the stop rules cap the total runs. `ocr scan` has no effort preset; declare
  its weak coverage.
- Keep only `category in {security,bug}` and `severity in {critical,high}`.
- For every blocking finding: `file:line`, raw code, and a `source → sink` line
  or one repro command that runs in <2 minutes.
- Run the `code-audit` 10-line checklist for what OCR may miss: authz/IDOR,
  business logic, secrets, error leakage, input boundaries, XSS/CSRF, path
  traversal/upload, deserialization/eval, rate limiting, dependency/lockfile.
- **Independent verifier.** For each critical/high in a high-risk area that
  lacks a source→sink line or repro, dispatch one fresh verifier (a sub-agent
  that did not write the finding) with the finding, the code, and the spec.
  The verifier tries to refute it: `confirmed` only if the path is real and
  reachable; `rejected` if the sink is unreachable/sanitized; otherwise
  `needs_validation`. Do not let the original finder verify itself.
- `unverified` needs a named blocker and expiry; cap at 3; more than 3 →
  `INCOMPLETE`. A critical/high that remains unverified after the verifier is
  `BLOCKED`.
- Respect the `code-audit` stop rules: no loop; same diff hash, 2 empty runs,
  3 runs, 120k tokens, 2 injections, 2 OCR errors stop the gate.
- If OCR is unavailable or fails: say so, fall back to the 10-line checklist +
  manual source review, and mark the security gate `INCOMPLETE`. Do not approve
  a high-risk change without a security gate.

Never say "no vulnerabilities"; use the `code-audit` report contract: OCR
version, effort, scope, counts, unverified, Standards/Spec summary.

## 5. Deep audit mode: the Cloudflare 6-phase protocol

Only for "深度审计"/"deep-audit" or an explicit full-repo audit. This is a
reference protocol, not a shipped scanner.

Prerequisites:
- **OS-enforced sandbox.** No sandbox → do not run the 6-phase execution
  protocol; run the static deep review (sections 1–4) and mark
  execution-dependent findings `needs_validation`. Never execute target code
  on the host as a substitute for a sandbox.
- **Pin the commit** and record it in the report. Apply the upstream fixes
  #75 (target content/Windows/CI) and #76 (git config) if using the reference
  implementation; note if they are absent.
- **Coverage ledger**: every source file in the pinned tree, with a state
  (`reviewed` / `needs_validation` / `rejected` / `excluded` + reason).
- **Tri-state**: `confirmed` / `needs_validation` / `rejected`. `confirmed` is
  an agent assertion, not machine truth; validators prove format/ledger only.
- **Independent verifier** for critical/high findings; fail-closed policy.
- **Multiple passes**: one run finds about half; run at least two passes with
  fresh eyes for a release gate, or state the single-pass limitation.
- **No SCA/SARIF/autofix/crash-resume.** Use CodeQL/Semgrep/Snyk separately;
  do not pretend they are the protocol.

The six phases, in order:
1. Scope and coverage ledger.
2. Inventory and triage of every source file (entry points, data flows,
   high-risk sinks).
3. Deep review per file/flow; record findings with file:line and source→sink.
4. Independent verification of critical/high; tri-state each finding.
5. Fail-closed consolidation: unresolved critical/high blocks; gaps become
   `INCOMPLETE`.
6. Report with coverage, findings, limitations, and the pinned commit.

## 6. Verdict (fail closed)

Choose exactly one:

- **BLOCKED** — unresolved critical/high security finding, secret, a high-risk
  change with an unverified critical/high, or a failing check that indicates
  security/data loss.
- **NEEDS-FIXES** — any high finding (Standards/Spec/Security) or a failing
  deterministic check; no blocking security.
- **APPROVE-WITH-NITS** — findings exist but none high; all deterministic
  checks pass; security clear; coverage complete.
- **APPROVE** — no findings; all deterministic checks pass; security clear;
  coverage complete; scope and spec status stated.
- **INCOMPLETE** — a required check/tool/sandbox could not run, >3 unverified,
  a coverage gap, no diff/scope, or a feature with no spec that cannot be
  assessed.

`APPROVE` is a deep gate, not a proof of absence. State what would change the
verdict and which findings are `needs_validation`.

## 7. Report

Use the `/review` structured findings contract for findings. Include:

1. **Mode and scope** — deep review vs deep audit; base/commit pin; changed or
   covered files; +/− lines; spec source.
2. **Checks** — every command and result (pass/fail/skipped), including the
   exact failure output for a failing check.
3. **Security** — OCR version/effort/scope, critical/high count, each finding
   with file:line and source→sink/repro, verifier state, unverified count.
4. **Standards** — findings, with file:line and the rule/smell.
5. **Spec** — findings, or "skipped (no spec found)" / "INCOMPLETE (feature, no
   spec)".
6. **Coverage** — the ledger: every file, reviewed/skipped with a reason; test
   files escalated.
7. **Verdict** — one of the five; what would change it.
8. **Not checked / limitations** — missing tools, no sandbox, single pass,
   scope excluded, execution-dependent findings marked `needs_validation`.
9. **Bottom line** — one paragraph the user can act on without re-running
   anything.

Write in Chinese when the user writes Chinese. Every claim needs evidence.

## 8. Research basis

See `../code-review-playbook/REFERENCES.md` for the competitive research and
the source report in the archive. The short version: Cloudflare's skill is a
protocol, not a product; use its principles for deep audits, not as a per-PR
scanner. The normal per-edit gate is `code-review-playbook`; this skill is the
deep path.
