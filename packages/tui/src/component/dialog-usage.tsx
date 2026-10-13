import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { For, Show, createMemo, createResource, createSignal } from "solid-js"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { useClipboard } from "../context/clipboard"
import { useToast } from "../ui/toast"
import { Keymap } from "../context/keymap"
import { useConfig } from "../config"
import { getScrollAcceleration } from "../util/scroll"
import { errorMessage } from "../util/error"
import { COMPACTION_PAGE, contextUsage, countCompactions } from "../util/session"
import { Spinner } from "./spinner"
import {
  USAGE_ESTIMATE_NOTE,
  USAGE_SOURCE_NOTE,
  contextWindowRows,
  usageActivity,
  usageModels,
  usageTotals,
  zeroCostNote,
  type UsageRow,
} from "../util/usage"

type Section = { readonly title?: string; readonly rows: UsageRow[]; readonly continuous?: boolean }

/**
 * Session usage report, laid out as labelled sections over `session.stats` — recorded step
 * usage read from the database (lifetime, session + subagent tree), never the loaded message
 * window. The body scrolls; the header and the copy row stay pinned.
 */
export function DialogUsage(props: { sessionID: string }) {
  const client = useClient()
  const data = useData()
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const clipboard = useClipboard()
  const toast = useToast()
  const dimensions = useTerminalDimensions()
  const config = useConfig().data
  const [copied, setCopied] = createSignal(false)
  let scroll: ScrollBoxRenderable | undefined

  dialog.setSize("large")
  // V2's Dialog defaults to a fixed height/4 offset; a report reads centred, and the
  // scrollbox below keeps the body reachable when the viewport is short (landscape).
  dialog.setCentered(true)

  const [stats] = createResource(() => props.sessionID, (sessionID) =>
    client.api.session.stats({ session: sessionID, tools: "summary" }),
  )
  // The Context window section counts this session's own compactions, so the count comes
  // from the session's own compaction messages; `stats.compactions` sums the whole subagent
  // tree instead (a subagent compacts its own window).
  const [compactions] = createResource(() => props.sessionID, (sessionID) =>
    countCompactions(async (cursor) => {
      const response = await client.api.message.list({
        sessionID,
        type: "compaction",
        limit: COMPACTION_PAGE,
        ...(cursor === undefined ? { order: "desc" as const } : { cursor }),
      })
      return response
    }),
  )
  const session = createMemo(() => data.session.get(props.sessionID))
  const messages = createMemo(() => data.session.message.list(props.sessionID))
  const context = createMemo(() => {
    const info = session()
    if (!info) return undefined
    return contextUsage(messages(), data.location.model.list(info.location), info.revert?.messageID)
  })

  const sections = createMemo<Section[]>(() => {
    const value = stats()
    if (!value) return []
    const info = session()
    const meta: UsageRow[] = []
    if (info) {
      if (info.title) meta.push({ label: "Title", value: info.title })
      meta.push({ label: "Session ID", value: info.id })
      meta.push({ label: "Working directory", value: info.location.directory })
      meta.push({ label: "Created", value: new Date(info.time.created).toISOString() })
      if (info.agent) meta.push({ label: "Agent", value: info.agent })
      if (info.model) meta.push({ label: "Model", value: `${info.model.providerID}/${info.model.id}` })
      if (info.parentID) meta.push({ label: "Parent session", value: info.parentID })
    }
    const window = contextWindowRows(context(), compactions())
    return [
      ...(meta.length ? [{ title: "Session", rows: meta }] : []),
      { title: "Usage (this session)", rows: [...usageTotals(value), ...usageActivity(value)] },
      ...(value.models.length > 1 ? [{ title: "By model", rows: usageModels(value), continuous: true }] : []),
      ...(window.length ? [{ title: "Context window", rows: window }] : []),
    ]
  })

  const notes = createMemo(() => {
    const value = stats()
    if (!value) return []
    const zero = zeroCostNote(value)
    return [USAGE_SOURCE_NOTE, ...(zero ? [zero] : []), USAGE_ESTIMATE_NOTE]
  })

  // One `label: value` line per row so the copied block stays greppable.
  const reportText = createMemo(() =>
    [
      ...sections().flatMap((section) => [
        ...(section.title ? [`${section.title}:`] : []),
        ...section.rows.map((row) => `${row.label}: ${row.value}`),
      ]),
      ...notes(),
    ].join("\n"),
  )

  const copySessionID = () => {
    void clipboard
      .write(props.sessionID)
      .then(() => {
        setCopied(true)
        toast.show({ message: "Session ID copied to clipboard", variant: "info" })
      })
      .catch(toast.error)
  }

  const copyReport = () => {
    void clipboard
      .write(reportText())
      .then(() => {
        setCopied(true)
        toast.show({ message: "Usage report copied to clipboard", variant: "info" })
      })
      .catch(toast.error)
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { bind: "c", title: "Copy session ID", group: "Dialog", run: copySessionID },
      { bind: "y", title: "Copy usage report", group: "Dialog", run: copyReport },
    ],
  }))

  useKeyboard((event) => {
    if (event.name === "up") return scroll?.scrollBy(-1)
    if (event.name === "down") return scroll?.scrollBy(1)
    if (event.name === "pageup") return scroll?.scrollBy(-20)
    if (event.name === "pagedown") return scroll?.scrollBy(20)
    if (event.name === "home") return scroll?.scrollTo(0)
    if (event.name === "end" && scroll) return scroll.scrollTo(scroll.scrollHeight)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
          Session Usage
        </text>
        <text fg={theme.text.muted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show when={stats.error}>
        {(error) => (
          <text fg={theme.text.base} wrapMode="word">
            Usage unavailable: {errorMessage(error())}
          </text>
        )}
      </Show>
      <Show when={!stats.error}>
        <Show when={stats()} fallback={<Spinner color={theme.text.muted}>Loading usage…</Spinner>}>
          <scrollbox
            id="usage-scroll"
            ref={(element: ScrollBoxRenderable) => (scroll = element)}
            maxHeight={Math.max(6, Math.floor(dimensions().height * 0.7) - 6)}
            contentOptions={{ minHeight: 0 }}
            scrollbarOptions={{ visible: false }}
            scrollAcceleration={getScrollAcceleration(config)}
          >
            <box gap={1}>
              <For each={sections()}>
                {(section) => (
                  <box>
                    <Show when={section.title}>
                      <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
                        {section.title}
                      </text>
                    </Show>
                    <For each={section.rows}>
                      {(row) =>
                        section.continuous ? (
                          <text wrapMode="word">
                            <span style={{ fg: theme.text.base }}>{row.label}</span>{" "}
                            <span style={{ fg: theme.text.muted }}>{row.value}</span>
                          </text>
                        ) : (
                          <box flexDirection="row" gap={1}>
                            <text flexShrink={0} fg={theme.text.muted}>
                              {row.label.padEnd(18)}
                            </text>
                            <text fg={theme.text.base} wrapMode="word">
                              {row.value}
                            </text>
                          </box>
                        )
                      }
                    </For>
                  </box>
                )}
              </For>
              <For each={notes()}>
                {(note) => (
                  <text fg={theme.text.muted} wrapMode="word">
                    {note}
                  </text>
                )}
              </For>
            </box>
          </scrollbox>
        </Show>
      </Show>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text.muted}>c session id · y copy report · ↑/↓ scroll</text>
        <text onMouseUp={copyReport}>
          <span style={{ fg: copied() ? theme.text.feedback.success.base : theme.text.base }}>
            <b>{copied() ? "✓ copied" : "copy"}</b>{" "}
          </span>
          <span style={{ fg: theme.text.muted }}>y</span>
        </text>
      </box>
    </box>
  )
}
