# Goal mode: adversarial subagent swarm (default playbook)

Loaded via the `instructions` list in `~/.config/opencode/opencode.jsonc`
(`"~/.config/opencode/AGENTS.goal.md"`). Distributed by this repo's
`sync-upstream` script from `dotfiles/opencode/AGENTS.goal.md`.

**Trigger**: any explicit request for autonomous multi-turn work, or a session switched to the `goal` agent. Unless the user says otherwise, run this playbook instead of working the goal single-threaded.

**The mode owns the objective**: there is no `/goal` command. Switching the session to the `goal` agent (Tab / `<leader>a`) renders the status-bar agent name in red ("Goal") for the whole session — that is the persistent mode indicator. Entering goal mode seeds the session goal from the user's own message the first time (only while no goal file exists), and that goal is re-stated in a system reminder every turn — any agent, survives compaction. When a goal is set, the latest assistant message footer also shows `· ⎇ <first line of the goal>`.

**Editing or clearing the goal**: rewrite the goal file in place (`printf '%s\n' '<new objective>' > <goal-path>`, the path appears in the goal reminder) to re-scope without re-running the playbook; an empty write clears it (the reminder then states the goal has been cleared). The goal file is ordinary disk state — there is no command to learn.

**Self-set goals**: the goal file is ordinary disk state and the goal agent has shell access, so the agent *can* write the next goal itself. This is an entrance, not a hole, and it is protocol-bound: (1) only after the current goal's own checks have passed and the report is delivered; (2) the follow-up objective must be derived from the findings themselves, never invented work; (3) announce it in one line in the report ("set follow-up goal: X because Y"); (4) at most one hop per goal — a self-set goal may not self-set another; (5) never mid-goal, never silently. Write mechanics: `printf '%s\n' '<objective>' > <goal-path>` (the path appears in the goal reminder). Note: a bash-written goal updates the reminder from the next turn but does not emit `goal.updated`, so the footer segment lags until the session is re-opened (the seed path in `reminders.ts` publishes; a raw file write cannot).

**Skills library**: the mattpocock skill set lives at `~/.config/opencode/skills/<name>/SKILL.md`, vendored into the opencode fork's `skills/` by `bun run vendor-skills` (check `skills/PROVENANCE.md` for the revision before trusting your memory of a skill's text — a re-vendor can change it mid-session). Auto-refreshed by the `mpskills-update` opencode plugin (`tool.execute.before` on the `skill` tool): the first call in a 24h window to any skill this fork vendors blocks (usually a couple seconds, up to ~30s worst case on a bad network) to `git fetch` the upstream checkout (`~/.cache/opencode/mattpocock-upstream`), re-run `vendor-skills`, reinstall to `~/.config/opencode/skills`, and commit the result — no manual refresh step, and it never fires for skills-extra or on a bare launch.

**Subagents CAN load skills natively** — measured 2026-09-27 on opencode: three independent `general` subagents each called the `skill` tool and got full instruction bodies back (`grilling`, `code-review`, `tdd`, `codebase-design`), not errors. `opencode.jsonc` denies subagents only `question`/`todowrite`/`plan_exit`, so `skill` is reachable. The old absolute rule ("never tell a subagent to use skill X by name alone") is therefore wrong **for opencode**, and was written when the only route was manual embedding.

Use both routes, because they fail differently:

- **Name it AND make it load the skill**: `Call the skill tool with name <x> as your first action and report whether it returned real instructions or an error.` This costs one line, verifies the harness rather than assuming it, and gets the subagent the *current* upstream text instead of your possibly-stale paraphrase.
- **Still embed the load-bearing methodology yourself.** A named skill is not a guarantee: the tool may be absent in another harness (Codex has no hook/skill mechanism at all), the subagent may load it and not apply it, and the parts that decide the work's quality — which axis to label, what counts as a falsifying observation, the seam you want tested — are yours to specify. Embedding also lets you *narrow* the skill (e.g. "apply tdd, but refactoring is out of scope for this task").

The rule that survives: never let "use skill X" be the *only* instruction. A subagent that cannot load it must still know what to do.

Pick skills by task type:

| Task type | Embed these skills |
| --- | --- |
| Code / plan / diff review | `code-review` (two-axis) + `grilling` |
| Bug or regression | `diagnosing-bugs` (feedback loop before hypotheses) |
| Feature or fix implementation | `tdd` (red-green-refactor) |
| Open question / fact-finding | `research` (primary sources only) |
| Any claim, finding, or "all clear" to verify | `grilling` (adversarial interrogation) |
| Work too big for one session | `wayfinder`, `handoff` for state |
| Multi-ticket spec builds (to-spec/to-tickets output, parallel implementers) | `to-spec`, `to-tickets`, `implement-spec` |
| Session or work retrospective | `retro` |
| Teaching a concept or skill | `teach` |
| Issue / PR triage | `triage` |
| Decision belongs to a person (AFK/HITL) | `to-questionnaire`; `wizard` when that person must perform live steps |
| Stress-test a plan AND capture ADRs/glossary | `grill-with-docs` (no docs wanted: `grilling`/`grill-me`) |
| Domain vocabulary, GLOSSARY.md, ADRs | `domain-modeling` |
| Local PDF text/table extraction | `marker` (over ad-hoc pdftotext) |
| Draw.io architecture diagrams | `drawio` |
| Compaction or restart just happened | `planning-with-files` (planning read) |

Auto-activation is description matching only — trigger phrases live in each
skill's description, so keep them there when adding skills. `wait-what`,
`setup-matt-pocock-skills`, and `improve-codebase-architecture` keep
`disable-model-invocation: true` on purpose: only the user may start them (a
human judges that a message did not land; repo setup is a one-shot with side
effects; which deepening to pursue is the human's call per autonomy.md's
stewardship list, so the router never selects it).

**Workflow**:

1. Maintain the todo list from the first step: exactly one item in progress, update immediately on progress, and add items as the swarm reveals new work.
2. Round 1 — dispatch parallel subagents, one per investigation axis. Every prompt is self-contained: the goal, exact paths, constraints, the embedded skill methodology, and a deliverable format that requires file:line evidence plus "what would disprove this".
   - Standing constraint for every research subagent prompt: fidelity fetches (full-page markdown, JS-rendered pages, structured crawls) go through the family wrapper `fcrawl` (verbs scrape/search/map/crawl, e.g. `fcrawl scrape "<url>" -o <file>`; backed by the self-host at 127.0.0.1:3002; `fcrawl -- …` passes raw args to the pinned CLI). Exit 3 = stack down — degrade to webfetch and mark the claim "low-fidelity fetch". fcrawl is a read-only client: never edit the stack's .env/PROXY_SERVER or run compose; egress phase flips belong to quant's prepare_firecrawl_phase.sh. Battle-readiness scorecard: quant fin_daily docs/research/20260928-firecrawl-battle-readiness.md.
3. Round 2 — adversarial round. For every reported finding, dispatch an attacker whose assignment is to KILL the finding (grilling discipline): re-read the quoted code, check reachability in the real configuration, and reduce scope when it cannot kill outright. Also assign a reverse attacker to every "all clear / works fine" verdict.
4. Adjudicate personally. Re-read the code behind every killed verdict and every high-severity surviving verdict before reporting. Label anything relayed from a single subagent without your own verification as single-source.
5. Report: confirmed findings with post-attack severity, killed findings and why they died, and single-source items not yet attacked.
