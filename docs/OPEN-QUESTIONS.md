# Open questions

Decisions that belong to the operator, not to an agent. Each entry names what it blocks, what the
agent did in the meantime, and where the evidence lives.

## 2026-10-16 — two modes, frozen skills, project trust

Everything else from that session is landed on `main` (`ef50f8988d`, `40ecbd497a`, `d88091a548`,
`a7becf96eb`). The seat, the installed binary (`v0.0.0-main-202610160738`) and the running service
were verified against those commits.

### 1. Which repositories, if any, may load their own project config?

The trust gate is live and **closed** on this seat: `~/.config/opencode/trusted-roots` does not
exist, so no project's `opencode.jsonc`, `AGENTS.md` chain, plugins, or MCP servers load
(`bootstrap/README.md` §4 documents the format, the fail-closed parsing, and the `=0|false`
trust-ALL escape hatch). Declaring roots *widens* trust, so the list is the operator's call. Until
it exists, a repository that expects its own config is silently ignored — that is the intended
default, not a bug.

### 2. May a subsession run a primary profile?

`packages/core/src/tool/plugin/subagent.ts:137-138` refuses a primary agent for the `subagent` tool
("Agent goal cannot run as a subagent"), but two other paths do not:

- an inline command declared with `subagent: true` and `agent: goal`
  (`packages/core/src/config/plugin/command.ts:98-105` — the branch has no mode guard);
- `POST /api/session` with `{parentID, agent: "goal"}`.

The round-2 attacker measured both producing a goal subsession that carries the full playbook (and
no goal file: the goal reminder is suppressed for subsessions). The model cannot reach either path
— its own spawn tool is guarded — a human config or an API client can. Closing it means deciding
what the fallback should be when the selected agent is primary, which is a product decision, so it
is left here.

### 3. The seat deny covers the tools, not the shell

`edit`/`write` on `~/.config/opencode/**` is denied for both profiles in both resource forms
(measured: `permission.rejected`, absolute and location-relative). `shell` cannot be gated this way:
the permission model sees raw shell text, not paths, and the operator's install path
(`bootstrap/install.sh`, `cp`) deliberately stays available. The guardrail for that path is the
AGENTS.md rule ("no self-evolution") plus the audits: the `check-drift` plugin allowlist and
`script/skills-freeze.test.ts`.

### 4. When to re-vendor the mattpocock skills

The set is pinned at `49dd158d1076134a641b33efb035946536778336` (`skills/PROVENANCE.md`) and the
update path is explicit: `bun run update-skills --source <checkout>` (fetches nothing, commits
nothing, validates the source before touching the vendored tree). Nothing is blocked; this is a
"when the operator wants it" decision.
