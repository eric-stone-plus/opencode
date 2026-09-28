export * as SessionGoal from "./session-goal"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { SessionID } from "./session-id"

export const Info = Schema.Struct({
  text: Schema.String.annotate({ description: "Session goal text, empty string when no goal is set" }),
  path: Schema.String.annotate({ description: "Absolute path of the session goal file" }),
}).annotate({ identifier: "SessionGoal" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

const Updated = define({
  type: "goal.updated",
  schema: {
    sessionID: SessionID,
    text: Schema.String,
    path: Schema.String,
  },
})
export const Event = { Updated, Definitions: inventory(Updated) }
