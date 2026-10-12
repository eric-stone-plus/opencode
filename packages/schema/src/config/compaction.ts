export * as ConfigCompaction from "./compaction.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "../schema.js"

export class Keep extends Schema.Class<Keep>("Config.Compaction.Keep")({
  tokens: NonNegativeInt.pipe(optional),
}) {}

export class Info extends Schema.Class<Info>("Config.Compaction")({
  auto: Schema.Boolean.pipe(optional),
  prune: Schema.Boolean.pipe(optional).annotate({
    description:
      "Replace old tool output in the model's view with a marker, outside the newest 40k tokens of output; stored output is kept (default: true)",
  }),
  keep: Keep.pipe(optional),
  buffer: NonNegativeInt.pipe(optional),
}) {}
