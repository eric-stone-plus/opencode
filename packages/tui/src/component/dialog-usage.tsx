import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, For, Show } from "solid-js"
import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { useRoute } from "../context/route"
import { useClipboard } from "../context/clipboard"
import { useToast } from "../ui/toast"
import { useBindings } from "../keymap"

export const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

// Single source of truth for the cost-estimate caveat (asserted by the dialog
// tests). Registry-matched list prices are estimates, not billed amounts.
export const USAGE_ESTIMATE_NOTE =
  "Note: zero-priced and unpriced providers (flat-rate/subscription plans) are estimated at canonical registry list prices; they are not billed per token."

// Mirrors the per-session message window hydration keeps (context/sync.tsx):
// counts derived from the loaded list can under-count once it is at the cap.
const MESSAGE_CAP = 100

// S5: the loaded-message fallback can never be complete — it sees at most
// MESSAGE_CAP recent messages and nothing from compacted-away history. Say so
// whenever it supplies totals (or the window is at its cap).
export const USAGE_FALLBACK_NOTE =
  "Note: fallback totals cover only the loaded message window (at most 100) and may under-count earlier or compacted spend."

// The compaction count has the same window hazard as cost: a long autonomous
// run compacts far more often than the 100-message hydration window holds, so a
// count derived from loaded messages under-reports. Say so when it is used.
export const USAGE_COMPACTION_FALLBACK_NOTE =
  "Note: compaction count comes from the loaded message window (at most 100); earlier compactions in this session may not be counted."

export type UsageTotals = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  sum: number
  source: "session" | "messages"
}

// S1/S3: authoritative lifetime totals live on the session row (the projector
// accumulates every step-finish and never subtracts). Tolerate partial payloads
// (cost without tokens or the reverse) instead of silently dropping to the
// loaded-message fallback, which cannot cover pre-compaction spend.
export function sessionTotals(
  info:
    | {
        cost?: number
        tokens?: {
          input: number
          output: number
          reasoning: number
          cache: { read: number; write: number }
        }
      }
    | undefined,
): UsageTotals | undefined {
  if (!info) return undefined
  const tokens = info.tokens
  const cost = info.cost
  if (!tokens && cost === undefined) return undefined
  const input = tokens?.input ?? 0
  const output = tokens?.output ?? 0
  const reasoning = tokens?.reasoning ?? 0
  const cacheRead = tokens?.cache.read ?? 0
  const cacheWrite = tokens?.cache.write ?? 0
  const value = cost ?? 0
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    cost: value,
    sum: input + output + reasoning + cacheRead + cacheWrite + value,
    source: "session" as const,
  }
}

// S3/S5: session aggregates win whenever they carry anything at all; summing
// loaded messages is a last resort for sessions whose aggregates never
// accumulated (legacy rows).
export function selectUsageTotals(input: { stored?: UsageTotals; derived: UsageTotals }): UsageTotals {
  const saved = input.stored
  if (saved && (saved.sum > 0 || input.derived.sum === 0)) return saved
  return input.derived
}

// A session's compaction count, and which source supplied it.
export type CompactionTotal = {
  count: number
  source: "session" | "messages"
}

// S1/S3 for compactions: the session aggregate the projector accumulates is the
// lifetime count and survives the hydration window and any number of
// compactions. Counting loaded compaction markers is the last resort for legacy
// rows whose aggregate predates the column; an aggregate of 0 alongside loaded
// markers means exactly that, so prefer the window count then.
export function selectCompactionTotal(input: { stored?: number; derived: number }): CompactionTotal {
  if (input.stored !== undefined && (input.stored > 0 || input.derived === 0))
    return { count: input.stored, source: "session" }
  return { count: input.derived, source: "messages" }
}

// Why a per-model breakdown can never be lifetime-accurate: only the session
// scalar cost/token aggregates are projected and persisted; nothing attributes
// spend to a model. So the split is derived from the loaded window and is
// stated as such, exactly like the totals fallback.
export const USAGE_MODEL_NOTE =
  "Note: by-model totals cover only the loaded message window; earlier or compacted spend is not attributed."

// Per-model spend, for sessions that switched models (planning on a cheap model
// and editing on an expensive one, or a subagent model). Sums step-finish
// receipts so multi-step turns count whole — `message.tokens` records the last
// step only — and pairs them with per-message cost, which already accumulates
// every step. Empty for single-model sessions, where the session row is exact.
export function modelUsageRows(input: {
  messages: readonly AssistantMessage[]
  parts: Readonly<Record<string, readonly Part[]>>
}): Array<{ label: string; value: string }> {
  const byModel = new Map<
    string,
    { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; cost: number }
  >()
  for (const message of input.messages) {
    const key = `${message.providerID}/${message.modelID}`
    const entry = byModel.get(key) ?? {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    }
    const steps = (input.parts[message.id] ?? []).filter((part) => part.type === "step-finish")
    if (steps.length > 0) {
      for (const step of steps) {
        entry.input += step.tokens.input
        entry.output += step.tokens.output
        entry.reasoning += step.tokens.reasoning
        entry.cacheRead += step.tokens.cache.read
        entry.cacheWrite += step.tokens.cache.write
      }
    } else {
      entry.input += message.tokens.input
      entry.output += message.tokens.output
      entry.reasoning += message.tokens.reasoning
      entry.cacheRead += message.tokens.cache.read
      entry.cacheWrite += message.tokens.cache.write
    }
    entry.cost += message.cost
    byModel.set(key, entry)
  }
  if (byModel.size <= 1) return []
  return [...byModel.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(([key, value]) => {
      const tokens = value.input + value.output + value.reasoning + value.cacheRead + value.cacheWrite
      return { label: key, value: `${money.format(value.cost)} · ${tokens.toLocaleString()} tokens` }
    })
}

export function usageSection(input: {
  loadedMessages: number
  userMessages: number
  assistantMessages: number
  toolCalls: number
  turns: number
  totals: UsageTotals
  compactions?: CompactionTotal
}) {
  if (input.assistantMessages === 0 && input.totals.sum <= 0) {
    return { rows: [{ label: "Usage", value: "No model calls yet in this session." }], footnotes: [] }
  }
  if (input.totals.sum <= 0) {
    return {
      rows: [{ label: "Usage", value: "None recorded, but tracking is incomplete and may under-count." }],
      footnotes: [],
    }
  }
  return {
    rows: [
      { label: "Input tokens", value: input.totals.input.toLocaleString() },
      { label: "Output tokens", value: input.totals.output.toLocaleString() },
      { label: "Reasoning tokens", value: input.totals.reasoning.toLocaleString() },
      { label: "Cache read tokens", value: input.totals.cacheRead.toLocaleString() },
      { label: "Cache write tokens", value: input.totals.cacheWrite.toLocaleString() },
      { label: "Cost", value: money.format(input.totals.cost) },
      { label: "Messages", value: `${input.userMessages} user / ${input.assistantMessages} assistant` },
      { label: "Tool calls", value: input.toolCalls.toLocaleString() },
      { label: "Turns", value: input.turns.toLocaleString() },
      ...(input.compactions ? [{ label: "Compactions", value: input.compactions.count.toLocaleString() }] : []),
    ],
    footnotes: [
      input.totals.source === "session"
        ? "Source: Totals from session aggregates."
        : `Source: Totals aggregated from ${input.loadedMessages} loaded messages.`,
      ...(input.totals.source === "messages" || input.loadedMessages >= MESSAGE_CAP ? [USAGE_FALLBACK_NOTE] : []),
      ...(input.compactions?.source === "messages" ? [USAGE_COMPACTION_FALLBACK_NOTE] : []),
      USAGE_ESTIMATE_NOTE,
    ],
  }
}

export type DialogUsageProps = {}

export function DialogUsage() {
  const sync = useSync()
  const { theme } = useTheme()
  const dialog = useDialog()
  const route = useRoute()
  const clipboard = useClipboard()
  const toast = useToast()
  const [copied, setCopied] = createSignal(false)

  dialog.setSize("large")
  // Pin the title/close row above the scrollable body so it stays visible when
  // the tall report scrolls in short landscape terminals.
  dialog.setHeader(() => (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="row" justifyContent="space-between">
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        Session Usage
      </text>
      <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
        esc
      </text>
    </box>
  ))

  const sessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))
  const session = createMemo(() => {
    const id = sessionID()
    return id ? sync.session.get(id) : undefined
  })
  const messages = createMemo(() => {
    const id = sessionID()
    return id ? (sync.data.message[id] ?? []) : []
  })
  const assistants = createMemo(() =>
    messages().filter((message): message is AssistantMessage => message.role === "assistant"),
  )

  const aggregated = createMemo(() => {
    const totals = assistants().reduce(
      (acc, message) => {
        // Sum step-finish part tokens. `message.tokens` records the LAST step
        // only (context-display semantics) and under-counts multi-step turns,
        // while `message.cost` already accumulates every step — mixing the two
        // skewed cost/token figures. Fall back to message.tokens only when no
        // step-finish parts are loaded for the message.
        let input = 0
        let output = 0
        let reasoning = 0
        let cacheRead = 0
        let cacheWrite = 0
        const steps = (sync.data.part[message.id] ?? []).filter((part) => part.type === "step-finish")
        if (steps.length > 0) {
          for (const step of steps) {
            input += step.tokens.input
            output += step.tokens.output
            reasoning += step.tokens.reasoning
            cacheRead += step.tokens.cache.read
            cacheWrite += step.tokens.cache.write
          }
        } else {
          input = message.tokens.input
          output = message.tokens.output
          reasoning = message.tokens.reasoning
          cacheRead = message.tokens.cache.read
          cacheWrite = message.tokens.cache.write
        }
        return {
          input: acc.input + input,
          output: acc.output + output,
          reasoning: acc.reasoning + reasoning,
          cacheRead: acc.cacheRead + cacheRead,
          cacheWrite: acc.cacheWrite + cacheWrite,
          cost: acc.cost + message.cost,
        }
      },
      { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    )
    return {
      ...totals,
      sum: totals.input + totals.output + totals.reasoning + totals.cacheRead + totals.cacheWrite + totals.cost,
      source: "messages" as const,
    }
  })

  const stored = createMemo(() => sessionTotals(session()))

  // Loaded compaction markers (one user-message part per auto or manual
  // compaction) — only meaningful within the hydration window.
  const loadedCompactions = createMemo(
    () =>
      messages().filter(
        (message) =>
          message.role === "user" && (sync.data.part[message.id] ?? []).some((part) => part.type === "compaction"),
      ).length,
  )

  // Lifetime compaction count the server accumulates, over the windowed count.
  const compactions = createMemo(() =>
    selectCompactionTotal({ stored: session()?.compactions, derived: loadedCompactions() }),
  )

  // Prefer the session-level aggregates the server maintains (complete
  // lifetime totals across any number of compactions); an all-zero session row
  // alongside recorded message usage means the aggregates never accumulated,
  // so fall back to summing the loaded messages (S5 last resort, footnoted).
  const totals = createMemo(() => selectUsageTotals({ stored: stored(), derived: aggregated() }))

  const context = createMemo(() => {
    const last = assistants().findLast((message) => message.tokens.output > 0)
    if (!last) return
    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    if (tokens <= 0) return
    const limit = sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID]?.limit.context
    if (!limit) {
      return [
        { label: "Context tokens", value: tokens.toLocaleString() },
        { label: "Context window", value: "window size unknown for this model" },
      ]
    }
    const pct = Math.round((tokens / limit) * 100)
    const filled = Math.min(10, Math.round(pct / 10))
    return [
      { label: "Context tokens", value: tokens.toLocaleString() },
      { label: "Context window", value: limit.toLocaleString() },
      { label: "Context used", value: `[${"█".repeat(filled)}${"░".repeat(10 - filled)}] ${pct}%` },
    ]
  })

  const usage = createMemo(() => {
    const msgs = messages()
    const parts = msgs.flatMap((message) => sync.data.part[message.id] ?? [])
    return usageSection({
      loadedMessages: msgs.length,
      userMessages: msgs.filter((message) => message.role === "user").length,
      assistantMessages: assistants().length,
      toolCalls: parts.filter((part) => part.type === "tool").length,
      turns: parts.filter((part) => part.type === "step-finish").length,
      totals: totals(),
      compactions: compactions(),
    })
  })

  const report = createMemo(() => {
    const id = sessionID()
    if (!id) {
      return [{ title: "", rows: [{ label: "Session", value: "No active session." }], footnotes: [] }]
    }
    const info = session()
    const last = assistants().at(-1)
    const agentName = info?.agent ?? last?.agent
    const providerID = info?.model?.providerID ?? last?.providerID
    const modelID = info?.model?.id ?? last?.modelID
    const variant = info?.model?.variant ?? last?.variant
    const sessionRows = !info
      ? []
      : [
          { label: "Title", value: info.title },
          { label: "Session ID", value: info.id },
          { label: "Slug", value: info.slug },
          { label: "Working directory", value: info.directory },
          ...(info.parentID ? [{ label: "Parent session", value: info.parentID }] : []),
          { label: "Created", value: new Date(info.time.created).toISOString() },
        ]
    const metaRows = [
      ...(agentName ? [{ label: "Agent", value: agentName }] : []),
      ...(providerID && modelID ? [{ label: "Model", value: `${providerID}/${modelID}` }] : []),
      ...(variant && variant !== "default" ? [{ label: "Variant", value: variant }] : []),
      ...(info ? [{ label: "Version", value: info.version }] : []),
    ]
    const used = usage()
    const windowRows = context()
    const modelRows = modelUsageRows({ messages: assistants(), parts: sync.data.part })
    return [
      ...(sessionRows.length ? [{ title: "Session", rows: sessionRows, footnotes: [] }] : []),
      ...(metaRows.length ? [{ title: "Agent & Model", rows: metaRows, footnotes: [] }] : []),
      { title: "Usage (this session)", rows: used.rows, footnotes: used.footnotes },
      ...(modelRows.length ? [{ title: "By model", rows: modelRows, footnotes: [USAGE_MODEL_NOTE] }] : []),
      ...(windowRows ? [{ title: "Context window", rows: windowRows, footnotes: [] }] : []),
    ]
  })

  // One `label: value` line per panel row so the copied block stays greppable.
  const reportText = createMemo(() =>
    report()
      .flatMap((section) => [...section.rows.map((row) => `${row.label}: ${row.value}`), ...section.footnotes])
      .join("\n"),
  )

  function copyReport() {
    void clipboard
      .write?.(reportText())
      .then(() => {
        setCopied(true)
        toast.show({ message: "Usage report copied to clipboard", variant: "info" })
      })
      .catch(toast.error)
  }

  function copySessionID() {
    const id = sessionID()
    if (!id) return
    void clipboard
      .write?.(id)
      .then(() => {
        setCopied(true)
        toast.show({ message: "Session ID copied to clipboard", variant: "info" })
      })
      .catch(toast.error)
  }

  useBindings(() => ({
    bindings: [
      {
        key: "c",
        desc: "Copy session ID",
        group: "Dialog",
        cmd: copySessionID,
      },
      {
        key: "y",
        desc: "Copy usage report",
        group: "Dialog",
        cmd: copyReport,
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      {/* No click-to-copy on values: releasing a mouse selection must trigger
          the global copy-on-select so users can copy a single value. */}
      <For each={report()}>
        {(section) => (
          <box>
            <Show when={section.title}>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                {section.title}
              </text>
            </Show>
            <For each={section.rows}>
              {(row) => (
                <box flexDirection="row" gap={1}>
                  <text flexShrink={0} fg={theme.textMuted}>
                    {row.label.padEnd(18)}
                  </text>
                  <text fg={theme.text} wrapMode="word">
                    {row.value}
                  </text>
                </box>
              )}
            </For>
            <For each={section.footnotes}>
              {(note) => (
                <text fg={theme.textMuted} wrapMode="word">
                  {note}
                </text>
              )}
            </For>
          </box>
        )}
      </For>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.textMuted}>c session id · y copy report</text>
        <text onMouseUp={copyReport}>
          <span style={{ fg: copied() ? theme.success : theme.text }}>
            <b>{copied() ? "✓ copied" : "copy"}</b>{" "}
          </span>
          <span style={{ fg: theme.textMuted }}>y</span>
        </text>
      </box>
    </box>
  )
}
