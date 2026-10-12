# V1-API plugins awaiting a V2 port

These files were written for the legacy `@opencode-ai/plugin` API, which no longer exists. They are not installed by
`bootstrap/install.sh` and not checked by `bootstrap/verify.sh`. Their tests are kept next to them for the port; the
import paths inside them still point at the legacy tree.

- `mpskills-update.ts`: refreshes the vendored Matt Pocock skills (24 h throttle, cross-process lock, auto commit).
- `skill-hints.ts`: skill hints injected into the prompt.
- `open-code-review.ts`: OpenCodeReview tools.

Port them with `Plugin.define` from `@opencode/plugin` (see `bootstrap/plugin/block-unsafe-kill.ts` for the V2 shape),
then move each one back to `bootstrap/plugin/` and add it to the loops in `install.sh` and `verify.sh`.
