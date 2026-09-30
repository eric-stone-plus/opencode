// Personal fork: the binary at ~/.opencode/bin/opencode is built from this
// tree (bun run sync-upstream / script/build.ts), versioned 0.0.0-main-*.
// Every upstream installer path (curl script, npm, brew, ...) would replace it
// with the official release, and an upstream release always compares as a
// "major" bump against 0.0.0-main-*, so neither the startup check nor its
// "Update Available" prompt is meaningful here. Updates go through
// `bun run sync-upstream` instead; see PERSONAL.md.
export async function upgrade() {}
