# Config load order is pinned: managed layers bracket the chain

Documents merge flat in one list, and that list is load-bearing twice over: a scalar is overridden by every later document, and `permission` rules are scanned with `Array.findLast` (`packages/core/src/permission.ts:91`), so "which file gets to re-allow what" is a property of the order rather than of any single file. The order, lowest to highest (`packages/core/src/config.ts:280-287`), is:

1. `managedPolicies` — the `experimental.policies` halves of the managed documents, kept in reverse managed order.
2. `wellknown` — the well-known URL documents (`config.ts:178`).
3. `globalSupplementary` — the seat's global config directory (`OPENCODE_CONFIG_DIR`, default `~/.config/opencode`).
4. `explicit` — the `OPENCODE_CONFIG` file (`cli/src/server-process.ts:121`).
5. `direct` — the `opencode.json` / `opencode.jsonc` files the upward walk found (`config/discovery.ts:124`).
6. `projectSupplementary` — the `.opencode` directories the upward walk found (`config/discovery.ts:126-129`).
7. `content` — `OPENCODE_CONFIG_CONTENT` (`config.ts:234-239`).
8. `managedSettings` — the non-policy halves of the managed documents, system directory first and macOS MDM preferences second, so preferences override the system directory as in V1.

The managed split is deliberate: managed settings load last so they override everything, while the policy halves are separated out and load first because policies evaluate in reverse load order and must keep final file-based authority (`config.ts:240-247`).

Consequences, in the tightening direction:

- A global deny can be re-allowed by a project document, because project roots load later than the global directory. To deny from the seat and have it stick, write the deny in a managed settings document (last), or rely on the short-circuit below.
- A configured deny is not overridable by anything merged later in the rule list: saved approvals land after configured rules, but a configured deny short-circuits before they are consulted (`permission.ts:165-177`). A saved allow elevates an `ask` and never overrides a `deny`.
- Within one document, rules merge by appending the document rules to every agent first and `agents.<id>.permissions` after (`config/plugin/agent.ts:84-92`, `:121-124`), so the last rule written still wins.
- The list order itself is the deny guarantee: reading only the project file is not enough to conclude what is denied, and any change to this order is an upstream-design change rather than a local fix.

Pinned by `packages/core/test/permission-precedence.test.ts`. `PERSONAL.md` (project config trust gate section) and this ADR are the two places that must move together when the order changes.
