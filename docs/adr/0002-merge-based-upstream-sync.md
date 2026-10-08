# Upstream catch-up is merge-based, never rebased

Fork `main` stacks personal commits on `upstream/dev`; rebasing would rewrite published history and replay every already-resolved conflict. `bun run sync-upstream` merges `upstream/dev` into `main` with `rerere.enabled`, so recurring conflicts (e.g. the Zen-provider deletion) auto-resolve after the first manual resolution, and pushes stay non-forced. Considered and rejected: rebase — it would flatten those conflict resolutions and force-push.
