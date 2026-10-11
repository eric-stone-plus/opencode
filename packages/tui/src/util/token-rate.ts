import type { Message, Part } from "@opencode-ai/sdk/v2"

/**
 * Real-time token-rate statistic for the prompt status strip: effective
 * request throughput over this loaded session's completed usage receipts,
 * ported from codewhale's `SessionMetrics::tokens_per_second`
 * (crates/tui/src/tui/session_metrics.rs) and `format_rate`
 * (crates/command-contract/src/metrics.rs).
 *
 * rate = (sum of step-finish output tokens) / (sum of measured request seconds)
 *
 * across completed assistant messages of the loaded session. This is effective
 * request throughput — it includes connection setup, time to first token, and
 * pauses within the response. It is NOT a decoder-speed measurement and NOT a
 * live text-token estimate. Tool execution time and idle time between messages
 * are excluded from the denominator. Streamed estimates never enter the
 * average: only provider-reported step-finish usage receipts count as tokens
 * (`message.tokens` records the last step only and is never used here).
 *
 * Clock source: codewhale divides by its per-request `request_ms`
 * (dispatch-to-usage-receipt). Nothing equivalent reaches the opencode client —
 * `step-finish` parts carry tokens and cost but no timestamps, and assistant
 * `time.{created,completed}` spans the whole turn including tool executions
 * (packages/schema/src/v1/session.ts). So each message's request seconds are
 * computed as (time.completed - time.created) minus the measured
 * (state.time.end - state.time.start) span of every tool state inside that
 * message — the union of those spans, since concurrently running tools occupy
 * one wall-clock window: the closest faithful mirror of codewhale's exclusions
 * the data allows. Only settled tool states (completed/error) carry a measured span; a
 * tool still running at message completion has no end to subtract, so its
 * unknown span stays in the denominator rather than being estimated. In
 * exchange the average updates per completed message rather than
 * per request, and while a request is in flight the last measured average is
 * kept — never an estimate divided by a running timer. Because the message
 * clock runs continuously, non-tool gaps inside a message (agent-loop overhead
 * between steps, retry backoff, dispatch queueing) also stay in the
 * denominator — unlike codewhale, which stops the clock between calls. For
 * multi-step messages the figure is therefore a lower bound of codewhale's
 * effective request throughput, not an equal measurement.
 *
 * Codewhale only accrues its average on calls that have BOTH a usage receipt
 * and a positive measured request duration (excluded from numerator and
 * denominator alike). Messages without any step-finish receipt are skipped for
 * the same reason: their wall time must not dilute an average whose tokens are
 * missing (e.g. parts not yet hydrated).
 *
 * When a provider never reports usage, or no receipts have arrived yet, the
 * rate is undefined and the strip cell is omitted — nothing is estimated.
 */
export function tokensPerSecond(
  messages: readonly Message[],
  parts: Readonly<Record<string, readonly Part[]>>,
): number | undefined {
  let outputTokens = 0
  let millis = 0
  for (const message of messages) {
    if (message.role !== "assistant") continue
    const completed = message.time.completed
    if (completed === undefined) continue
    const steps = parts[message.id]
    if (!steps) continue
    let receipts = 0
    let output = 0
    const spans: Array<[number, number]> = []
    for (const part of steps) {
      if (part.type === "step-finish") {
        receipts += 1
        output += part.tokens.output
        continue
      }
      if (part.type === "tool") {
        const state = part.state
        if (state.status === "completed" || state.status === "error") {
          const span = Math.max(0, state.time.end - state.time.start)
          if (span > 0) spans.push([state.time.start, state.time.start + span])
        }
      }
    }
    if (receipts === 0) continue
    spans.sort((a, b) => a[0] - b[0])
    let toolMillis = 0
    let coverStart = 0
    let coverEnd = 0
    let covering = false
    for (const [start, end] of spans) {
      if (!covering || start > coverEnd) {
        if (covering) toolMillis += coverEnd - coverStart
        coverStart = start
        coverEnd = end
        covering = true
      } else if (end > coverEnd) {
        coverEnd = end
      }
    }
    if (covering) toolMillis += coverEnd - coverStart
    const llm = completed - message.time.created - toolMillis
    if (!Number.isFinite(llm) || llm <= 0) continue
    outputTokens += output
    millis += llm
  }
  if (!Number.isFinite(outputTokens) || !Number.isFinite(millis) || outputTokens <= 0 || millis <= 0) return undefined
  return outputTokens / (millis / 1000)
}

/**
 * Format an output rate like codewhale's `format_rate`: one decimal below
 * 10 tok/s, integer otherwise. Rust `{rate:.N}` rounds the exact binary value
 * half-to-even (verified against rustc: 7.55 → "7.5", 0.25 → "0.2",
 * 1.25 → "1.2", 10.5 → "10"); JS `toFixed` rounds the same exact value but
 * ties away from zero, so exact decimal ties are re-rounded to even here to
 * match the reference bit for bit. Ties are exactly the values
 * `rate * 2^(digits+1)` that are odd integers (rate = odd / 2^(digits+1)).
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

/** The rate cell as rendered in the strip; the label carries `tok/s`. */
export function formatTokenRate(rate: number): string {
  return `${formatRate(rate)} tok/s`
}

/** Join the usage strip cells, omitting any that are unavailable. */
export function usageStrip(cells: { context?: string; cost?: string; rate?: string }): string {
  return [cells.context, cells.cost, cells.rate].filter(Boolean).join(" · ")
}
