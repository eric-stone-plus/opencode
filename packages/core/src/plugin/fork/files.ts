export * as ForkFiles from "./files.js"

import type { Global } from "@opencode/util/global"
import path from "path"

// Session-scoped state lives in the data directory, never inside a project: V2 does not generate a
// `.opencode/.gitignore`, so a goal written into a repository would be one `git add -A` from a commit.
export const goal = (global: Global.Interface, sessionID: string) => {
  const directory = path.join(global.data, "goals")
  const file = path.join(directory, `${sessionID}.md`)
  // A session ID is not always minted locally: `session import` adopts one from a fetched payload and
  // nothing upstream checks its shape beyond the `ses` prefix, so a traversing ID would otherwise name
  // any path on the machine for the goal read, write and delete.
  if (path.dirname(file) !== directory) throw new Error(`Invalid session id for goal state: ${sessionID}`)
  return file
}
