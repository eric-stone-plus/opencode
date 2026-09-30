---
name: longrun-stability-audit
description: Layered hardware-to-workload stability audit of one long-running host, verified by an adversarial subagent swarm. Use when the user asks to audit or re-audit machine stability, to baseline a new or replacement computer, to investigate drift/thermal/watchdog/journal anomalies over long uptimes, or to attack-verify an existing stability report before trusting it.
---

# Long-run stability audit

Measure one host bottom-up (silicon → kernel → clock → init → resources → policy → workload → egress), then **make the findings survive attack**. The measurement is the easy half: this skill exists because unattacked stability reports publish confident numbers that no round ever measured.

The output is an **archive**: a directory of persisted round reports plus a correction ledger, re-readable on a new machine without the session that produced it.

## Roles

Four roles, and one hard separation: **attackers write only their own report; appliers write only their assigned files.** An attacker that repairs contaminates the evidence it is attacking; an applier that adjudicates launders its own defect. The caller (you) does neither — it dispatches, adjudicates, and re-reads.

Follow-up repairs route to a **successor applier**, never back to the author: an agent that closes a defect it introduced and confessed is self-adjudicating, which is the laundering shape with a stamp on it. When a run is aborted mid-flight, survey the partial state yourself (hashes, stamps, scratch, missing report) before re-dispatching — an aborted agent leaves half-applied edits that a stamp alone does not prove complete.

| Role | Writes | Skill to embed in its prompt |
| --- | --- | --- |
| Auditor | its report | `research` (primary sources) or `diagnosing-bugs` (Phase 1 loop) |
| Applier | its assigned archive files | `implement` |
| Attacker | its report | `grilling` + `code-review` (one axis only) |
| Caller | dispatches, adjudicates | `grilling` against itself |

Subagents start with zero context but share the harness: where they have the `skill` tool, **name the skills to load and let them load** — a subagent that reads the skill itself gets the current text, while methodology pasted into a prompt is a snapshot that goes stale the moment the library updates. Probe the capability once per harness version (dispatch a trivial agent and ask it to list its tools and call `skill`), and fall back to pasting only for subagents that lack the tool.

Either way the prompt must still carry what no skill can supply: the goal, exact absolute paths, the thermal budget, the safety rails, the house conventions, and any ruling already made. Templates: [`references/subagent-prompts.md`](references/subagent-prompts.md).

## The loop

### Step 0 — Pin the box and the budget

Record, in one file: hostname, uptime, kernel, the workload under test, and the **thermal budget** (how many live commands this round may spend). A hot box (this method's origin host reaches 97–99 °C under concurrent AI load — a load-case figure, not an idle reading) makes live measurement expensive, and the archive's own primaries usually suffice — a **zero-live-command round is a legitimate round**. Declare the budget in every prompt so subagents do not spend it independently.

Also pin the safety rails: which commands are forbidden outright (state-mutating `systemctl`/`sysctl`/package/disk operations, process kills by pattern), which directories are read-only, which are off-box. Paste the rails into every prompt; a subagent that has not seen them will run them.

**Done when**: one file holds the box identity, the budget as a number, and the rails as a list.

### Step 1 — Walk the ladder

Measure layer by layer, each layer's findings attributed to the command that produced them. The ladder, its read-only commands, and the trap that lives at each rung: [`references/measurement-ladder.md`](references/measurement-ladder.md).

**Done when**: every rung is either measured-with-output or explicitly declared out of budget.

### Step 2 — Publish findings as anchored claims

Each finding carries: the claim, the **primary** (the on-disk record or pasted output it came from), a **locator** (section name + verbatim row-head prefix + line number, all three), and an **anchor** — the whole verbatim target line, such that `grep -c -F '<anchor>' <file>` returns exactly **1**.

An anchor returning 0 or 2 is not a formatting nit: it means the correction cannot be applied, or will be applied to the wrong row. Run the **anchor census** over every finding before dispatching anything.

**Done when**: the census table shows n=1 for every finding (or n/a for pure insertions, stated as such).

### Step 3 — Dispatch auditors in parallel

One per axis or per ladder rung, never one agent for the whole box. Each prompt is self-contained: goal, exact paths, budget, rails, pasted skill methodology, and a deliverable format demanding `file:line` evidence plus **"what would disprove this"**.

**Done when**: every auditor's report is persisted to disk (see Persistence).

### Step 4 — Attack

For every finding, dispatch an attacker whose assignment is to **kill** it: re-read the quoted code, re-derive every numeral, check reachability in the real configuration. Where it cannot kill, it must reduce scope and say what it tried.

Assign a **reverse attacker** to every all-clear. "No defects found" is a claim, and an unnamed sweep is unfalsifiable — require the attacker to list what it swept, so its all-clear is itself attackable.

Two axes stay separate: **Standards** (does it follow the documented rules?) and **Spec** (does it do what was asked?). Report them side by side; merging them lets one mask the other.

**Done when**: every finding carries a post-attack verdict — UPHELD / CORRECTED / REFUTED / KILLED — with the command and literal output behind it.

### Step 5 — Adjudicate personally

Re-read the code behind every killed verdict and every high-severity survivor. Attackers are wrong too: in the origin audit one attacker's refutation of the caller's own ruling was correct twice, and one of its numerals was itself false. Label anything relayed from a single source without your own verification as **single-source**.

**Done when**: each surviving finding has your verdict, and each of your own prior rulings that the evidence contradicts is retracted in writing.

### Step 6 — Build the correction plan and the gate

Turn adjudicated findings into a plan whose entries are **executable text**: the exact anchor, the exact replacement, the action verb (AMEND / RETRACT / ADD-ROW / SKIP). Anything inside a replacement fence will be written verbatim into a permanent record, so a defect in the fence is a defect on arrival — plan-internal meta (item ids, round verdicts, your own reasoning) stays outside the fence, in the entry's risk field.

Emit the **gate table**: one row per entry — anchor census n, locator status (MATCH / DRIFTED / GONE), disclosure present, verdict READY / BLOCKED(reason) / SKIP(on-disk proof). An unearned READY writes a defect permanently; BLOCKED costs only a round.

A SKIP is the riskiest verdict in the table: it silently drops a correction. Require byte-level proof that the record already carries an equivalent, quoted side by side.

Two traps, both learned the hard way:

- **The gate is a report, not the artifact.** Appliers execute the *plan*, not the gate. A gate that is correct about a file it does not fix has not unblocked anything — strike the offending field in the artifact itself.
- **Key the gate to a hash, not a count.** "The file is N lines" fails forever once anyone edits it, and passes on a file being edited mid-sentence (line count constant, bytes moving). Publish the `sha256` of the snapshot the gate was measured against, and re-hash before each write. Do not print the artifact's *own* hash inside it — a file that prints its own hash falsifies it — but pair every *cross-file* line citation with that file's hash, taken in the same invocation.

**Done when**: no entry is READY unless anchor n=1 **and** locator MATCH **and** disclosure present, and the gate names the snapshot hash it was measured against.

### Step 7 — Apply, disjoint and verified

Dispatch appliers over **disjoint file sets** so they can run in parallel. Each verifies after **every** edit — a self-check run between two edit passes attests a state that no longer exists. Line counts, fence balance, and marker parity are cheap; paste them.

**Done when**: each applier's report shows before→after for every edit, and the caller has re-run its own spot checks rather than trusting the report.

### Step 8 — Attack the applied edits, then register

The applied edits get their own attack round (Step 4 discipline). Everything found but not fixable this round goes into the **register**: a table of known-defective sites, each row naming the site, the claim, the measured evidence, and the status. Registration is not closure — say so in the table's own text.

**Done when**: every finding is either fixed, registered with a trigger, or explicitly accepted by the operator.

### Step 9 — Sweep tails

Temp files, scratch scripts, background processes, partial installs, dirty git status. Derive the session window from an **independent clock** (file mtimes, a database timestamp) — a window taken from the auditee's own report hides exactly the tail edits it is meant to catch.

**Done when**: `find -newermt <independent start>` lists only intended files, and the register has no unowned rows.

## Evidence rules

Eleven rules; the case law behind each — including four defects the caller itself introduced — is in [`references/evidence-rules.md`](references/evidence-rules.md). Read it before your first dispatch, and paste the rules into every prompt.

1. **Copy, cite, or measure.** Every number in the archive traces to a primary: a pasted output or a named round+line. Aggregation is a generation step — copying a hedged claim without its hedge creates a new false claim.
2. **Re-derive before you write.** An applier re-computes every numeral it is told to write. Three appliers were killed for transcribing numerals they never derived.
3. **Quarantine prompt-supplied text.** A rule or quotation the caller pasted into your prompt is unverified input, not authority. `grep` it against the cited file before relying on it — the origin audit's most damaging defect was a fabricated rule quotation the caller embedded in every prompt, refuted in an early round, then **laundered** back into six permanent sites through a citation chain.
4. **Census every copy before correcting one.** A fact published in four places and struck in one leaves the archive contradicting itself inside a single numbered point. Find all copies first.
5. **A correction lands with a stamp.** `~~old~~〔🔴 round date source: reason〕` — matching the neighbouring stamp's exact shape. A number that changes with no visible mark is a silent edit.
6. **Locators carry three parts.** Section name + verbatim row-head prefix + line number. Bare line numbers drift; re-run the locator table immediately before each write, because it is a procedure rather than a state.
7. **Every assertion names its evidence.** Round+line, or pasted output. Provenance claims ("X was computed from Y") are assertions and need sourcing like any other — two rounds were killed for asserting a provenance whose key digit appeared zero times in the cited primary.
8. **Never leave tails.** Deferred work gets an on-disk register entry with a trigger. A deferral recorded only in a round report is a tail, and registers go stale: give each a re-measure condition.
9. **An instrument ships with its artifact.** A self-check whose script lives only in `/tmp` is an unverifiable green — publish it inside the artifact (heredoc, extractable and runnable as stated), or register it as not re-runnable. An instrument nobody can run cannot be proven able to fail.
10. **Balance is not presence.** Marker parity (`~~`, `〔〕`, `**`) passes when an inverted pair is swapped, a strike loses its stamp, a digit is silently edited inside a stamped cell, or a load-bearing sentence is deleted outright. `配平失败 = 0` is evidence of balance only. And a scope check must confirm its **denominator** before trusting its numerator: `2>/dev/null` on a wrong path converts "target absent" into "clean" — the vacuous green.
11. **A report adds zero to every census it measures.** Verification artifacts that contain the literal under test inflate the very census they assert unchanged (a resolver regex carrying its own pattern; a report quoting a count it claims stays fixed). Resolve literals at run time from the source file, never type them, and publish the zero-inflation proof. Beware the unfalsifiable `or` — an assertion written to pass either way has not been run.

## Persistence

Subagent reports die with their session. Persist every one to the round directory as it lands, verbatim, under a name that encodes round + role + target (`R15-G-attack-P1g-archive-edits.md`). Where a report was lost, the harness's own database still holds it: open it read-only and select the text parts by session id, ordered by creation time.

The round directory is the deliverable. A new machine should be able to read it and re-run the checks without the session that produced them.
