export * as ForkPrune from "./prune.js"

import { Message, type ContentPart } from "@opencode/ai"
import { estimatePart } from "../compaction.js"

/** Tokens of tool output at the tail of the conversation that always stay in the model's view. */
export const PROTECT = 40_000
/** Older output is elided in steps of this many tokens, so the prompt prefix only changes once per step. */
export const STEP = 20_000
export const MARKER = "[Old tool result content cleared]"
// Skill output is instruction text the model keeps acting on; clearing it silently drops the skill.
const KEPT_TOOLS = new Set(["skill"])

const elidable = (part: ContentPart): part is Extract<ContentPart, { readonly type: "tool-result" }> =>
  part.type === "tool-result" &&
  // A hosted tool's result carries provider state that has to replay verbatim.
  part.providerExecuted !== true &&
  // Errors are short and say what not to repeat.
  part.result.type !== "error" &&
  !KEPT_TOOLS.has(part.name) &&
  !(part.result.type === "text" && part.result.value === MARKER)

/**
 * The model's view of a conversation with old tool output replaced by a marker; storage is untouched. Everything
 * outside the newest `PROTECT` tokens of output may go, oldest first, but the cut only moves in `STEP`-sized jumps
 * of the running total. The same history therefore always yields the same view, and the prefix a provider caches
 * changes only when the conversation has grown by a whole step. Returns the input when nothing is elided.
 */
export const elide = (messages: Array<Message>): Array<Message> => {
  const outputs = messages.flatMap((message) =>
    message.content.filter(elidable).map((part) => ({ part, tokens: estimatePart(part) })),
  )
  const total = outputs.reduce((sum, output) => sum + output.tokens, 0)
  const cut = Math.floor(Math.max(0, total - PROTECT) / STEP) * STEP
  if (cut === 0) return messages

  const { cleared } = outputs.reduce(
    (state, output) => {
      const sum = state.sum + output.tokens
      if (sum <= cut) state.cleared.set(output.part, { ...output.part, result: { type: "text", value: MARKER } })
      return { sum, cleared: state.cleared }
    },
    { sum: 0, cleared: new Map<ContentPart, ContentPart>() },
  )
  if (cleared.size === 0) return messages
  return messages.map((message) =>
    message.content.some((part) => cleared.has(part))
      ? new Message({ ...message, content: message.content.map((part) => cleared.get(part) ?? part) })
      : message,
  )
}
