import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"

type Step = SessionMessageAssistant

const steps = (messages: readonly SessionMessageInfo[]) =>
  messages.filter((message): message is Step => message.type === "assistant")

/**
 * The trailing run of model calls that share the newest step's model. Switching models starts a
 * new measurement window: the strip describes the model currently in use instead of blending its
 * calls with the previous model's history. The in-flight step opens the new window, so until one
 * of the run's calls settles the cells have nothing to show rather than showing the old model.
 */
function currentModelSteps(messages: readonly SessionMessageInfo[]) {
  const all = steps(messages)
  const latest = all.at(-1)
  if (!latest) return []
  const start = all.findLastIndex(
    (step) => step.model.providerID !== latest.model.providerID || step.model.id !== latest.model.id,
  )
  return all.slice(start + 1)
}

/**
 * Settled provider throughput samples: the output and reasoning tokens of every finished model call
 * in the current model window together with the time those calls spent talking to the provider.
 *
 * Reasoning counts because providers that report it apart from the visible output (DeepSeek) spend most of the wall
 * time on it. The clock is `time.created` (request dispatch) to `time.streamed` (provider response body ended), so
 * tool execution never enters the denominator, and a step still streaming has no `streamed` yet and contributes
 * nothing: while a request is in flight the averages cover the settled calls of the current window, and they are
 * undefined when that window has none.
 */
function throughput(messages: readonly SessionMessageInfo[]) {
  const settled = currentModelSteps(messages).flatMap((step) => {
    if (step.time.streamed === undefined || step.tokens === undefined) return []
    const millis = step.time.streamed - step.time.created
    if (!Number.isFinite(millis) || millis <= 0) return []
    return [{ tokens: step.tokens.output + step.tokens.reasoning, millis }]
  })
  const tokens = settled.reduce((total, step) => total + step.tokens, 0)
  const millis = settled.reduce((total, step) => total + step.millis, 0)
  if (tokens <= 0 || millis <= 0) return undefined
  return { tokens, millis }
}

/**
 * Session token throughput for the prompt status strip: the tokens of every settled model call of the current model
 * divided by the time those calls spent talking to the provider. A model switch resets the window, so the cell
 * never blends two models' speeds.
 *
 * This is effective throughput, including time to first token and pauses inside a response, not decoder speed. It is
 * undefined until a step has both usage and a positive duration, and nothing is estimated.
 */
export function tokensPerSecond(messages: readonly SessionMessageInfo[]) {
  const settled = throughput(messages)
  if (!settled) return undefined
  return settled.tokens / (settled.millis / 1000)
}

/**
 * Mean wall time per generated token over the same settled calls the throughput cell measures: total provider
 * milliseconds over total output and reasoning tokens. This is the reciprocal view of `tokensPerSecond`, so the two
 * cells always agree, and it is undefined under the same conditions.
 */
export function timePerOutputToken(messages: readonly SessionMessageInfo[]) {
  const settled = throughput(messages)
  if (!settled) return undefined
  return settled.millis / settled.tokens
}

/**
 * Mean time from dispatching a model call to its first reasoning output, over the current model's settled calls.
 *
 * V2 stamps every step with its own dispatch time, so each call is a clean sample and no later call has to be
 * dropped for being timed from the start of the reply. Only reasoning parts carry a start time (text parts have none),
 * so a call that opens with text or a tool call is untimed and never dilutes the average.
 */
export function timeToFirstToken(messages: readonly SessionMessageInfo[]) {
  const samples = currentModelSteps(messages).flatMap((step) => {
    if (step.time.completed === undefined || step.error !== undefined) return []
    const first = step.content[0]
    if (first?.type !== "reasoning" || first.time === undefined) return []
    const millis = first.time.created - step.time.created
    return Number.isFinite(millis) && millis >= 0 ? [millis] : []
  })
  if (samples.length === 0) return undefined
  return samples.reduce((total, value) => total + value, 0) / samples.length
}

/**
 * Cache hit rate over the current model window's receipts (the same scope as the speed cells): reads /
 * (reads + uncached input + writes). Scoped by model because providers differ in how they cache, so a
 * session-wide rate would describe neither model after a switch.
 */
export function cacheHitRate(messages: readonly SessionMessageInfo[]) {
  const receipts = currentModelSteps(messages).flatMap((step) => (step.tokens === undefined ? [] : [step.tokens]))
  const hit = receipts.reduce((total, tokens) => total + tokens.cache.read, 0)
  const miss = receipts.reduce((total, tokens) => total + tokens.input, 0)
  const write = receipts.reduce((total, tokens) => total + tokens.cache.write, 0)
  const total = hit + miss + write
  if (total <= 0) return undefined
  return Math.round((hit * 100) / total)
}

/**
 * Rough count of the tokens the in-flight assistant step has produced so far: one token per
 * four characters (ceil) of every text and reasoning part received — the same estimate
 * codewhale's strip uses for its output count while a completion streams. Reasoning counts
 * because it occupies most of the wall time on a reasoning model. Settled steps contribute
 * nothing (their receipts are the session totals) and no step streaming means zero.
 */
export function streamingOutputEstimate(messages: readonly SessionMessageInfo[]) {
  const active = messages.findLast(
    (message): message is Step => message.type === "assistant" && message.time.completed === undefined,
  )
  if (!active) return 0
  let chars = 0
  for (const part of active.content) {
    if (part.type === "text" || part.type === "reasoning") chars += part.text.length
  }
  if (chars === 0) return 0
  return Math.floor((chars + 3) / 4)
}

/**
 * Format an output rate: one decimal below 10 tok/s, integer otherwise. Rounds exact binary ties half-to-even like
 * Rust's `{rate:.N}` (7.55 gives "7.5", 0.25 gives "0.2", 10.5 gives "10"), which `toFixed` does not: it rounds ties
 * away from zero. A tie is exactly a value whose `rate * 2^(digits+1)` is an odd integer.
 */
export function formatRate(rate: number): string {
  if (rate < 0) return `-${formatRate(-rate)}`
  const digits = rate < 10 ? 1 : 0
  const tie = rate * 2 ** (digits + 1)
  if (Number.isInteger(tie) && tie % 2 !== 0) {
    const scaled = Math.trunc(rate * 10 ** digits)
    const even = scaled % 2 === 0 ? scaled : scaled + 1
    return (even / 10 ** digits).toFixed(digits)
  }
  return rate.toFixed(digits)
}

export function formatTokenRate(rate: number) {
  return `${formatRate(rate)} tok/s`
}
