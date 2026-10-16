# Two modes (auto, goal), a frozen skill set, and no self-evolution

Owner call 2026-10-16. The fork had one behavior contract shared by every
session: the swarm playbook lived in `AGENTS.goal.md` and reached `auto` too, so
"just solve this quickly" and "close this out flawlessly" cost the same. The same
seat also let the agent rewrite its own brain: `mpskills-update.ts` fetched,
re-vendored, and committed the skill set from inside a session, and the mode
policy arrived through three mechanisms (the `instructions` array, the binary
standing cards, the agent bodies) with no single source.

Decided: `auto` and `goal` are two contracts whose only source is their card
(`bootstrap/agent/auto.md`, `bootstrap/agent/goal.md`, both managed). `auto`
executes, self-verifies with the work's own checks, and reports terse — no swarm,
no long discussion. `goal` runs the adversarial swarm playbook (todo list,
parallel Round-1 axes, Round-2 attackers, personal adjudication, full gates) and
closes under a checklist, with the report in Chinese. The `instructions` array
and both instruction documents (`autonomy.md`, `AGENTS.goal.md`) are deleted;
that array was also the one injection path that bypassed the project trust gate,
because absolute and `~` entries load unconditionally. The mattpocock skill set is
frozen at the revision recorded in `skills/PROVENANCE.md`: `mpskills-update.ts` is
deleted, and updating is the operator's explicit
`bun run update-skills --source <checkout>`, reviewed and committed by hand. And
the seat (`~/.config/opencode/`) is read-only during work: the rules file
`AGENTS.md` is now tracked and managed, no plugin or hook may write instructions,
skills, cards, or config at run time, and nothing that runs on its own may
commit.

## Consequences

- A card body **replaces** the harness system prompt
  (`packages/core/src/session/model-request.ts:117-121`), so both cards carry a
  `# Harness` section, and the goal card (12.3 KB) cannot also fit inside the
  12 KB instruction budget.
- The standing cards (`packages/core/src/plugin/fork/mode/*.txt`) are compiled
  into the binary, so a mode-policy change needs a rebuild; the agent bodies and
  `AGENTS.md` hot-reload.
- `script/check-drift.ts` carries ABSENT rows for the retired files on both sides
  (repo and seat) and compares `AGENTS.md` plus both cards byte-for-byte, so a
  reintroduced auto-updater, a resurrected instruction file, or a hand-edited
  card is drift. `script/skills-freeze.test.ts` fails if any plugin regains a
  git write or a skills-refresh path.
- The mode split is behavior, not decoration: it is pinned by the cards, the
  standing cards, and the mode tests, so a later edit that re-merges the two
  contracts has to delete those pins first.

## Known residuals (round-2 adversarial pass, 2026-10-16)

- **The shell cannot be permission-gated for the seat.** The `edit`/`write`
  tools are denied on `~/.config/opencode/**` in both resource forms (measured),
  but `shell` sees raw text, not paths, and the operator's install path stays
  available on purpose. The guardrail there is this document plus `AGENTS.md`.
- **A subsession can no longer be given a primary profile** (closed 2026-10-16, option A: refuse,
  never rewrite). `fork/child-agent.ts` refuses it on `Session.create` (explicit agent),
  `Session.switchAgent`, `SessionTransfer.import` (when the transcript names an agent), and at the
  request build
  (`SessionContext.select`), where an *omitted* agent resolves: creation cannot resolve one without
  booting the location's service graph, which session creation deliberately avoids
  (`packages/core/test/session-remove.test.ts:95` pins an empty `RcMap`). When the location's
  plugin activation has not settled, the guard waits for it and resolves once more, so the first
  child create after a boot cannot slip through. The refusal is `Session.ChildAgentError` -> HTTP
  400 `primary_agent_child`, and `packages/core/test/fork/child-agent.test.ts` pins all four seams
  plus the no-op switch, the unknown-id tolerance, and the import path;
  `packages/server/test/session-create.test.ts` pins the first-create-after-boot refusal, and the
  TUI resolves a session's own agent against the full list
  (`packages/tui/test/context/local-selection.test.tsx`) so a subagent-mode child stays promptable.
- **Hidden capability agents stay out of the child-profile guard** (title, compaction, summary):
  they are `mode: "primary"` only so they stay out of the subagent list, they carry no standing
  card, and compaction must serve child sessions. An explicit title regeneration on a child
  therefore still runs as the hidden `title` agent, which
  `packages/core/test/session-title.test.ts` deliberately pins; auto-titling already skips children.
- **The v1 migration copies `parent_id` and `agent` verbatim** (`database/v1-migration.bun.ts`): a
  v1 child row carrying a primary profile is imported without an error, and the request-build guard
  refuses its first run instead. No such row exists on this seat (1414 child sessions, 0 primary
  profiles), so the residual is theoretical here.
- **`instruction_entry` / `instruction_state` remain upstream mechanisms**: the
  instruction ledger records what was loaded per step, which is provenance, not
  free-form learned state. It is out of scope for this decision, and it is
  reachable only through the HTTP API.
- **Fidelity cost of the read context block**: `AGENTS.md` content read into a
  tool result is entity-escaped (`&lt;` becomes `&amp;lt;`) and capped at 12,000
  bytes across the whole block, so the deepest file can consume the budget of
  the files above it.
