import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, For, Show } from "solid-js"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { useRoute } from "../context/route"
import { useClipboard } from "../context/clipboard"
import { useToast } from "../ui/toast"
import { useBindings } from "../keymap"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

// Mirrors the per-session message window hydration keeps (context/sync.tsx):
// counts derived from the loaded list can under-count once it is at the cap.
const MESSAGE_CAP = 100

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
      (acc, message) => ({
        input: acc.input + message.tokens.input,
        output: acc.output + message.tokens.output,
        reasoning: acc.reasoning + message.tokens.reasoning,
        cacheRead: acc.cacheRead + message.tokens.cache.read,
        cacheWrite: acc.cacheWrite + message.tokens.cache.write,
        cost: acc.cost + message.cost,
      }),
      { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    )
    return {
      ...totals,
      sum: totals.input + totals.output + totals.reasoning + totals.cacheRead + totals.cacheWrite + totals.cost,
      source: "messages" as const,
    }
  })

  const stored = createMemo(() => {
    const info = session()
    if (!info?.tokens || info.cost === undefined) return
    const tokens = info.tokens
    return {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cacheRead: tokens.cache.read,
      cacheWrite: tokens.cache.write,
      cost: info.cost,
      sum: tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write + info.cost,
      source: "session" as const,
    }
  })

  // Prefer the session-level aggregates the server maintains; an all-zero
  // session row alongside recorded message usage means the aggregates never
  // accumulated, so fall back to summing the loaded messages.
  const totals = createMemo(() => {
    const saved = stored()
    const derived = aggregated()
    if (saved && (saved.sum > 0 || derived.sum === 0)) return saved
    return derived
  })

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
    const assts = assistants()
    const sum = totals()
    if (assts.length === 0 && sum.sum <= 0) {
      return { rows: [{ label: "Usage", value: "No model calls yet in this session." }], footnotes: [] }
    }
    if (sum.sum <= 0) {
      return {
        rows: [{ label: "Usage", value: "None recorded, but tracking is incomplete and may under-count." }],
        footnotes: [],
      }
    }
    const parts = msgs.flatMap((message) => sync.data.part[message.id] ?? [])
    return {
      rows: [
        { label: "Input tokens", value: sum.input.toLocaleString() },
        { label: "Output tokens", value: sum.output.toLocaleString() },
        { label: "Reasoning tokens", value: sum.reasoning.toLocaleString() },
        { label: "Cache read tokens", value: sum.cacheRead.toLocaleString() },
        { label: "Cache write tokens", value: sum.cacheWrite.toLocaleString() },
        { label: "Cost", value: money.format(sum.cost) },
        {
          label: "Messages",
          value: `${msgs.filter((message) => message.role === "user").length} user / ${assts.length} assistant`,
        },
        { label: "Tool calls", value: parts.filter((part) => part.type === "tool").length.toLocaleString() },
        { label: "Turns", value: parts.filter((part) => part.type === "step-finish").length.toLocaleString() },
      ],
      footnotes: [
        sum.source === "session"
          ? "Source: Totals from session aggregates."
          : `Source: Totals aggregated from ${msgs.length} loaded messages.`,
        ...(sum.source === "messages" || msgs.length >= MESSAGE_CAP
          ? ["Note: usage is incomplete and may under-count."]
          : []),
      ],
    }
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
    return [
      ...(sessionRows.length ? [{ title: "Session", rows: sessionRows, footnotes: [] }] : []),
      ...(metaRows.length ? [{ title: "Agent & Model", rows: metaRows, footnotes: [] }] : []),
      { title: "Usage (this session)", rows: used.rows, footnotes: used.footnotes },
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
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Session Usage
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
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
            <For each={section.footnotes}>{(note) => <text fg={theme.textMuted} wrapMode="word">{note}</text>}</For>
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
