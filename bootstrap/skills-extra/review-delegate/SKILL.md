---
name: review-delegate
description: Combined review pipeline — deterministic file selection and rule
  resolution via `ocr delegate` (no LLM), then a mattpocock two-axis (Standards
  + Spec) host review producing the /review structured-findings contract. Use
  when asked to run the ocr delegate combined review, to review a change set
  with deterministic coverage, or when /review's ocr block applies.
---

# review-delegate: ocr determinism + two-axis review

## What the deterministic layer contributes

Mattpocock-only review chooses its own change set from git and reviews it with
one LLM's judgement throughout. That judgement decides two things it should
not: **which files exist in the review** and **which written rules apply to
each**. Both are answerable without a model.

This pipeline splits the work: `ocr delegate` answers file selection and rule
resolution deterministically (same refs in, same file list and rule groups out,
every run), and the host agent spends its LLM budget only on the two-axis
review itself. The coverage ledger is then anchored on a file list no reviewer
mood can shrink, and the Standards axis applies rule text that was resolved
before the review started. The independent ocr review track
(`bootstrap/plugin/open-code-review.ts`) is a separate cross-check path, not
part of this pipeline.

## 1. Pin the fixed point

The fixed point is whatever the user supplied (SHA, branch, tag, `main`,
`HEAD~5`). If they gave none, ask for one. Confirm it resolves
(`git rev-parse <fixed-point>`) and the diff is non-empty before going further.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot,
against the merge-base), and the commit list via
`git log <fixed-point>..HEAD --oneline`. ocr's range mode uses the same
merge-base semantics (`merge_base` in its output).

## 2. Deterministic file list + rules (ocr delegate)

Run the helper from this skill's base directory (it shells out to `ocr`):

```
bun scripts/build-review-spec.ts --from <fixed-point> --to HEAD
bun scripts/build-review-spec.ts --commit <sha>          # single commit
bun scripts/build-review-spec.ts                         # uncommitted + untracked
```

It runs `ocr delegate preview --format json` (file list + mode/ref metadata)
and `ocr delegate rule <files> --format json` (rules grouped by content), and
emits one ReviewSpec JSON:

- `files[]` — every ocr-listed file exactly once: reviewable files carry
  `ledger: "reviewed"`, excluded files carry `ledger: "skipped"` and
  `skip_reason: "ocr:<exclude_reason>"` (e.g. `ocr:unsupported_ext`,
  `ocr:deleted`). Untracked files appear in workspace mode, as in ocr.
- `rule_groups[]` — `pattern`, `files`, and the `rule` text (markdown) resolved
  for those files, grouped by identical content. Groups cover every listed
  file, so a file you deliberately review despite an exclusion still has its
  rules.
- `source: "ocr"` / `"git-fallback"`, plus `mode`, `from`, `to`, `merge_base`,
  `commit` for provenance.

Raw commands if you prefer not to run the helper: `ocr delegate preview
[--from X --to Y | --commit C] --format json` gives the file lists and
`ocr delegate rule --format json -- <paths...>` gives the rule groups (flags
first, `--` before the paths, so a path like `--exclude` cannot be parsed as a
flag); the helper's value is only normalization + the fallback.

**Graceful degradation.** If `ocr` is not on PATH, the helper falls back to
plain git enumeration (same modes; untracked included in workspace mode) with
`source: "git-fallback"`, empty `rule_groups`, and a `notice` field. Quote that
notice in the final review output so the reader knows the deterministic layer
was absent, and run the review on the enumerated files anyway.

## 3. Spec source

Find the originating spec in this order: issue references in commit messages
(`#123`, `Closes #45`); a path the user passed; a spec file under `docs/`,
`specs/`, or `.scratch/` matching the branch or feature. If none, the Spec
sub-agent reports "no spec available" instead of inventing one.

## 4. Standards sources + smell baseline

Collect the repo's own standards (CODING_STANDARDS.md, CONTRIBUTING.md,
AGENTS.md, .editorconfig…). On top of them, the Standards axis always carries
this Fowler smell baseline (_Refactoring_, ch.3), under two binding rules:
**the repo overrides** (a documented standard always wins; where it endorses
something the baseline would flag, suppress the smell) and **always a judgement
call** (each smell is a labelled heuristic — "possible Feature Envy" — never a
hard violation). Skip anything tooling already enforces.

- **Mysterious Name**: a name that doesn't reveal what it does or holds. → rename it.
- **Duplicated Code**: the same logic shape in more than one hunk or file. → extract and share it.
- **Feature Envy**: a method reaching into another object's data more than its own. → move it onto the data.
- **Data Clumps**: the same few fields or params travelling together. → bundle into one type.
- **Primitive Obsession**: a primitive standing in for a domain concept. → give the concept a small type.
- **Repeated Switches**: the same switch/if-cascade on the same type recurs. → polymorphism or one shared map.
- **Shotgun Surgery**: one logical change scatters edits across many files. → gather what changes together.
- **Divergent Change**: one module edited for several unrelated reasons. → split by reason.
- **Speculative Generality**: abstraction for needs the spec doesn't have. → delete it, inline back.
- **Message Chains**: long `a.b().c().d()` navigation. → hide the walk behind one method.
- **Middle Man**: a class that mostly delegates onward. → cut it, call the target direct.
- **Refused Bequest**: an implementer that ignores most of what it inherits. → composition over inheritance.

## 5. Two axis sub-agents (parallel)

Spawn both in parallel so their contexts don't pollute each other.

**Standards sub-agent prompt** — include: the diff command and commit list; the
standards-source file list; the full smell baseline from step 4 (the sub-agent
has no other access to it); the resolved `rule_groups` from step 2 verbatim,
each with its `files` list; and the brief: "For each rule group, check its
files' hunks against that rule text. Then report, per file/hunk where relevant,
(a) every place the diff violates a documented standard: cite the standard
(file + the rule); and (b) any baseline smell you spot: name it and quote the
hunk. Distinguish hard violations from judgement calls: documented-standard
breaches can be hard, but baseline smells are always judgement calls, and a
documented repo standard overrides both the baseline and the ocr rule text.
Skip anything tooling enforces. Under 400 words."

**Spec sub-agent prompt** — include: the diff command and commit list; the spec
from step 3; the `files` list from step 2 (the coverage anchor — every listed
file is in scope for the ledger, `skip_reason` tells you what ocr already
excluded); and the brief: "Report: (a) requirements the spec asked for that are
missing or partial; (b) behaviour in the diff that wasn't asked for (scope
creep); (c) requirements that look implemented but where the implementation
looks wrong. Quote the spec line for each finding. Under 400 words."

## 6. Findings contract and coverage ledger

Findings follow the /review structured contract exactly (one block per
finding):

```
### [severity] category — title
- **file**: path/under/review
- **line**: 142 — `exact code quoted from that line`
- **severity**: high | med | low
- **category**: bug | security | behavior-change | structure | performance
- **title**: short imperative summary of the defect
- **description**: why it is wrong + the realistic scenario where it fails
- **fix**: concrete suggestion
```

Line rules as in /review: quote the exact code at the anchor and verify it
against the diff; if no single line can be pinned, say so and give the hunk
(`line: hunk @@ -120,8 +120,15 @@ — no single anchor line`); never guess a line
number. Re-read the file at the cited range before finalizing — a stale anchor
is a wrong finding.

The coverage ledger is anchored on the ReviewSpec `files` list: every ocr-listed
file appears exactly once, with one status — `reviewed` (you examined its diff
and read it) or `skipped: <reason>` (default: `skipped: ocr:<exclude_reason>`
from the spec; you may upgrade an excluded file to `reviewed` when you
deliberately cover it, and must then say so). Escalation is mandatory when an
excluded file's diff carries behavior-change signal — a deleted or modified
test file, or deleted code other files still reference: you MUST review it and
ledger it `reviewed` (say so), never `skipped`. No file may be silently absent.

End with the /review Summary Block verbatim:

```
## Summary
Counts: high N | med N | low N

## Coverage Ledger
- path/under/review — reviewed
- path/to/lockfile — skipped: lockfile

## Verdict
approve | approve-with-nits | needs-fixes — one line naming what drives the verdict
```

Verdict is deterministic: `needs-fixes` if any high finding; `approve-with-nits`
if findings exist but none are high; `approve` if there are no findings.

## 7. Aggregate

Present the two reports under `## Standards` and `## Spec` headings, verbatim or
lightly cleaned, findings in the structured contract first, Summary Block last.
Do not merge or rerank findings across axes — the separation is the point. End
with total findings per axis and the worst issue within each axis. If the
fallback ran, name it here.
