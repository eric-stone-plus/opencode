export * as ForkDoomLoop from "./doom-loop.js"

import { Hash } from "@opencode/util/hash"

/** Identical calls in a row before the call is refused. */
export const THRESHOLD = 3
/** Identical calls in a row before the run is stopped: the model was told to change approach on every call since the third. */
export const STOP = THRESHOLD * 2

export const message = (tool: string, count: number) =>
  count >= STOP
    ? `You have called the ${tool} tool with identical input ${count} times in a row. This call was not executed and the run is being stopped: the same call kept repeating after being told to change approach (doom loop).`
    : `You have called the ${tool} tool with identical input ${count} times in a row, so this call was not executed. ` +
      "Repeating it will not produce a different result. Change your approach: use different input, a different tool, " +
      "or move on to the next step. If you keep repeating this exact call, the run will be stopped."

type Streak = { readonly key: string; readonly count: number; readonly execute?: string }

/**
 * Counts consecutive identical tool calls per Session, across Steps. Only tool calls count, so text or reasoning
 * between two identical calls does not break the run. Calls a Code Mode script makes carry the id of the `execute`
 * call that owns them and are left out: a script may legitimately repeat a call.
 */
export const make = () => {
  const streaks = new Map<string, Streak>()
  return {
    /** Length of the run of identical calls that ends with this one, or 0 for a call inside a Code Mode script. */
    record: (sessionID: string, callID: string, tool: string, input: unknown) => {
      const previous = streaks.get(sessionID)
      if (tool !== "execute" && previous?.execute === callID) return 0
      // The input is hashed so a session does not retain the arguments of its last call, which can be a whole file.
      const key = `${tool}\0${Hash.fast(JSON.stringify(input ?? null))}`
      const count = previous?.key === key ? previous.count + 1 : 1
      streaks.set(sessionID, { key, count, ...(tool === "execute" ? { execute: callID } : {}) })
      return count
    },
    reset: (sessionID: string) => streaks.delete(sessionID),
  }
}
