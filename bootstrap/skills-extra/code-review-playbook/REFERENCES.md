# Research basis for code-review-playbook / deep-audit

Source report: `~/Documents/Development/archive/code-audit-research/cloudflare-security-audit-skill-competitive-research-2026-10-18.md`

## Cloudflare security-audit-skill (commit c1c8a8c)

- 6-phase protocol; coverage ledger; tri-state (`confirmed` / `needs_validation` / `rejected`); fresh verifier; fail-closed sandbox policy.
- `confirmed` is an agent assertion; validators prove format/ledger only; issue #21 shows an artifact path can be missing.
- No shipped sandbox; sandbox is an operator requirement. PR #75 (target content + Windows + CI) and #76 (git config) were open at the pin.
- No SCA/CVE, SARIF, CI gate, autofix, or crash-resume; single repo.
- Authors: one run finds about half. CoalBoard quick profile: median recall 0.467 vs solo 0.467 at 14.5x cost; full profile untested.
- 14 commits; last 2026-09-14; 26 issues + 40 PRs; no CI/releases.
- Use: reference protocol for deep audits; pin; sandbox; #75/#76; multiple passes; not per-PR.

## Routing

- **Normal review (automatic in GOAL mode after code edits):** deterministic checks + `code-review` + `code-audit` OCR (low/medium); no independent verifier; per-edit gate.
- **Deep review** ("审查"/"review"/"做好代码审查"): `review-delegate` coverage ledger + OCR medium + independent verifier for critical/high; not automatic.
- **Deep audit** ("深度审计"/"deep-audit"): Cloudflare 6-phase protocol when a sandbox is available; otherwise static deep review + `needs_validation`; full repo at a pinned commit.
- SAST/SCA: CodeQL, Semgrep, Snyk, Sonar, AWS Inspector; complementary.
- PR review: OCR, CodeRabbit, Qodo, Greptile, Copilot.
- Dynamic: Strix, XBOW.
- Full-repo products: Anthropic Claude Security (proprietary, Claude-only, no isolation), OpenAI Codex Security (Apache-2.0, active, CI/SARIF/sandbox), Google Mantis (Apache-2.0, demo-only).

## Why the normal path does not run Cloudflare per-edit

It is a protocol, not a scanner; no shipped sandbox; no SCA/SARIF; cost/latency; single-run recall; `confirmed` is not machine truth. The per-edit gate is deterministic checks + two-axis + OCR; the deep review/audit is a separate, user-invoked path.
