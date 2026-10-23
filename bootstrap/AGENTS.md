# Global Rules

## Process management: never kill by command-line string

**Recognize the symptom**: truncated output, exit code 143/137, no error text. That means the command killed the very shell that was running it. **Do not retry the same command** — switch to one of the approaches below.

**Root cause**: the whole script is executed as `bash -c "<full text>"`, so the parent shell's `/proc/PID/cmdline` inherently contains your pattern. `pkill -f` excludes its own PID but **not its ancestors**, so SIGTERM lands on the shell hosting the session. One level deeper: the string you write is **both the operator and the data being scanned**, and models almost never simulate the observer itself. The `[x]` character-class trick is a patch, not a fix — any other literal occurrence on the same line (`rm`, `cd`, a path, a log name) re-arms the suicide. These one-liners come from interactive tutorials where argv is short; in an agent harness argv is the entire script.

**Hard rules**

- Never use `pkill -f`: it matches the full cmdline of every process, including the shell running it.
- `pgrep -f` is read-only, so it is safe to inspect with — but never pipe it into `kill` on the same command line, or the pattern still sits in the killing shell's argv.
- `killall` and `pkill -x` match `comm`, not the full cmdline, so they cannot see your script text; `comm` is capped at ~15 chars and useless for interpreted scripts. PIDs stay the default.
- Split **match** and **kill** into two separate tool calls: first read the process table and pick PIDs, then signal **numeric PIDs only**. `kill 12345` carries no target name in its argv, which severs the self-reference. What must be split is matching from killing — not keeping the character class and splitting `rm` instead.

**Approaches, most reliable first**

1. Record the PID at startup, stop by PID (preferred):
   ```bash
   setsid ./prog > /tmp/run.log 2>&1 & echo $! > /tmp/run.pid
   kill -- -"$(ps -o pgid= -p "$(cat /tmp/run.pid)" | tr -d ' ')"   # whole process group
   ```
2. Read the table, then signal:
   ```bash
   ps -eo pid=,ppid=,comm=,args=          # call one: pick PIDs by hand, exclude $$ and $PPID
   kill -TERM 12345                       # call two
   ```
3. If you must filter on the command line, keep the pattern out of the matcher's argv:
   ```bash
   printf '%s\n' 'myapp' > /tmp/kill.pat
   ps -eo pid=,args= | grep -F -f /tmp/kill.pat | awk '{print $1}' | xargs -r kill
   ```
4. Process name only: `pkill -x mydaemon` (comm is capped at ~15 chars). Not usable for interpreted scripts (`python app.py`) — go back to 1/2.
5. Change the axis: `fuser -k 8000/tcp`, `systemctl kill <unit>`, `docker compose down`, `start-stop-daemon`.
6. Put the script on disk and run the file, so no process cmdline contains the pattern:
   ```bash
   cat > /tmp/x.sh <<'EOF'
   ...
   EOF
   bash /tmp/x.sh      # cmdline is just "bash /tmp/x.sh"
   ```

**Enforcement**: a shared PreToolUse guard denies these shapes before they run — `~/.config/agent-hooks/block-unsafe-kill.sh`, wired into Claude Code / ZCode (`settings.json`), Grok (`~/.grok/hooks/*.json`), Kimi (`[[hooks]]` in `config.toml`) and opencode (`plugin/block-unsafe-kill.ts`). A denial is final: read the reason and switch approach, do not rephrase the same kill. A denial means **re-derive the whole command**, not patch the flagged token: on 2026-09-16 a denied `git add -A tools && git commit -m "…pkill -f…"` was retried with reworded message only — the retry dropped the `git add` half and committed a stale snapshot. When any part of a compound command was rejected, rebuild every part deliberately before running. Codex has no hook mechanism, so there these rules are the only defense. The guard is a pattern matcher, not a shell parser: it splits on `| ; &`, treats a segment led by a read-only inspector (`grep`, `echo`, `cat`, …) as data unless it holds `$( )`/backticks or a kill, and flags any `-…f…` / `--full` token inside a `pkill`/`pgrep` segment (`-…r…` / `--regex` for `killall`) regardless of flag order.

**Same class of self-reference traps** (the string you write is also the data being observed)

- `python -m gateway.cgroup_cleanup` (hermes) run by hand or as an agent tool call: `reap_cgroup()` SIGKILLs **every PID in the caller's own cgroup** — from a shell or tool call that is your own agent/terminal scope (2026-09-19: three opencode TUI deaths, "Process Exited from Signal 9", the bash tool call orphaned in `running`). It existed only as the gateway unit's `ExecStopPost=`; the `hermes-gateway-penetrate` unit was retired on 2026-09-28, so the module must never be run — there is no legitimate trigger left. Reading the file (`cat`/`sed`) is fine. Guarded by `block-unsafe-kill` since 2026-09-19, kept as defense-in-depth after the retirement.
- `ps aux | grep foo` matches grep itself → use `pgrep -a foo`, or `grep -v grep`.
- `grep -r pattern .` matches the script running it, or the rules file that contains the rule → add `--exclude` / `--exclude-dir`, or keep the script outside the searched tree.
- Searching logs matches the query itself (the command was echoed into the log) → filter by time window or a unique ID, never by the literal command text.
- Always start long-running work with `setsid` / `nohup` plus a PID file; never clean up by killing a name.
- A commit message is data, not operators: kill-pattern words inside `git commit -m "…"` are masked by the guard since 2026-09-18 — but never let a denial split your compound commands (see Enforcement).

## General

- Write repository documentation, code comments, commit messages, and PR text in English, for both private and public repositories.
- Fix what you find: when an audit or task turns up a defect, fix it in the same pass instead of reporting it as a leftover for the user; reporting without fixing is a bad habit. If a fix is genuinely risky or out of scope, say why explicitly.
- Never leave tails: remove the temp files, scratch scripts, staging dirs, and background processes a task created; finish or revert partial installs and config edits. Before declaring done, sweep for your own leftovers (files in /tmp, stray processes, a dirty `git status`) as part of the deliverable.
- Run destructive commands (`rm -rf`, `kill`, `git reset --hard`) separately from query commands, so a failure in the destructive one cannot swallow the query output.
- Before claiming "committed", `git status --porcelain` for the touched tree must be **empty** (or the residue explained). `git log -1` alone proved nothing on 2026-09-16: the commit existed while four modified files and an untracked TODO sat in the working tree, and the commit message described fixes that were in neither.
- When a command's output is empty or truncated with no error, suspect that it killed its own execution environment before suspecting the program.

## Seat architecture: no self-evolution

The seat (`~/.config/opencode/`) is the agent's own brain. During normal work,
treat every file in it as read-only: cards (`agent/*.md`), skills (`skills/`),
plugins (`plugin/`), hooks, `opencode.jsonc`, `AGENTS.md`, `lib/`. Nothing the
agent does as a side effect of other work may change how the agent itself
behaves on the next run. Declarative and version-controlled, or it does not
happen.

- **No side-effect writes.** Never create, edit, move, or delete a seat file
  while doing anything else. "While I was in there" is not a reason. The same
  applies to the fork checkout when the change would alter seat behaviour.
- **No self-install.** Never run `opencode plugin add|remove|update`,
  `opencode mcp add --global`, `bun run vendor-skills`, `bun run update-skills`,
  `bun run sync-upstream`, or `bootstrap/install.sh` as a side effect of other
  work, and never run anything whose effect is to rewrite the seat — unless the
  operator's task *is* that seat change (the one exception below). Otherwise those
  are operator commands.
- **No runtime writers.** No plugin, hook, or script may write instructions,
  skills, cards, or config while the agent runs. A plugin may read the seat; it
  may not mutate it. A plugin that needs to remember something uses session
  state, never the seat.
- **No auto-commits.** Nothing that runs on its own — plugin, hook, background
  job — may commit. A commit happens only when the operator asks for it in the
  task at hand, and it describes work the operator can review. A plugin that
  shells out to `git commit` is a bug, not a feature.
- **No learned state.** Behaviour comes only from version-controlled files.
  Never persist inferred preferences, model choices, or "improvements" into
  config, cards, skills, or DB metadata. Session history and the session goal
  file are records, not configuration.
- **Skills are frozen.** The vendored mattpocock set is pinned at the revision
  recorded in `skills/PROVENANCE.md`; updating it is an explicit operator task
  (`bun run update-skills --source <checkout>`, then review and commit), never a
  background refresh.
- **The one exception.** When the operator explicitly asks for a seat change, do
  exactly that change as its own task: show the diff, keep it version-controlled,
  and let the operator commit. An explicit request is per-task; it never
  generalises into permission to keep tuning the seat later.

## Key hygiene (all agents on this machine)

Credential material lives in `$HOME` by operator decision (2026-10-06 — "don't move the keys, but all agents be extra careful"). This rule is the "extra careful" part, and it binds every agent on this host:

- **Never read, print, or grep credential files.** Not with file tools, not with `bash cat/grep/less`, not "to confirm which key it is". Known stores: `~/.config/agent-secrets/`, `~/.claude/.api-token`, `~/.config/claude-env`, `~/.config/opencode/env`, `~/.grok/`, `~/.grokbot/`, `~/.jwt_tool/`, `~/.ssh/`, `~/.gnupg/`, `~/.aws/`, `~/.docker/config.json`, `~/.npmrc`, `~/.netrc`, `~/.git-credentials`, `~/.smbcredentials*`, `~/.config/Grok Bot/`, `~/.config/causeway/secrets/`, `~/.config/LarkShell/`, `~/.config/gcloud/`, `auth.json` / `credentials.json` / `*.pem` / `*.env` / `id_rsa`-style files anywhere.
- The `secret-path-guard` plugin mechanically blocks the file tools (`read`/`glob`/`grep`/`edit`/`write`) on those paths; it cannot see through `bash`, so this instruction is the enforcement layer for shell-mediated access. Do not treat "the plugin allowed it" as permission.
- When a task genuinely needs a non-secret field from such a file (e.g. a key *name*, a base URL), use a field-targeted filter that cannot print the secret (e.g. `cut -d= -f1` on an env file), and never echo the value into logs, commits, or tool output.
- Keep file modes: credential files `0600`, credential dirs `0700`. If you create one, create it that way.

## Codex CLI updates on this machine

- The TUI popup `Update available! … 1. Update now (runs sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | …')` is a dead end here — never choose it, and never re-run that command shape. Measured 2026-09-26: `chatgpt.com` is DNS-poisoned (resolves to a Meta `face:b00c` address, connect fails), its 302 target `releases.openai.com` returns 403 on a direct CN connection, and GitHub release **asset bodies** (`objects.githubusercontent.com`) trickle at ~20 KB/s — the 147 MB `codex-package` moved 23 MB in 19 minutes before I killed it. `api.github.com` metadata and even `HEAD` on the asset answer 200, so "GitHub is reachable" is a false all-clear.
- Working path = the `codex-update` bash function in `~/.bashrc` (`codex-update [version]`): fetch `install.sh` from `raw.githubusercontent.com/openai/codex/main/scripts/install/install.sh` (byte-identical to the chatgpt.com copy, sha256 `150e3cf675682efeaac115aa3747add3f27887896d04ce6d0b56478d8b428bf6`, verified), run it with the causeway 18880 proxy exported (3.2 MB/s) plus `CODEX_NON_INTERACTIVE=1 CODEX_INSTALLER_USE_RELEASES_OPENAI_COM=0`, so the installer only touches GitHub and still enforces its own `codex-package_SHA256SUMS` check. `codex-update-prune` runs afterwards and keeps only `current` + the previous release — the installer never cleans up, and 7 releases had piled up to 2.3 GB.
- `check_for_update_on_startup = false` in `~/.codex/config.toml` suppresses the misleading popup (`codex doctor` no longer lists an update note). Re-enable only if direct egress to chatgpt.com/releases.openai.com starts working again.
- General lesson: a HEAD/200 or an API response proves nothing about bulk-download throughput through the GFW. Before trusting a "reachable" verdict for a multi-hundred-MB fetch, probe with a ranged GET (`curl -r 0-8388607 -w '%{speed_download}'`) and compare direct vs. proxy.

## Reasoning discipline

- Decide from the evidence you have, then act. Do not restate a settled
  trade-off or re-derive the same conclusion: a repeated internal loop is a
  process bug, not thoroughness.
- Keep user-visible narration short: what changed, the evidence, the next
  step. Long deliberation belongs in the plan file, not the transcript.
- When a finding is understood, write the fix; when a check fails, fix it.
  Never narrate the same options twice.

## Code review routing (mandatory)

Two modes, and the trigger decides which one runs.

- **Normal review — automatic, no prompt.** The trigger is the code change,
  not the mode. In **Goal** mode, after any code change — an `edit`/`write`/
  `patch` to a code file, or a shell command that writes code — run the full
  review before declaring the change done: the normal path
  (`code-review-playbook`: deterministic checks + quick Standards/Spec + the
  `code-audit` OCR gate + a fail-closed verdict) for small, local, low-risk
  changes; the deep path (next bullet) automatically when its criteria apply.
  In **Auto** mode, the `open-code-review` plugin's automatic OCR security gate
  is the code-change check: it recognizes the same edits and shell writes and
  injects only high/critical findings; do not run the full playbook ceremony
  unless the user asks or the gate reports a finding. Auto stays fast; Goal
  stays reliable. The normal path does not run the deep protocol; the deep
  bullet decides when that runs.
- **Scope — code changes only.** This routing is for code. For a non-code task
  (prose, docs, data, research, ops, a pure question), do not load
  `code-review-playbook`, `code-audit`, or `deep-audit`; answer directly. A
  user-invoked "review" of a non-code artifact uses that artifact's own review
  method, not this code-review path. Investment, research, and ops work keep
  the discussion skills (`grilling`, `wayfinder`, `teach`, `research`,
  `domain-modeling`); only the code-review/audit path is skipped.
- **Deep review — automatic in Goal, user-invoked in Auto.** In **Goal** mode,
  after any code change, automatically choose normal vs deep: choose the deep
  review when the change touches security-sensitive surfaces (auth, secrets,
  crypto, permissions, network, shell/command execution, file access, SQL,
  deserialization, migrations), public APIs/contracts, data models or
  persistence, concurrency, dependency manifests/lockfiles, or CI/release
  config; when it changes more than 200 lines or more than 10 files; or when the
  normal review finds critical/high or cannot verify. Record the choice and the
  reason in the final report; when in doubt, choose deep. No user phrase is
  needed. An explicit request for a code review or a deep audit — in any
  language — forces the deep review or deep audit path respectively; do not
  require an English keyword. In **Auto** mode, run the deep path only on
  explicit user request; otherwise recommend switching to Goal.
- **Do not substitute.** Never answer an explicit user review request with the
  normal playbook. In Goal mode, the deep path is auto-selected by the criteria
  above; in Auto mode, do not run it automatically — report BLOCKED and
  recommend Goal/deep-audit when the normal gate finds critical/high.
- Every verdict is one of APPROVE / APPROVE-WITH-NITS / NEEDS-FIXES / BLOCKED /
  INCOMPLETE, with evidence and the exact commands run. If a required check
  cannot run, say so and use INCOMPLETE; never silently skip. Never claim "no
  vulnerabilities".
- A full-repo audit is a separate request; do not run the Cloudflare
  security-audit protocol on every code review.
