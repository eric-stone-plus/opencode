import type { Argv } from "yargs"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Pricing } from "@opencode-ai/core/pricing"
import { PricingBackfill } from "@opencode-ai/core/pricing/backfill"
import { effectCmd, fail } from "../effect-cmd"

const ESTIMATE_LABEL = "estimated at registry list prices (flat-rate plans are not billed per token)"

/** Backfill report lines; kept pure so wording is testable. */
export function renderBackfill(input: { summary: PricingBackfill.Summary; apply: boolean; path: string }): string[] {
  const lines: string[] = []
  if (!input.apply)
    lines.push(
      `dry run — no database rows written; the model price cache may be refreshed (OPENCODE_DISABLE_MODELS_FETCH=1 for offline); use --apply to write to ${input.path}`,
    )
  if (input.summary.models.length > 0) lines.push(`model prices ${ESTIMATE_LABEL}:`)
  for (const model of input.summary.models) {
    const rate = model.match.cost
    lines.push(
      `${model.providerID}/${model.modelID}  match=${model.match.source}  ` +
        `input=$${rate.input} output=$${rate.output} cache_read=$${rate.cache_read ?? 0} cache_write=$${rate.cache_write ?? 0}`,
    )
    lines.push(`  messages=${model.messages} parts=${model.parts} sessions=${model.sessions} delta=$${model.delta}`)
  }
  for (const item of input.summary.unpriced) lines.push(`${item.providerID}/${item.modelID}  unpriced`)
  for (const id of input.summary.failed) lines.push(`failed session: ${id}`)
  lines.push(
    `total: messages=${input.summary.messages} parts=${input.summary.parts} sessions=${input.summary.sessions} ` +
      `delta=$${input.summary.delta} (${ESTIMATE_LABEL})`,
  )
  if (input.apply)
    lines.push(
      `wrote re-priced costs: messages=${input.summary.messages} parts=${input.summary.parts} sessions=${input.summary.sessions} to ${input.path}`,
    )
  return lines
}

const BackfillCommand = effectCmd({
  command: "backfill",
  describe: "re-price historical usage costs (dry run unless --apply)",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .option("apply", {
        type: "boolean",
        default: false,
        describe: "write the re-priced costs to the database",
      })
      .epilogue(
        "costs are estimated at registry list prices (flat-rate plans are not billed per token); " +
          "model price cache refreshes can be suppressed with OPENCODE_DISABLE_MODELS_FETCH=1 for offline runs",
      )
  },
  handler: Effect.fn("Cli.usage.backfill")(function* (args: { apply: boolean }) {
    const { db } = yield* Database.Service
    const pricing = yield* Pricing.Service
    const summary = yield* PricingBackfill.run({ db, resolve: pricing.resolve, apply: args.apply })
    for (const line of renderBackfill({ summary, apply: args.apply, path: Database.path() })) console.log(line)
    if (args.apply && summary.failed.length > 0)
      return yield* fail(`usage backfill failed for ${summary.failed.length} session(s)`)
  }),
})

export const UsageCommand = effectCmd({
  command: "usage",
  describe: "usage cost tools",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs.command(BackfillCommand).demandCommand()
  },
  handler: Effect.fn("Cli.usage")(function* () {}),
})
