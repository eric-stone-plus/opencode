import { confirm, intro, log, multiselect, outro } from "@clack/prompts"
import { Effect } from "effect"
import type { CredentialPurgeOutput, IntegrationInfo } from "@opencode/client"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { handlePromptErrors, prompt, requireInteractive } from "../../../ui/prompt"
import { createClient, loadIntegrations, request } from "./shared"

export default Runtime.handler(
  Commands.commands.auth.commands.purge,
  Effect.fn("cli.auth.purge")(function* (input) {
    if (input.all && input.targets.length > 0)
      return yield* Effect.fail(new Error("Pass integration targets or --all, not both"))
    intro("Purge credentials")
    const client = yield* createClient({ server: input.server._tag === "Some" ? input.server.value : undefined, standalone: input.standalone })
    const candidates = (yield* loadIntegrations(client)).filter(stored)
    const named = input.all ? candidates : yield* resolve(candidates, input.targets)
    if (named.length === 0) return yield* Effect.fail(new Error("No stored credentials found"))

    const history = input.history || input.compact
    log.info(
      [
        ...named.map((item) => `${item.name} (${item.id}): ${labels(item).join(", ")}`),
        `Also: ${[input.files ? "credential files and environment" : "", history ? "session history, tool output, and logs" : ""].filter(Boolean).join("; ") || "nothing else"}`,
      ].join("\n"),
    )
    if (!input.dryRun && !input.yes) {
      yield* requireInteractive("Pass --yes to purge without an interactive terminal, or --dry-run to preview")
      const accepted = yield* prompt(() =>
        confirm({ message: "Remove these credentials and every other copy of their values?", initialValue: false }),
      )
      if (!accepted) {
        process.exitCode = 130
        outro("Cancelled")
        return
      }
    }
    const result = yield* request((signal) =>
      client.credential.purge(
        {
          ...(input.all ? { all: true } : { integrationIDs: named.map((item) => item.id) }),
          files: input.files,
          history,
          compact: input.compact,
          dryRun: input.dryRun,
        },
        { signal },
      ),
    )
    report(result)
    process.exitCode = clean(result) ? 0 : 2
    outro(process.exitCode === 0 ? "Done" : "Done, but some copies need attention")
  }, handlePromptErrors),
)

function stored(integration: IntegrationInfo) {
  return integration.connections.some((connection) => connection.type === "credential")
}

function labels(integration: IntegrationInfo) {
  return integration.connections.flatMap((connection) => (connection.type === "credential" ? [connection.label] : []))
}

// Exact ID, then exact name, then substring: `alibaba-coding-plan` stays unambiguous next to `alibaba-coding-plan-cn`.
function pick(candidates: IntegrationInfo[], target: string) {
  const needle = target.trim().toLowerCase()
  const tiers = [
    (item: IntegrationInfo) => item.id.toLowerCase() === needle,
    (item: IntegrationInfo) => item.name.toLowerCase() === needle,
    (item: IntegrationInfo) => item.id.toLowerCase().includes(needle) || item.name.toLowerCase().includes(needle),
  ]
  return needle === "" ? [] : (tiers.map((tier) => candidates.filter(tier)).find((found) => found.length > 0) ?? [])
}

const resolve = Effect.fn("cli.auth.purge.resolve")(function* (candidates: IntegrationInfo[], targets: readonly string[]) {
  if (targets.length === 0) {
    yield* requireInteractive("Name the integrations to purge, or pass --all")
    const ids = yield* prompt<string[]>(() =>
      multiselect({
        message: "Select integrations to purge",
        required: true,
        options: candidates.map((item) => ({ value: item.id, label: item.name, hint: labels(item).join(", ") })),
      }),
    )
    return candidates.filter((item) => ids.includes(item.id))
  }
  const list = candidates.map((item) => `${item.id} (${item.name})`).join(", ")
  const problems = targets.flatMap((target) => {
    const found = pick(candidates, target)
    if (found.length === 1) return []
    return [
      found.length === 0
        ? `No integration with stored credentials matches "${target}". Candidates: ${list}`
        : `"${target}" is ambiguous: ${found.map((item) => item.id).join(", ")}`,
    ]
  })
  if (problems.length > 0) return yield* Effect.fail(new Error(problems.join("\n")))
  return [...new Map(targets.flatMap((target) => pick(candidates, target)).map((item) => [item.id, item])).values()]
})

const units = {
  credential: "credential(s)",
  auth: "entr(y/ies)",
  env: "line(s)",
  "environment.d": "line(s)",
  service: "variable(s)",
  systemd: "variable(s)",
  process: "variable(s)",
  database: "row(s)",
  "tool-output": "file(s)",
  log: "file(s)",
} as const

function line(item: CredentialPurgeOutput["swept"][number], dryRun: boolean) {
  const unit = item.location.endsWith("(file)") ? "copy/copies" : units[item.kind]
  return item.error === undefined
    ? `${item.kind.padEnd(13)} ${item.location}: ${item.count} ${unit} ${dryRun ? "found" : "handled"}`
    : `${item.kind.padEnd(13)} ${item.location}: could not be processed (${item.error})`
}

function report(result: CredentialPurgeOutput) {
  log.success(
    `${result.dryRun ? "Would remove" : "Removed"} ${result.credentials.filter((item) => result.dryRun || item.removed).length} of ${result.credentials.length} credential(s); ${result.secrets.distinct} distinct value(s) searched` +
      (result.secrets.shared ? `, ${result.secrets.shared} kept because another credential uses them` : "") +
      (result.secrets.short ? `, ${result.secrets.short} too short to search` : ""),
  )
  result.credentials
    .filter((item) => !result.dryRun && !item.removed)
    .forEach((item) => log.warn(`Could not remove ${item.integrationID} (${item.label})`))
  if (result.swept.length > 0) log.info(result.swept.map((item) => line(item, result.dryRun)).join("\n"))
  if (result.compact) log.info(`database compaction: ${result.compact.status}${result.compact.reason ? ` (${result.compact.reason})` : ""}`)
  if (result.dryRun) return
  if (result.remaining.length === 0) return log.success("Verified: no copy of the removed values remains in the places checked")
  log.warn(
    ["Copies remain:", ...result.remaining.map((item) => line(item, true)), "Run the purge with --compact while no session is running to rewrite the database file."].join("\n"),
  )
}

function clean(result: CredentialPurgeOutput) {
  return (
    result.remaining.length === 0 &&
    result.swept.every((item) => item.error === undefined) &&
    result.credentials.every((item) => result.dryRun || item.removed) &&
    result.compact?.status !== "failed"
  )
}
