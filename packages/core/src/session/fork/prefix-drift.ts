export * as ForkPrefixDrift from "./prefix-drift.js"

import type { Message, SystemPart } from "@opencode/ai"
import { Hash } from "@opencode/util/hash"

/**
 * Prefix drift attribution (borrow C1, reduced to the diagnostic a fork can own).
 *
 * Provider-side prompt caching only pays while the request prefix stays byte-identical: the system
 * text and the leading messages. Several things rewrite that prefix on this seat - the fork's own
 * instruction and mode plugins, compaction, and a `session.context` hook that edits the draft - and
 * when a part moves the cache misses and the whole prefix is re-prefilled. Nothing said which moved.
 *
 * This pins the bytes of each prefix part and names the first one that differs between two requests of
 * the same session. Appending a turn is not drift: only parts present in both requests are compared, so
 * a new message extends the prefix and still hits the cache. The KV contract itself is deliberately not
 * ported - this reports, it does not enforce.
 */

/** How many leading messages count as prefix. Providers cache long prefixes; this is the fork's window. */
export const PREFIX_MESSAGES = 8
/** Process-local memory: how many sessions keep a pinned prefix. */
export const PREFIX_SESSIONS = 256

export interface Part {
  readonly label: string
  readonly bytes: string
}
export type Prefix = ReadonlyArray<Part>

export const prefixOf = (request: {
  readonly system?: ReadonlyArray<SystemPart>
  readonly messages: ReadonlyArray<Message>
}): Prefix => [
  ...(request.system ?? []).map((part, index) => ({ label: `system[${index}]`, bytes: JSON.stringify(part) })),
  ...request.messages.slice(0, PREFIX_MESSAGES).map((message, index) => ({
    label: `message[${index}]:${message.role}`,
    bytes: JSON.stringify(message.content),
  })),
]

/** A short fingerprint of the whole prefix: equal fingerprints mean identical bytes. */
export const fingerprint = (prefix: Prefix) =>
  Hash.fast(prefix.map((part) => `${part.label}\u0000${part.bytes}`).join("\u0000")).slice(0, 12)

/**
 * The first part whose bytes differ between two requests of the same session, and how many leading
 * parts matched before it. Parts beyond the shorter request are an extension, not a change.
 */
export function drift(previous: Prefix, current: Prefix) {
  const shared = Math.min(previous.length, current.length)
  for (let index = 0; index < shared; index++) {
    if (previous[index]!.bytes !== current[index]!.bytes) return { at: current[index]!.label, matched: index }
  }
  return undefined
}
