export * as ForkFiles from "./files.js"

import type { Global } from "@opencode/util/global"
import path from "path"

// Session-scoped state lives in the data directory, never inside a project: V2 does not generate a
// `.opencode/.gitignore`, so a goal written into a repository would be one `git add -A` from a commit.
export const goal = (global: Global.Interface, sessionID: string) => path.join(global.data, "goals", `${sessionID}.md`)
