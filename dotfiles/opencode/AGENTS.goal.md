# Goal mode: adversarial subagent swarm (default playbook)

Loaded via the `instructions` list in `~/.config/opencode/opencode.jsonc`
(`"~/.config/opencode/AGENTS.goal.md"`). Distributed by this repo's
`sync-upstream` script from `dotfiles/opencode/AGENTS.goal.md`.

**Trigger**: any `/goal` objective, or any explicit request for autonomous multi-turn work. Unless the user says otherwise, run this playbook instead of working the goal single-threaded.

**Visual switch**: a `goal` agent (color `error`) and a `/goal` command are configured globally. Switching the session to the `goal` agent (Tab / `<leader>a`) renders the status-bar agent name in red ("Goal") for the whole session — that is the persistent mode indicator. The `/goal` command runs a one-shot swarm turn under the goal agent: that turn's user-message left border, spinner, and the assistant footer's `▣ <Mode> · <model>` marker go red (the status bar follows the selected agent, not the command; `▣` is the message-footer marker, the status bar has no glyph). Independently of the agent switch, `/goal` also persists the objective as a session goal that is re-stated in a system reminder every turn — any agent, survives compaction — until `/goal clear` (or `none`/`remove`); the goal steers across mid-session agent switches. When a goal is set, the latest assistant message footer also shows `· ⎇ <first line of the goal>`.

**Editing the goal mid-run**: `/goal edit <new text>` rewrites the goal file in place **without** re-running the playbook — use it for wording fixes and re-scoped objectives; `/goal <objective>` launches the swarm turn. It is a plain subcommand of `/goal` — no separate agent, no separate mode — implemented in the fork's `SessionPrompt.command` goal branch (`packages/opencode/src/session/prompt.ts`, see PERSONAL.md): the server rewrites the file and publishes `goal.updated` (footer `⎇` updates immediately), and the goal turn only confirms in one sentence. `/goal edit` with no text shows the current goal; `/goal clear` (or `none`/`remove`) removes it. Caution: a command whose template binds a dedicated agent rebinds the whole session to that agent (`setAgentModel`) and can self-lock the session's tool surface — never build goal utilities as separate agent-bound commands.

**Self-set goals**: the goal file is ordinary disk state and the goal agent has shell access, so the agent *can* write the next goal itself. This is an entrance, not a hole, and it is protocol-bound: (1) only after the current goal's own checks have passed and the report is delivered; (2) the follow-up objective must be derived from the findings themselves, never invented work; (3) announce it in one line in the report ("set follow-up goal: X because Y"); (4) at most one hop per goal — a self-set goal may not self-set another; (5) never mid-goal, never silently. Write mechanics: `printf '%s\n' '<objective>' > <goal-path>` (the path appears in the goal reminder). Note: a bash-written goal updates the reminder from the next turn but does not emit `goal.updated`, so the footer segment lags until the next `/goal`.

**Skills library**: the mattpocock skill set (25 packages) lives at `~/.config/opencode/skills/<name>/SKILL.md`, re-vendored from upstream by `mpskills-update` (check `skills/PROVENANCE.md` for the revision before trusting your memory of a skill's text — a re-vendor can change it mid-session).

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
| Merge conflict in the way | `resolving-merge-conflicts` |

**Workflow**:

0. Refresh the skills library first: run `~/.local/bin/mpskills-update` (self-throttled to one pull per week, 60s timeout, exits silently when fresh or unreachable).
1. Maintain the todo list from the first step: exactly one item in progress, update immediately on progress, and add items as the swarm reveals new work.
2. Round 1 — dispatch parallel subagents, one per investigation axis. Every prompt is self-contained: the goal, exact paths, constraints, the embedded skill methodology, and a deliverable format that requires file:line evidence plus "what would disprove this".
   - Standing constraint for every research subagent prompt: fidelity fetches (full-page markdown, JS-rendered pages, structured crawls) go through the family wrapper `fcrawl` (verbs scrape/search/map/crawl, e.g. `fcrawl scrape "<url>" -o <file>`; backed by the self-host at 127.0.0.1:3002; `fcrawl -- …` passes raw args to the pinned CLI). Exit 3 = stack down — degrade to webfetch and mark the claim "low-fidelity fetch". fcrawl is a read-only client: never edit the stack's .env/PROXY_SERVER or run compose; egress phase flips belong to quant's prepare_firecrawl_phase.sh. Battle-readiness scorecard: quant fin_daily docs/research/20260928-firecrawl-battle-readiness.md.
3. Round 2 — adversarial round. For every reported finding, dispatch an attacker whose assignment is to KILL the finding (grilling discipline): re-read the quoted code, check reachability in the real configuration, and reduce scope when it cannot kill outright. Also assign a reverse attacker to every "all clear / works fine" verdict.
4. Adjudicate personally. Re-read the code behind every killed verdict and every high-severity surviving verdict before reporting. Label anything relayed from a single subagent without your own verification as single-source.
5. Report: confirmed findings with post-attack severity, killed findings and why they died, and single-source items not yet attacked.
