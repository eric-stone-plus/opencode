import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"

type Step = SessionMessageAssistant

const steps = (messages: readonly SessionMessageInfo[]) =>
  messages.filter((message): message is Step => message.type === "assistant")

/**
 * Session token throughput for the prompt status strip: the output and reasoning tokens of every settled model call
 * in the loaded history, divided by the time those calls spent talking to the provider.
 *
 * Reasoning counts because providers that report it apart from the visible output (DeepSeek) spend most of the wall
 * time on it. The clock is `time.created` (request dispatch) to `time.streamed` (provider response body ended), so
 * tool execution never enters the denominator, and a step still streaming has no `streamed` yet and contributes
 * nothing: the average holds its last value while a request is in flight.
 *
 * This is effective throughput, including time to first token and pauses inside a response, not decoder speed. It is
 * undefined until a step has both usage and a positive duration, and nothing is estimated.
 */
export function tokensPerSecond(messages: readonly SessionMessageInfo[]) {
  const settled = steps(messages).flatMap((step) => {
    if (step.time.streamed === undefined || step.tokens === undefined) return []
    const millis = step.time.streamed - step.time.created
    if (!Number.isFinite(millis) || millis <= 0) return []
    return [{ tokens: step.tokens.output + step.tokens.reasoning, millis }]
  })
  const tokens = settled.reduce((total, step) => total + step.tokens, 0)
  const millis = settled.reduce((total, step) => total + step.millis, 0)
  if (tokens <= 0 || millis <= 0) return undefined
  return tokens / (millis / 1000)
}

/**
 * Mean time from dispatching a model call to its first reasoning output, over settled calls.
 *
 * V2 stamps every step with its own dispatch time, so each call is a clean sample and no later call has to be
 * dropped for being timed from the start of the reply. Only reasoning parts carry a start time (text parts have none),
 * so a call that opens with text or a tool call is untimed and never dilutes the average.
 */
export function timeToFirstToken(messages: readonly SessionMessageInfo[]) {
  const samples = steps(messages).flatMap((step) => {
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
