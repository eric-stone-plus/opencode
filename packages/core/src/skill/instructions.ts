export * as SkillInstructions from "./instructions.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Permission } from "../permission.js"
import { Skill } from "../skill.js"
import { Instructions } from "../instructions/index.js"

const Summary = Schema.Struct({
  id: Skill.ID,
  name: Skill.Name,
  description: Schema.String,
})
type Summary = typeof Summary.Type

/**
 * The skill index is a fixed cost in every request that lists skills, and it grows with every skill
 * root the seat has - global, project, plugin. Nothing bounded it before (borrow C35, reduced to the
 * budget half): this is the fork's own ceiling, chosen so a seat with every root populated still
 * spends a small fraction of a large window on discovery.
 *
 * Over budget, detail degrades before discoverability does: entries keep their id and name, so a skill
 * is never hidden from the model, and the note says how many descriptions were left out. A listing
 * that cannot fit even that stops and says how many were dropped, rather than silently truncating.
 */
export const INDEX_BUDGET = 12_000
/** Space held back for the notes below, so a listing that fits the budget stays inside it. */
const NOTE_RESERVE = 256

const entry = (skill: Summary, detail: boolean) =>
  detail
    ? [
        "  <skill>",
        `    <id>${skill.id}</id>`,
        `    <name>${skill.name}</name>`,
        `    <description>${skill.description}</description>`,
        "  </skill>",
      ]
    : ["  <skill>", `    <id>${skill.id}</id>`, `    <name>${skill.name}</name>`, "  </skill>"]

const entries = (skills: ReadonlyArray<Summary>) => skills.flatMap((skill) => entry(skill, true))

const listing = (skills: ReadonlyArray<Summary>, budget: number) => {
  const open = "<available_skills>"
  const close = "</available_skills>"
  const size = (lines: ReadonlyArray<string>) => Buffer.byteLength([open, ...lines, close].join("\n"))
  const terse = skills.flatMap((skill) => entry(skill, false))
  // Every id and name fits, so the budget is spent on descriptions instead, from the front: a skill
  // is never hidden to make room for another skill's detail.
  if (size(terse) <= budget) {
    const lines: Array<string> = []
    let detailed = 0
    for (const skill of skills) {
      // The whole body has to fit, tail included: spending the budget on early detail and then
      // appending the rest anyway is what a naive walk does, and it is how a budget silently breaks.
      const candidate = [
        ...lines,
        ...entry(skill, true),
        ...skills.slice(detailed + 1).flatMap((rest) => entry(rest, false)),
      ]
      if (size(candidate) > budget) break
      lines.push(...entry(skill, true))
      detailed++
    }
    return {
      body: [open, ...lines, ...skills.slice(detailed).flatMap((skill) => entry(skill, false)), close].join("\n"),
      terse: skills.length - detailed,
      dropped: 0,
    }
  }
  // Even ids and names do not fit: list what does and account for the rest in the note.
  const lines: Array<string> = []
  for (const skill of skills) {
    const candidate = [...lines, ...entry(skill, false)]
    if (size(candidate) > budget) break
    lines.push(...entry(skill, false))
  }
  return {
    body: [open, ...lines, close].join("\n"),
    terse: lines.length / 4,
    dropped: skills.length - lines.length / 4,
  }
}

const PREAMBLE = [
  "Skills provide specialized instructions and workflows for specific tasks.",
  "Use the skill tool to load a skill when a task matches its description.",
  "The user may also invoke a skill directly. When that happens, its instructions appear in the conversation as a <skill_content> block, the same shape the skill tool returns. A skill that is already present this way does not need to be invoked again.",
]

const render = (skills: ReadonlyArray<Summary>) => {
  if (skills.length === 0) return [...PREAMBLE, "No skills are currently available."].join("\n")
  // The budget covers the whole rendered text, preamble included; the reserve pays for the notes.
  const fixed = Buffer.byteLength(PREAMBLE.join("\n")) + 1 + NOTE_RESERVE
  const { body, terse, dropped } = listing(skills, INDEX_BUDGET - fixed)
  return [
    ...PREAMBLE,
    body,
    ...(terse === 0
      ? []
      : [`Descriptions are omitted for ${terse} of these skills to stay within the index budget; load one by id to read it.`]),
    ...(dropped === 0 ? [] : [`${dropped} further skills are not listed here: the index budget is spent.`]),
  ].join("\n")
}

const update = (previous: ReadonlyArray<Summary>, current: ReadonlyArray<Summary>) => {
  const diff = Instructions.diffByKey(
    previous,
    current,
    (skill) => skill.id,
    (before, after) => before.name !== after.name || before.description !== after.description,
  )
  // Additions and removals render as small deltas; anything else restates the full list.
  if (diff.changed.length > 0 || (diff.added.length === 0 && diff.removed.length === 0))
    return [
      "The available skills have changed. This list supersedes the previous available skills list.",
      render(current),
    ].join("\n")
  return [
    ...(diff.added.length === 0
      ? []
      : ["New skills are available in addition to those previously listed:", ...entries(diff.added)]),
    ...(diff.removed.length === 0
      ? []
      : [
          `The following skill IDs are no longer available and must not be used: ${diff.removed.map((skill) => skill.id).join(", ")}.`,
        ]),
  ].join("\n")
}

export interface Interface {
  /** Lists skills the given ruleset does not deny; callers pass the merged agent and Session permissions. */
  readonly load: (permissions: Permission.Ruleset) => Effect.Effect<Instructions.List>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillInstructions") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skills = yield* Skill.Service

    return Service.of({
      load: Effect.fn("SkillInstructions.load")(function* (permissions) {
        const available = Skill.available(yield* skills.list(), permissions)
          .flatMap((skill) =>
            skill.description === undefined || skill.autoinvoke === false
              ? []
              : [{ id: skill.id, name: skill.name, description: skill.description }],
          )
          .toSorted((a, b) => a.id.localeCompare(b.id))
        return Instructions.make<ReadonlyArray<Summary>>({
          key: Instructions.Key.make("core/skill-guidance"),
          codec: Schema.toCodecJson(Schema.Array(Summary)),
          read: Effect.succeed(available.length === 0 ? Instructions.removed : available),
          render: {
            initial: render,
            changed: update,
            removed: () => "Skill guidance is no longer available. Do not use any previously listed skill.",
          },
        })
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Skill.node] })
