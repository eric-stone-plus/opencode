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
default, not a bug. The fork's own two profiles no longer depend on that gate: `ForkProfilesPlugin`
creates `auto`/`goal` as built-in primaries (default `auto`) and removes `build`/`plan` when no
config document declares them, so a fresh clone without a seat still opens in Auto/Goal. The gate
still governs repository *overrides* — plugins, MCP servers, project instructions — which is the
part that needs a human decision.

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

## 2026-10-16 (later session) — both remaining items resolved

### 1. Project trust: no roots declared (closed default stands)

Operator call: `~/.config/opencode/trusted-roots` stays absent. Work habitually starts in
`/home/eric`, and that directory holds no project-side config the gate would need to admit
(`/home/eric/.opencode/` carries only `bin/`, `backups/`, `node_modules/`, and npm metadata — no
`opencode.jsonc`, no `AGENTS.md`, no plugins, no MCP servers), so the closed default costs nothing.
Declaring roots only ever widens trust; the file is the switch, and it remains the operator's call.

### 2. Subsessions and primary profiles: refused, never rewritten (option A)

Operator call: a session with `parentID` must not carry a primary profile, and the refusal must be an
explicit error rather than a silent rewrite. Landed as `packages/core/src/fork/child-agent.ts`
(`ChildAgent.assertAllowed` + `Session.ChildAgentError`) on four assignment seams:

- `Session.create` when an explicit agent resolves to primary (`packages/core/src/session.ts`);
- `Session.switchAgent` on a child — re-asserting the current agent is exempt, so rows created
  before the guard stay switchable (`packages/core/src/session/session.ts`);
- `SessionTransfer.import` when the transcript's `info.parentID` is set
  (`packages/core/src/session/transfer.ts`);
- `SessionContext.select`, the request build (`packages/core/src/session/context.ts`). Creation
  cannot resolve an *omitted* agent without booting the location's service graph, and session
  creation deliberately does not (`packages/core/test/session-remove.test.ts:95` pins an empty
  `RcMap`), so the omitted agent resolves where the runner resolves it, and a primary there is
  refused the same way.

The server maps the error to `InvalidRequestError` 400 `kind: "primary_agent_child"` on create,
switchAgent, and import (`packages/server/src/handlers/session.ts`). The invariant, the exemptions,
and the import path are pinned by `packages/core/test/fork/child-agent.test.ts`; the evidence and
consequences live in `docs/adr/0011-two-modes-and-frozen-skills.md`.
