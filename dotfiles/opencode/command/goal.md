---
description: Set a persistent session goal and run it through the full adversarial-swarm playbook; 'clear' removes the goal, 'edit <text>' replaces it without re-running
agent: goal
---
The user issued /goal. The server has already persisted the session goal file (or cleared it if the argument was clear/none/remove; rewrote it in place if the argument started with "edit ") — that file is re-stated to you as a system reminder every turn until cleared.

Goal argument: $ARGUMENTS

Interpret the argument as follows:

1. Argument starts with "edit " (case-insensitive): the goal is being replaced. The intended content is everything after "edit ", verbatim. The goal file at the path named in the system reminder should contain exactly that text (a trailing newline is fine either way); if the file instead starts with "edit " followed by exactly that text, rewrite it to remove that prefix. Then confirm in one short sentence ("Goal updated: <first line>"); do not run the playbook.
2. Argument is exactly "edit" (case-insensitive), or the argument is empty: nothing was changed. State the current session goal in one short sentence (it appears in the system reminder when set), or say that no goal is set.
3. Argument is "clear", "none", or "remove" (case-insensitive): the session goal has been removed. Confirm in one short sentence; do not run the playbook.
4. Any other non-empty argument: this text is now the session goal. Run it through the Goal mode playbook in AGENTS.md, end to end.
