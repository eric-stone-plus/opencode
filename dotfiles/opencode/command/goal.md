---
description: Set a persistent session goal and run it through the full adversarial-swarm playbook; 'clear' removes the goal
agent: goal
---
The user issued /goal. The server has already persisted the session goal file (or cleared it if the argument was clear/none/remove) — that file is re-stated to you as a system reminder every turn until cleared.

Goal argument: $ARGUMENTS

Interpret the argument as follows:

1. Non-empty argument other than "clear"/"none"/"remove": this text is now the session goal. Run it through the Goal mode playbook in AGENTS.md, end to end.
2. Argument is "clear", "none", or "remove" (case-insensitive): the session goal has been removed. Confirm in one short sentence; do not run the playbook.
3. Empty argument: nothing was changed. State the current session goal in one short sentence (it appears in the system reminder when set), or say that no goal is set.
