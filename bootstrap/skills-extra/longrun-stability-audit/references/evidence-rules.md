# Evidence rules — case law

The eleven rules from `SKILL.md`, with the defect that produced each. Every case is real: it reached a published report, and in four of them the **caller** was the source. Read this before your first dispatch, and paste the rule summaries into every prompt.

The recurring shape, stated once because it explains all of them: **a specific numeric or mechanistic claim asserted as measured that no round actually measured.** Everything below is a variation on it.

---

## 1. Copy, cite, or measure

Every number traces to a primary — a pasted output or a named round+line.

**Case (aggregation without the hedge).** A round measured a *set* of reversed boot rows as unstable and its *count* as reproducible, with that hedge explicit. A later summary copied the count alone, dropping the hedge — publishing "the count is reliable" as a new, unmeasured claim. The correction had to strike both halves, because the underlying measurement (a FIRST cell +8 h for every boot) made the count unstable too.

**Case (mechanism invented to fill a gap).** Two archives disagreed about a network path. A summary resolved the disagreement by asserting a packet-filter mechanism nobody had measured. The honest finding was "unmeasured mechanism"; the invented one survived three rounds before an attacker asked which round had run it.

**Check**: for every numeral, `grep` the primary it cites and confirm the numeral is *in* it. A citation whose primary lacks the digit is the defect, regardless of whether the digit is right.

## 2. Re-derive before you write

An applier re-computes every numeral it is told to write, including numerals supplied by the caller.

**Cases — three appliers killed in one round:**
- Told to correct a clock delta, wrote `8h1m20s`. The subtraction gives **7h58m40s** (626160 − 597440 = 28720 s). The error was 160 s in the direction that made the number prettier.
- Wrote `869 s` for a value no primary contained: the two on-disk records give **949.3 s** (24194.3 − 23245). `grep -c -F '869'` on both primaries returned **0**.
- Wrote "the stale figure was computed as 70.5 − 58 = 12.5" to explain a published `12`. Three defects in one sentence: the arithmetic yields 12.5, not 12; `70.5` appears **0** times in the cited primary; and the provenance was asserted, never sourced.

**Check**: paste the `awk` (or, when the round's live-command budget allows it, `python3 -c`) that produced the number, in the same report, before the number appears in prose. At a zero budget `python3 -c` is not on the read-only list (`subagent-prompts.md`), so derive with `awk`.

## 3. Quarantine prompt-supplied text

A rule or quotation the caller pasted into your prompt is **unverified input**. `grep` it against the cited file before relying on it.

**Case — the caller's own fabrication, laundered through four rounds.** The orchestrator embedded in every subagent prompt, as the audit's governing rule: *"R6-C:323 — copy, cite, or measure; never synthesise an unmeasured mechanism."* The cited line contains neither phrase. `grep -c -F 'copy, cite, or measure'` on that file returns **0**; the token `copy` appears once in the whole document, in an unrelated heading about upstream sources. What the line actually says is the shape quoted at the top of this file.

The chain: an early attacker **refuted** the quotation by name and gave the phrase's real homes → the arbitration document enshrined it anyway as "Governing rule (`…:323`)" → a later round's report cited it → the next attacker used it as the load-bearing premise for refuting a caller ruling → the caller adopted that premise → an applier **stamped it into six permanent archive sites**.

A refuted claim re-entering the record through a citation chain is **laundering**. It survives because each hop cites the previous hop instead of the primary, and every hop looks well-sourced.

Two further notes from the same case:
- The *outcome* was still correct, on a different ground (the primary's digit was on disk, and a downstream value contradicting it is a defect on any reading). A right conclusion resting on a fabricated citation is still a defect — and it is the one that survives longest, because nobody re-checks a rule everyone agrees with.
- Rule text is where laundering is most damaging. Numbers get re-derived; **rules get obeyed**.

**Check**: before any prompt goes out, `grep -c -F` every quoted rule against its cited file. Before any subagent relies on a rule the caller supplied, it greps it too — and reports the result either way.

## 4. Census every copy before correcting one

A fact published in several places and corrected in one leaves the record contradicting itself.

**Case.** A claim that a reversed-row *count* was citable appeared at **four** sites. One round struck one site, leaving three live — two of them inside the same numbered point as the struck one, so a single section simultaneously affirmed and retracted the same fact. An attacker found it by sweeping the word rather than the site.

The census also has to survive paraphrase: sweeping only the literal term missed sites phrased as "consistent across three rounds" and "safe to cite". Sweep the **assertion**, in its variants, not just its keyword.

**Check**: `grep -n` every occurrence, classify each as struck / live-negation / live-assertion, and drive live-assertions to zero. Classify by reading context — a regex classifier over correction markers misreads nested strikes.

## 5. A correction lands with a stamp

`~~old~~〔🔴 round date source: reason〕`, matching the neighbouring stamp's exact shape.

**Case (silent edit).** Five sites carried a wrong microsecond digit. Four were corrected with a visible stamp naming the primary; one had its digit changed with no mark at all — a reader diffing the archive would see the number move and no reason. 

**Case (strike-blind verification).** A correction rendered as substitution rather than strike passed its own `grep -F` check *because* the check could not see strikes; the same check would have passed a file where the bad literal was still live and unstruck. Choose the mark the house convention requires (strike for removals, substitution for a wrong digit whose literal must not remain), then verify with a method that can distinguish the two — count `~~` on the line before and after.

**Check**: for every edited line, tildes before → after, and stamp present. Where a threshold forces deferral rather than restructuring, the deferral goes in the on-disk register the same round (see rule 8).

## 6. Locators carry three parts

Section name + verbatim row-head prefix + line number. Bare line numbers drift.

**Case.** A plan's locator table was verified as passing, then a concurrent applier edited ten sites in the same file and added seven lines to another. The table was true when measured and false when used. The plan's own history recorded one line moving `:2846` → `:2869` → `:2870` inside a single session.

**Case (drift inside the correction text itself).** A replacement fence cited `synthesis :314`; the content was at `:316`, and `:314` held a stray `>`. The plan conceded the drift elsewhere in the same document while still shipping the stale cite into permanent text.

**Consequence**: the locator table is a **procedure, not a state** — re-run it immediately before each write, never once per round. And permanent text cites section + verbatim row-head prefix; line numbers belong in plan-internal fields only.

## 7. Every assertion names its evidence

Round+line, or pasted output. Provenance claims are assertions.

**Case (a count published as zero by the line that disproves it).** A correction stamp asserted "no site in the archive prints the six-decimal delta (measured: hits = **0**)". The same line printed that delta **twice**, ~400 characters earlier, and four other sites printed it because of the correction itself. True count: 6 occurrences / 5 lines. The grep ran before the stamps were written and was published after — the timeline is visible in the session database.

**Case (an attestation of a live environment).** "This round's writers have converged; no concurrent writers" appeared with no evidence, in a round where two agents were writing concurrently. Statements about the live environment need the same evidence as statements about files.

**Case (a verification window taken from the auditee).** An applier's scope check used its own self-reported session window, which ended ~8 minutes before its last write. The check passed because the true last write still fell inside the false window. Derive windows from an independent clock.

**Check**: for each "measured" claim, find the command in the same report. No command → not measured.

## 8. Never leave tails

Deferred work gets an on-disk register entry with a trigger, the same round.

**Case (deferral recorded only in a round report).** A long table cell crossed the restructuring threshold during a repair. The applier correctly declined to restructure and disclosed the deferral — in its report, not in the archive's register, which existed for exactly that purpose and did not list the cell. When the session ends, the report is not where the next reader looks.

**Case (a register that goes stale).** The register listed four candidate cells with measured character counts. Three counts still reproduced; one was measured before an unrelated correction landed in it and was low by 828 characters. Two cells that crossed the threshold **during** the round were absent. A register without a re-measure condition is a cache of a lookup that has since changed.

**Check**: every deferral names its register, and every register entry names the condition that forces its re-measurement.

## 9. An instrument ships with its artifact

A self-check whose script lives only in `/tmp` is an unverifiable green. Publish it inside the artifact — extractable and runnable exactly as stated — or register it as not re-runnable.

**Case — four load-bearing scripts deleted, outputs still cited.** An applier ran its ten self-checks and its entire 43-row gate from four Python scripts in `/tmp`, then deleted the directory and claimed "destroying it destroys no capability". The plan published nine other script blocks but not these four. The report attributed its outputs to scripts nobody could run; one of the four could never be reconstructed, and its dependent claim had to keep a standing FAIL verdict. An attacker's verdict: an instrument nobody can run cannot be proven able to fail — which is worse than a proven blind spot.

**Check**: for every cited instrument, extract it from the artifact per its stated extraction rule and reproduce the cited output. Extraction rule included — an artifact whose heredoc terminators are indented pastes-runnable never, so the rule is part of the instrument.

## 10. Balance is not presence

Marker parity (`~~`, `〔〕`, `**`) proves balance, never presence or order.

**Case — the gate blind to 7 of 9 perturbation classes.** Two independent attacks ran positive controls against the round's parity gate. It passed: an inverted `〕x〔` pair (balanced counts, wrong order), a `~~strike~~` with no stamp, a silent digit edit inside a stamped cell (`2248`→`2249`), and — worst — **deletion of a 101-character load-bearing sentence**, with every published figure unchanged. `配平失败 = 0` was being read as "no silent edit occurred".

**Case — the vacuous green.** An applier's scope check ran `find <relative path> … 2>/dev/null | wc -l`, printed `0`, and read it as "no files modified". The relative path did not exist from its CWD; the absolute path found **327**. `2>/dev/null` converted "target absent" into "clean scope". Both lessons are now registered trap rows in the archive's own defect table — registration being how a lesson outlives the round that learned it.

**Check**: before trusting a zero numerator, confirm the denominator. Before trusting parity, name what a deletion or reorder would change — and confirm some published check tracks that.

## 11. A report adds zero to every census it measures

**Case — the verifier carried the literal under test.** An attacker's census instrument resolved the rule phrase at run time — except one alternation branch carried the phrase itself as a literal, so the report inflated the very census it asserted was unchanged (`57` measured as `58`). Same round, its assertion was written `== (57,41,12) or == (58,42,13)` — an unfalsifiable disjunction that would have passed either way. Both defects were found only because the check was **executed** rather than reasoned about. The structural kinship is exact: a verification artifact containing the string under test is the same defect class as the fabricated rule quotation laundered through citation chains (rule 3).

**Check**: resolve literals at run time from the source file, never type them; scope every census to a named file the report itself cannot be; write assertions that can fail in exactly one direction; publish the zero-inflation proof.

---

## Adjudicating: assume you are wrong

The caller's rulings are findings like any other, and they get written to permanent records.

**Case.** Two caller rulings were refuted by an attacker in one round:
- A ruling that a wrong digit should be *disclosed* rather than *corrected*, on materiality grounds. Refuted: the governing rule carries no materiality clause, the primary's digit was on disk, the correction cost five single-token substitutions with no line drift — and the disclosure itself miscounted the sites (three named, five live).
- A ruling accepting an arithmetic provenance. Refuted by the same `grep -c` the ruling should have run.

The caller had also, in the same round, produced an unsound back-derived digit of its own (see rule 1) that an applier was instructed to keep off disk — and it was already there, inside a stamp the caller had approved.

**Practice**: after every attack round, list the caller's own prior rulings that the evidence touches, and retract in writing the ones it contradicts. Then register those retractions in the archive's defect register — an adjudicator's error that reached disk is exactly the class of process defect the register exists for. Do not soften it.

**Condensation bar**: a round report may be condensed (the full-detail version of every prior round is not a requirement) **only because the next attacker re-derives** — so every load-bearing number in a condensed report must still be command-backed in-file, or live in an artifact-side paste that reproduces. What condensation cost the origin audit: five minor figure errors a fuller self-verbatim block would have caught. The bar is not length; it is "the next attacker can re-derive everything without asking anyone."

## Reverse-attacking an all-clear

"None found" is a claim. Require the attacker to **name what it swept**, with counts: which files, which line ranges, which patterns, how many occurrences classified. An all-clear with a named sweep is falsifiable and worth something; a blanket one is worth nothing and reads as thoroughness.

In the origin audit, the reverse attackers found more than the forward ones: an attacker told to kill a defect list returned **eight new defects the list had missed**, two of them high severity, plus a refutation of the caller's own framing of one target.
