import { createSignal, Show } from "solid-js"
import type { CredentialPurgeResult } from "@opencode/client"
import { useClient } from "../context/client"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { DialogSelect } from "../ui/dialog-select"
import type { DialogContext } from "../ui/dialog"

type Choice = "purge" | "purge-history"

/** Summarizes a purge result without ever mentioning a key value: counts only. */
export function purgeSummary(result: CredentialPurgeResult) {
  const credentials = result.credentials.length
  const swept = result.swept.length
  const remaining = result.remaining.length
  return `Removed ${credentials} credential${credentials === 1 ? "" : "s"}; swept ${swept} location${
    swept === 1 ? "" : "s"
  }${remaining > 0 ? `, ${remaining} need attention` : ""}`
}

/**
 * Removes stored credentials and every other copy of their values (credential files,
 * environment files, session history and logs). Values are matched in-process by the
 * server and never printed; the result reports counts only.
 */
export function DialogPurgeKeys() {
  const client = useClient()
  const toast = useToast()
  const theme = useTheme().surface("dialog")
  const [running, setRunning] = createSignal(false)

  const purge = (history: boolean, dialog: DialogContext) => {
    if (running()) return
    setRunning(true)
    void client.api.credential
      .purge({ all: true, files: true, history })
      .then((result) => {
        dialog.clear()
        toast.show({ message: purgeSummary(result), variant: result.remaining.length > 0 ? "warning" : "info" })
      })
      .catch((error) => {
        setRunning(false)
        toast.error(error)
      })
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <DialogSelect
        title="Purge credentials"
        locked={running()}
        options={[
          {
            title: "Purge everything (also session history and logs)",
            value: "purge-history" satisfies Choice,
            description: "Scrubs stored values from session and event history too; the slowest, most thorough option",
            bg: theme.background.action.destructive.focused,
            fg: theme.text.action.destructive.focused,
            onSelect: (ctx) => purge(true, ctx),
          },
          {
            title: "Purge credentials and files",
            value: "purge" satisfies Choice,
            description: "Keeps session history untouched; use when the values never reached a prompt",
            onSelect: (ctx) => purge(false, ctx),
          },
        ]}
        footer={
          <text fg={theme.text.muted} wrapMode="word">
            Removes every stored credential and scans credential files and the environment for other copies of their
            values. Counts are reported; values are never printed.
          </text>
        }
      />
      <Show when={running()}>{
        <text fg={theme.text.feedback.warning.base}>Purging…</text>
      }</Show>
    </box>
  )
}
