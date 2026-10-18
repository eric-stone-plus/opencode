---
name: code-review-playbook
description: >
  Normal code review, auto-triggered after code edits in GOAL mode. Runs
  deterministic checks, a quick Standards+Spec review, and the code-audit OCR
  gate, then returns a fail-closed verdict with evidence. Use this for the
  automatic normal review after edit/write/patch; do NOT use it for the
  user-invoked "审查", "review", "做好代码审查", "深度审计", or "deep-audit" —
  those default to the `deep-audit` skill.
---

# Normal code review playbook

This is the **normal review** path. It is automatic in GOAL mode after any
edit/write/patch to code; it is not the user-invoked deep review/audit. For
"审查"/"review"/"做好代码审查"/"深度审计"/"deep-audit", load `deep-audit`.

## 0. Non-negotiable rules

- **Normal review is automatic.** In GOAL mode, after code edits, run this
  before declaring the change done; do not wait for the user.
- **Do not run the deep path here.** No `review-delegate`, no independent
  verifier, no Cloudflare 6-phase, no sandbox. If the normal review finds a
  critical/high finding or the change is high-risk, report `BLOCKED` and
  recommend `deep-audit`; do not silently upgrade to a deep audit.
- **Never ask** for a base/spec/approval. Choose defaults, state them, finish.
- **Review only.** Do not edit target code/tests/config.
- **No single-pass LGTM.** Run deterministic checks and the OCR gate.
- **No "no vulnerabilities".** Say "no critical/high found in scope X with
  checks Y at effort Z." A normal review is a per-edit gate, not a deep proof.
- **No silent skips.** If a check/tool cannot run, say so and use `INCOMPLETE`.
- **No new finding schema.** Use the `/review` contract from `code-review` and
  the `code-audit` report.
- **No hunter/verifier pair.** The deep verifier belongs to `deep-audit`.
- **Respond in the user's language.** Keep the structured headings; write the
  prose in Chinese when the user writes Chinese.

## 1. Pin the scope without asking

If the user named a base/commit/branch, use it. Otherwise choose in this order:

1. **Working tree changes:** if `git status --porcelain` is non-empty, review
   the workspace against `HEAD` (`git diff HEAD` plus untracked files). Base =
   `HEAD`, mode = `workspace`.
2. **Branch vs default:** if the tree is clean and `origin/HEAD` resolves, use
   the merge-base with the default branch:
   `git merge-base HEAD "$(git symbolic-ref refs/remotes/origin/HEAD | sed 's#refs/remotes/origin/##')"`.
   Base = that merge-base, mode = `range`.
3. **Last commit:** if there is no origin, use `HEAD~1` when it resolves.
4. **No git / no commits:** review the path the user named, or the current
   directory; state that there is no diff and list the files.

Run `git rev-parse <base>` and `git diff --stat <base>...HEAD` (or
`git diff --stat HEAD` for workspace). If the diff is empty, report
`INCOMPLETE — no changes in scope` and stop.

State the chosen base, mode, changed files, and +/− lines at the top of the
report. Do not ask.

## 2. Read the intent

Find the spec in this order: issue references in commit messages (`#123`,
`Closes #45`), a path the user named, `docs/`, `specs/`, `.scratch/`, or a
`spec.md`/`requirements.md` matching the branch/feature. Read the spec and the
changed files.

- If no spec: run Standards + Security; report `Spec: skipped (no spec found)`.
- If the change is a feature and no spec exists, you cannot claim spec
  compliance; mark the spec axis `INCOMPLETE` and say what is missing. For a
  bug fix or refactor, proceed without a spec.
- Identify high-risk areas: auth, authz, crypto, secrets, payments, PII,
  uploads, deserialization, SQL/NoSQL, command execution, SSRF, path traversal,
  template injection, CI/CD, dependency lockfiles, migrations, public API,
  concurrency, resource limits.

## 3. Deterministic checks (run before the LLM review)

Discover the repo's own commands from `README.md`, `CONTRIBUTING.md`,
`AGENTS.md`, `Makefile`, `justfile`, `package.json` scripts, `pyproject.toml`,
`Cargo.toml`, `go.mod`, and `.github/workflows`. Prefer the repo's documented
`check`/`test`/`lint`/`typecheck` commands. Run the smallest relevant set; do
not invent a build system.

Examples (use only what exists):
- Node: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`;
  `pnpm` equivalents.
- Python: `python3 -m pytest`, `python3 -m unittest`, `ruff check`, `mypy`.
- Rust: `cargo test`, `cargo clippy -- -D warnings`.
- Go: `go test ./...`, `go vet ./...`.
- TypeScript: `tsc --noEmit`.

Record each exact command and its real exit code. Do not hide a failure behind a
pipe; use `set -o pipefail` or capture the exit code separately.

Also run:
- `git diff --check` for whitespace/conflict markers.
- If lockfiles/manifests changed: the repo's audit (`npm audit`, `pnpm audit`,
  `cargo audit`, `govulncheck`) or `trivy fs --scanners vuln` if available. If
  none can run, mark dependency risk `INCOMPLETE`.
- If secrets/auth/crypto/CI changed: `trivy fs --scanners secret` if available;
  otherwise inspect the diff manually and say which method you used.

If the repo defines no checks: say "no deterministic checks defined." For a
behavioral change with no tests, `NEEDS-FIXES` (add tests) unless it is
docs/config-only; do not approve as verified.

## 4. Quick two-axis review

Use `code-review` only. Do not use `review-delegate` here; the coverage ledger
and full deep path belong to `deep-audit`.

- Load `code-review` and run Standards + Spec on the diff. Supply the base
  chosen in section 1; tell the sub-agents **not to ask** for a base/spec.
- If no spec, skip Spec and say so; do not invent one.
- Build a manual changed-file coverage list: every changed file is either
  reviewed or explicitly skipped with a reason.
- OCR excludes test files by default. A test file in the diff is behavior
  signal: review it and mark it `reviewed` in the coverage list; do not inherit
  the OCR skip silently.
- Use the `/review` structured findings contract from `code-review`; no new
  schema. Standards and Spec are separate; do not rerank across axes.
- If the diff is >200 changed lines or touches a high-risk area, the normal
  review is not sufficient: report `INCOMPLETE`/`BLOCKED` and recommend
  `deep-audit`; do not run the deep path here.

## 5. Security gate

The `open-code-review` plugin's automatic gate is part of this normal review.
In a `goal`/`auto` session it has already run after the edit and injected a
bounded `[security-gate]` note. If that note exists for the current diff hash,
reuse it and **do not run OCR again**. The manual path below is for when the
plugin is disabled/absent or the gate did not run.

Load `code-audit` and run the manual OCR path on the final diff only when the
automatic gate did not produce a result:

```bash
EFFORT="${EFFORT:-low}"
ocr review --repo <repo> [--from <base> --to HEAD | --commit <sha>] \
  --effort "$EFFORT" --format json --audience agent \
  --provider deepseek --model deepseek-flash \
  --max-tokens-budget 40000 --timeout 15 --concurrency 4
```

Choose `EFFORT` **before** the run: `low` for a small, non-high-risk diff;
`medium` for >200 changed lines or any auth/crypto/input/secret path; do not
use `high` here (that belongs to `deep-audit`). Do not run `low` and then
`medium` on the same diff hash in the normal path — if the automatic gate ran
`low` and the change needs `medium`, report `BLOCKED` and recommend
`deep-audit` instead of escalating here. The `code-audit` gate is one run per
diff hash; the deep path owns the deliberate escalation.

Then:
- Keep only `category in {security,bug}` and `severity in {critical,high}`.
- For every blocking finding: `file:line`, raw code, and a `source → sink` line
  or one repro command that runs in <2 minutes. `unverified` needs a named
  blocker and expiry; cap at 3; more than 3 → `INCOMPLETE`.
- Run the `code-audit` 10-line checklist for what OCR may miss: authz/IDOR,
  business logic, secrets, error leakage, input boundaries, XSS/CSRF, path
  traversal/upload, deserialization/eval, rate limiting, dependency/lockfile.
- Do not run a fresh verifier in the normal path. If a critical/high is
  unresolved or the change is high-risk, report `BLOCKED` and recommend
  `deep-audit`; the deep skill owns independent verification.
- Respect the `code-audit` stop rules: no loop; same diff hash, 2 empty runs,
  3 runs, 120k tokens, 2 injections, 2 OCR errors stop the gate.
- If OCR is unavailable or fails: say so, fall back to the 10-line checklist +
  manual source review, and mark the security gate `INCOMPLETE`. Do not approve
  a high-risk change without a security gate.

Never say "no vulnerabilities"; use the `code-audit` report contract:
OCR version, effort, scope, counts, unverified, Standards/Spec summary.

## 6. Verdict (fail closed)

Choose exactly one:

- **BLOCKED** — unresolved critical/high security finding, secret, a high-risk
  change with an unverified critical/high, or a failing check that indicates
  security/data loss. Add: "run `deep-audit` for independent verification."
- **NEEDS-FIXES** — any high finding (Standards/Spec/Security) or a failing
  deterministic check; no blocking security.
- **APPROVE-WITH-NITS** — findings exist but none high; all deterministic
  checks pass; security clear.
- **APPROVE** — no findings; all deterministic checks pass; security clear;
  scope and spec status stated.
- **INCOMPLETE** — a required check/tool could not run, >3 unverified, no
  diff/scope, a high-risk/large diff that needs `deep-audit`, or a feature with
  no spec that cannot be assessed.

`APPROVE` is a normal per-edit gate, not a deep proof of absence. State what
would change the verdict.

## 7. Report

Use the `/review` structured findings contract for findings. Include:

1. **Scope** — base, mode, changed files, +/− lines, spec source.
2. **Checks** — every command and result (pass/fail/skipped), including the
   exact failure output for a failing check.
3. **Security** — OCR version/effort/scope, critical/high count, each finding
   with file:line and source→sink/repro, unverified count.
4. **Standards** — findings, with file:line and the rule/smell.
5. **Spec** — findings, or "skipped (no spec found)" / "INCOMPLETE (feature, no
   spec)".
6. **Coverage** — every changed file, reviewed or skipped with a reason; test
   files escalated.
7. **Verdict** — one of the five; what would change it; whether `deep-audit` is
   recommended.
8. **Not checked / limitations** — tools that were missing, checks that could
   not run, scope excluded.
9. **Bottom line** — one paragraph the user can act on without re-running
   anything.

Write in Chinese when the user writes Chinese. Do not include a generic
"looks good"; every claim needs evidence.

## 8. Deep review/audit is separate

This skill is the **normal** per-edit review. The user-invoked deep path is
`deep-audit`:

- "审查" / "review" / "做好代码审查" → `deep-audit` in **deep review** mode:
  full `review-delegate` coverage ledger + OCR medium + independent verifier.
- "深度审计" / "deep-audit" → `deep-audit` in **deep audit** mode: the
  Cloudflare 6-phase protocol when a sandbox is available; otherwise static
  deep review + `needs_validation`.
- Do not run `deep-audit` automatically after edits. If the normal review finds
  critical/high or the change is high-risk, report `BLOCKED` and recommend it.

## 9. Research basis

See `REFERENCES.md` for the competitive research conclusions. The short version:
Cloudflare's skill is a protocol, not a product; use its principles for deep
audits, not as a per-PR scanner. Routine per-edit review is deterministic checks
+ quick two-axis + OCR/security gate + a fail-closed verdict.
