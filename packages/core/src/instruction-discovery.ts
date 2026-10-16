export * as InstructionDiscovery from "./instruction-discovery.js"

import { Context, Effect, Layer, Option, Schema, Types } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { createPatch } from "diff"
import { Bus } from "./bus.js"
import { Escape } from "./fork/escape.js"
import { ProjectTrust } from "./fork/project-trust.js"
import { Instructions } from "./instructions/index.js"
import { State } from "./state.js"

export class File extends Schema.Class<File>("InstructionDiscovery.File")({
  // An absolute file path, or the URL of a configured remote instruction.
  path: Schema.String,
  content: Schema.String,
}) {}

const Files = Schema.Array(File)
const key = Instructions.Key.make("core/instructions")

export const Event = {
  Updated: Bus.ephemeral({ type: "instruction-discovery.updated", schema: {} }),
}

export type Data = {
  files: Map<string, Types.DeepMutable<File>>
  available: boolean
}

export type Editor = {
  list: () => readonly Types.DeepMutable<File>[]
  // Map insertion order is render order: config adds global then nearest-to-farthest project files;
  // sibling contributors interleave by transform registration order.
  add: (file: File) => void
  update: (path: string, update: (file: Types.DeepMutable<File>) => void) => void
  remove: (path: string) => void
  unavailable: () => void
}

export interface Interface extends State.Transformable<Editor> {
  // Discovery policy lives here because internal plugins have no per-composition options channel.
  // Move it into plugin config once plugins can consume their own options.
  readonly project: boolean
  readonly global: boolean
  // The operator's trust declaration, exposed per directory so consumers can ask
  // `trust.allows(path)` instead of relying on the coarse `project` boolean.
  readonly trust: ProjectTrust.Interface
  readonly list: () => Effect.Effect<File[] | Instructions.Unavailable>
  readonly load: () => Effect.Effect<Instructions.List>
}

export const Options = Schema.Struct({
  project: Schema.optional(Schema.Boolean),
  global: Schema.optional(Schema.Boolean),
})
export type Options = typeof Options.Type

export class Service extends Context.Service<Service, Interface>()("@opencode/InstructionDiscovery") {}

export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const state = State.create<Data, Editor>({
        name: "instruction-discovery",
        initial: () => ({ files: new Map(), available: true }),
        editor: (editor) => ({
          list: () => Array.from(editor.files.values()),
          add: (file) => editor.files.set(file.path, new File(file) as Types.DeepMutable<File>),
          update: (path, update) => {
            const current = editor.files.get(path)
            if (!current) return
            update(current)
            current.path = path
          },
          remove: (path) => editor.files.delete(path),
          unavailable: () => {
            editor.available = false
          },
        }),
        notify: () => bus.publish(Event.Updated, {}).pipe(Effect.asVoid),
      })

      const source = (value: ReadonlyArray<File> | Instructions.Unavailable | Instructions.Removed) =>
        Instructions.make<ReadonlyArray<File>>({
          key,
          codec: Schema.toCodecJson(Files),
          read: Effect.succeed(value),
          render: {
            initial: render,
            changed: renderUpdate,
            removed: () => "Previously loaded instructions no longer apply.",
          },
        })

      const list = Effect.fn("InstructionDiscovery.list")(function* () {
        const current = state.get()
        if (!current.available) return Instructions.unavailable
        return Array.from(current.files.values())
      })

      // The coarse `project: false` escape forces everything closed; otherwise an absent
      // ProjectTrust service is closed too, so only a real declaration trusts a directory.
      const trust =
        options?.project === false
          ? ProjectTrust.make()
          : Option.getOrElse(yield* Effect.serviceOption(ProjectTrust.Service), () => ProjectTrust.make())

      return Service.of({
        project: options?.project !== false,
        global: options?.global !== false,
        trust,
        transform: state.transform,
        reload: state.reload,
        list,
        load: Effect.fn("InstructionDiscovery.load")(function* () {
          const files = yield* list()
          if (!Array.isArray(files)) return source(files)
          return source(files.length === 0 ? Instructions.removed : files)
        }),
      })
    }),
  )

export function configured(options?: Options) {
  return makeLocationNode({
    service: Service,
    layer: layer(options),
    // The trust declaration is a host-global dependency, so a replacement node can carry the
    // operator's roots into this layer without touching every consumer.
    deps: [Bus.node, ProjectTrust.node],
  })
}

export const node = configured()

// Paths come from config (a project can name arbitrary files and remote URLs) and from filesystem
// names, so each path is single-line text-escaped: it must not forge another narrated line or close
// a surrounding block. The content is the instruction text by design and stays raw.
function render(files: ReadonlyArray<File>) {
  return files.map((file) => `Instructions from: ${Escape.escapeLine(file.path)}\n${file.content}`).join("\n\n")
}

function renderUpdate(previous: ReadonlyArray<File>, current: ReadonlyArray<File>) {
  const changes = Instructions.diffByKey(
    previous,
    current,
    (file) => file.path,
    (before, after) => before.content !== after.content,
  )
  return [
    ...changes.removed.map((file) => `The instructions from ${Escape.escapeLine(file.path)} no longer apply.`),
    ...changes.added.map((file) => `New instructions apply from:\n${render([file])}`),
    ...changes.changed.map(({ previous: before, current: after }) => {
      const path = Escape.escapeLine(after.path)
      // The escaped path also enters the patch: a path containing `@@` makes the hunk search land
      // inside the header, which would otherwise leak the raw path into the visible diff.
      const patch = createPatch(path, before.content, after.content, "", "", { context: 3 })
      const diff = [
        `The instructions from ${path} changed. Here's the diff:`,
        "```diff",
        patch.slice(patch.indexOf("@@")).trimEnd(),
        "```",
      ].join("\n")
      const replacement = `The instructions changed:\n${render([after])}`
      return diff.length < replacement.length ? diff : replacement
    }),
  ].join("\n\n")
}
