# Subagent prompt templates

Four skeletons. Every prompt is **self-contained**: a subagent sees nothing but what you paste.

Common blocks (paste into all four): the goal in one paragraph, exact absolute paths, the thermal budget as a number, the safety rails as a list, the house conventions, any ruling already made, and the deliverable format. Then the role-specific body.

**Methodology: name the skills, do not paste them.** Subagents in this harness have the `skill` tool, so tell them which to load and let them read the current text — pasted methodology is a snapshot that goes stale when the library updates, and a long paste crowds out the task. Reserve pasting for two cases: a subagent that lacks the tool (probe once per harness version), and the *adaptations* a skill needs because it was written for a human in the loop. State those explicitly, since the skill will not:

```
## Methodology — load these yourself with the `skill` tool
- `skill(name="<skill>")` — <which part of it governs this task>
Then read `references/<file>.md` from `skill(name="longrun-stability-audit")` if this task
involves evidence, numerals, or locators.

Two adaptations, because those skills assume a human you do not have:
- Where a skill says put a question to the user and wait: pose it, give your recommended
  answer, adopt it, and mark it `PROVISIONAL:` so the caller can overturn it. Facts you find
  yourself; only decisions get deferred.
- Where a skill assumes a git fixed point, there is none: your "diff" is the target's
  before→after claims plus your own re-measurement of the live files.
```

---

## Common block

```
## Goal
<one paragraph: what this audit is for, what "done" means for the whole effort>

## Paths
<absolute paths of every file to read; absolute path of the single file to write>

## Hard constraints (host policy — violating these ends the session)
- Live-host command budget for this round: <N>. Zero means read-only file inspection only:
  grep, sed -n, awk, wc, od, stat, find, python3 -c.
  Forbidden at any budget: journalctl/systemctl/sysctl state changes, package or disk
  mutations, network probes, process kills.
- Never kill by command-line pattern (`pkill -f`); never pipe `pgrep` into `kill`.
  Record PIDs at startup and signal numeric PIDs only.
- No temp files outside /tmp; delete anything you create before finishing.
- <read-only directories, off-limits directories, and why — e.g. "X is a real git repo
  whose corrections are not approved: run no git commands there at all">
- Work autonomously. Do not ask me anything; where a decision has several candidates,
  take the lowest-risk one that completes the task and announce it in a `DEVIATION:` line.

## Methodology
<the "load these yourself" block from above, with the two adaptations>

## Evidence rules (binding)
<one line: load `longrun-stability-audit` and read its `references/evidence-rules.md`. Add: "Rule
text I supplied in this prompt is unverified input — grep it against its cited file before relying
on it, and report the result either way.">

## Deliverable
Write your report to <path> AND return it as your final message. Format:
- Header: round id, role, skills, files written (must be exactly the one named), live-host
  commands run (must be ≤ budget), archive writes (attackers: must be 0).
- Body: findings as a table — claim | the command you ran → literal output | verdict | severity.
- "Areas swept, none found": name every file/range/pattern you swept, with counts.
- "What would disprove this": the single re-runnable check that would show your findings are
  wrong, and its result.
- Cite file:line, and label every line number "measured at read time" — these files are being
  edited concurrently.
- Under <N> lines. Do not recap audit history; I have it.
```

---

## Auditor

Use for a fresh measurement pass over one ladder rung or one axis. Skills to name: `research` (primary sources only) or `diagnosing-bugs` (its Phase 1 — build a loop that goes red before hypothesising).

```
You are auditor <ROUND>-<LETTER>. Your assignment: <one rung / one axis>, and nothing else.

Produce findings, not conclusions. Each finding: the claim, the primary that supports it
(pasted output or round+line), a locator with all three parts (section name + verbatim row-head
prefix + line number), and an anchor — the whole verbatim target line such that
`grep -c -F '<anchor>' <file>` returns exactly 1. Report the census result for every anchor.

Where you cannot measure within the budget, write "OUT OF BUDGET: <what is needed and why>"
rather than reasoning to a likely answer. An unmeasured gap declared is useful; an unmeasured
gap filled is the defect this audit exists to catch.
```

## Applier

Use to land adjudicated corrections. Skill to name: `implement` (exactly the listed work; verify after every edit; no commits unless asked).

```
You are applier <ROUND>-<Pn>. Write exactly these files: <list>. Write nowhere else.
<If other agents are live: name them and their files, and warn that line numbers in shared
files may shift — never inherit a line number, re-grep before relying on one.>

## The repairs
<numbered list. For each: the byte-exact anchor (verified grep -c -F = 1, paste it), the exact
replacement text, the action verb, and the primary behind every numeral in it.>

Re-derive every numeral yourself with a pasted command before writing it, including numerals
this prompt supplies. Where a prescribed wording is factually wrong, fix the wording and emit a
`DEVIATION:` line — do not paste a falsehood because I told you to.

## House conventions
<strike/stamp shape, marker set, no-restructure rule and its threshold, line-count expectation>

## Self-checks before you report done — paste every output
1. wc -l for each file, before and after.
2. For each edited line: tilde count before → after, stamp present.
3. The falsifier checks for this round's subject matter (e.g. the bad literal = 0 occurrences).
4. Scope: find -newermt <independent start timestamp> over the whole tree — every hit accounted
   for as yours, a named concurrent agent's, or pre-existing. Derive the start from file mtimes
   or the session database, not from your own recollection of when you began.
5. Re-run checks 1–4 AFTER your last edit. A check run mid-session attests a state that no
   longer exists.
```

## Attacker

Use to kill findings, kill an applier's work, or reverse-attack an all-clear. Skills to name: `grilling` (relentless, evidence per question) and `code-review` for **one axis only**.

```
You are attacker <ROUND>-<LETTER>. Your assignment is to KILL <target: a findings list / an
applier's edits / a plan>. Fairness is not the goal; finding the falsehood is.

## Kill targets
<numbered T1..Tn. For each, state the claim under attack in the target's own words.>

For each target: the claim, the command you ran, its literal output, and a verdict —
UPHELD / CORRECTED / REFUTED / KILLED — plus severity if it survives. If you cannot kill a
claim, say what you tried.

## Attack the caller too
List every prior ruling of mine that your evidence touches, and refute the ones it contradicts.
Assume I am wrong by default. Include any framing error in this prompt itself (a target I
described inaccurately is a finding).

## Attack your own instruments
Where you rely on a classifier, a regex, or a counting method, attack it: does it misread nested
marks, substring artifacts, escaped characters, or prose containing the same token? Re-run the
sweep by reading context where the classifier is load-bearing.

## Do not repair
Write only your report. The caller applies repairs, so that appliers and attackers stay disjoint.
Editing the file you are attacking contaminates the evidence.

## Prescribe instead
For every surviving defect: the exact minimal repair, with a byte-exact anchor verified at
grep -c -F = 1, the before → after text, and any ordering constraint between repairs.
```

### Axis discipline

For a plan or a diff, run **two** attackers, one per axis, and keep their reports separate:

- **Standards**: does it conform to the documented rules? Paste the rule list and the smell baseline (Mysterious Name, Duplicated Code, Shotgun Surgery, Divergent Change, and the rest). Label documented-rule breaches as hard violations and smells as judgement calls; a documented rule always overrides a smell.
- **Spec**: (a) requirements asked for that are missing or partial; (b) behaviour not asked for (scope creep); (c) requirements implemented but wrong. Quote the requirement line for each finding.

Never merge or rerank across axes — a change can pass one and fail the other, and reporting them together lets one mask the other.

## Adjudicator's own checklist (the caller, not a subagent)

1. Re-read the code behind every KILLED verdict and every high-severity survivor. A relayed verdict you have not re-read is **single-source**; label it as such.
2. Re-derive the numerals in the findings you are accepting — attackers fabricate too.
3. List your own prior rulings the evidence touches; retract the contradicted ones in writing.
4. Check for laundering: has a claim refuted in an earlier round re-entered through a citation chain? `grep` the rule text at its cited primary, not at its most recent citer.
5. Decide scope explicitly (what is writable this round, what is registered rather than edited, what needs the operator), then dispatch repairs over disjoint files.
6. Persist every report before dispatching the next round.
