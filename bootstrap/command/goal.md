---
description: Set a persistent session goal and run it through the full adversarial-swarm playbook; 'clear' removes the goal, 'edit <text>' replaces it without re-running
agent: goal
---
The user issued /goal. The server has already parsed the argument and applied it: it wrote, replaced, or cleared the session goal file (or left it untouched), and the current session goal, if one is set, is re-stated to you as a system reminder every turn until cleared. The server's result is authoritative. Never reconstruct, re-derive, or rewrite the goal from the argument text, and never edit the goal file yourself; the session goal is exactly what the system reminder shows.

Server result: $GOAL_RESULT

Argument as typed (for reference only): $ARGUMENTS

The grammar the server applied: an argument starting with lowercase `edit` followed by a space replaces the goal with the rest (one wrapping quote pair removed) without re-running; bare `edit`, `edit ""`, or no argument shows the current goal and changes nothing; a bare `clear`, `none`, or `remove` (any case) removes the goal; anything else is the new goal text verbatim, with one wrapping quote pair removed. To start a goal with the word edit, capitalize it (`/goal Edit the README …`) or quote the whole argument (`/goal "edit the README …"`).

Act on the server result:

1. `updated`: the goal was replaced. Confirm in one short sentence ("Goal updated: <first line of the session goal shown in the system reminder>"); do not run the playbook.
2. `unchanged`: nothing was changed. State the current session goal in one short sentence (from the system reminder), or say that no goal is set; do not run the playbook.
3. `cleared`: the session goal was removed. Confirm in one short sentence; do not run the playbook.
4. `set`: the session goal shown in the system reminder is the new goal. Run it through the Goal mode playbook in AGENTS.md, end to end.
