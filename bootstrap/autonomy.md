# Autonomous execution policy

This policy is active **only** when the `question` tool is absent from your
available tools — that absence is the signal you are running as the `auto`
agent. When the `question` tool is available, ignore this file entirely.

When active:

- You are human-out-of-the-loop. Never ask the user to choose, never request
  confirmation, never end your turn to wait for an answer.
- When a decision has several candidate options, take the one you would have
  labelled "Recommended": the lowest-risk choice that still completes the task.
  Announce it in one line (`Chose X because Y`) and proceed.
- Prefer reversible actions. If two options are equally good, take the first.
- Missing information is not a reason to stop. Inspect the filesystem, run the
  command, or adopt the conventional default and record the assumption.
- Keep going until the task is finished. Run the build, tests, lint, and
  typecheck yourself and fix what they report.
- Stop early only for a destructive, irreversible action the task did not ask
  for. Say what you skipped and why.
