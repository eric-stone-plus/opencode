// Model variant resolution and persistence.
//
// Variants are provider-specific reasoning effort levels (e.g., "high", "max").
// Resolution priority: CLI --variant flag > saved preference > session history.
//
// The saved variant persists across sessions in ~/.local/state/opencode/model.json
// so your last-used variant sticks. Cycling (ctrl+t) updates both the active
// variant and the persisted file.
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Context, Effect, Layer } from "effect"
import { makeRuntime } from "@/effect/run-service"
import { Global } from "@opencode-ai/core/global"
import { isRecord } from "@/util/record"
import { createSession, sessionVariant, type RunSession, type SessionMessages } from "./session.shared"
import type { RunInput, RunProvider } from "./types"

const MODEL_FILE = path.join(Global.Path.state, "model.json")

// The scope key of the composer default, shared with the TUI's
// DRAFT_MODEL_SCOPE (packages/tui/src/context/local.tsx). Variants persist per
// session; this bucket is the one `opencode run`'s single composer uses and
// the one a newly created session inherits.
const DRAFT_SCOPE = ""

type ModelState = Record<string, unknown> & {
  variant?: Record<string, Record<string, string | undefined>>
}
type VariantService = {
  readonly resolveSavedVariant: (model: RunInput["model"]) => Effect.Effect<string | undefined>
  readonly saveVariant: (model: RunInput["model"], variant: string | undefined) => Effect.Effect<void>
}
type VariantRuntime = {
  resolveSavedVariant(model: RunInput["model"]): Promise<string | undefined>
  saveVariant(model: RunInput["model"], variant: string | undefined): Promise<void>
}

class Service extends Context.Service<Service, VariantService>()("@opencode/RunVariant") {}

function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

function variantKey(model: NonNullable<RunInput["model"]>): string {
  return modelKey(model.providerID, model.modelID)
}

export function modelInfo(providers: RunProvider[] | undefined, model: NonNullable<RunInput["model"]>) {
  const provider = providers?.find((item) => item.id === model.providerID)
  return {
    provider: provider?.name ?? model.providerID,
    model: provider?.models[model.modelID]?.name ?? model.modelID,
  }
}

export function formatModelLabel(
  model: NonNullable<RunInput["model"]>,
  variant: string | undefined,
  providers?: RunProvider[],
): string {
  const names = modelInfo(providers, model)
  const label = variant ? ` · ${variant}` : ""
  return `${names.model} · ${names.provider}${label}`
}

export function cycleVariant(current: string | undefined, variants: string[]): string | undefined {
  if (variants.length === 0) {
    return undefined
  }

  if (!current) {
    return variants[0]
  }

  const idx = variants.indexOf(current)
  if (idx === -1 || idx === variants.length - 1) {
    return undefined
  }

  return variants[idx + 1]
}

export function pickVariant(model: RunInput["model"], input: RunSession | SessionMessages): string | undefined {
  return sessionVariant(Array.isArray(input) ? createSession(input) : input, model)
}

function fitVariant(value: string | undefined, variants: string[]): string | undefined {
  if (!value) {
    return undefined
  }

  if (variants.length === 0 || variants.includes(value)) {
    return value
  }

  return undefined
}

// Picks the active variant. CLI flag wins, then saved preference, then session
// history. fitVariant() checks saved and session values against the available
// variants list -- if the provider doesn't offer a variant, it drops.
export function resolveVariant(
  input: string | undefined,
  session: string | undefined,
  saved: string | undefined,
  variants: string[],
): string | undefined {
  if (input !== undefined) {
    return input
  }

  const fallback = fitVariant(saved, variants)
  const current = fitVariant(session, variants)
  if (current !== undefined) {
    return current
  }

  return fallback
}

function state(value: unknown): ModelState {
  if (!isRecord(value)) {
    return {}
  }

  return {
    ...value,
    variant: normalizeVariant(value.variant),
  }
}

// The on-disk store predates session scoping: a flat `provider/model -> variant`
// map migrates into the draft bucket, which is the composer it came from.
// Bucket contents merge so the result does not depend on JSON key order (a
// file can contain both shapes after a mixed-version run); non-string leaves
// are dropped so a malformed entry cannot survive a rewrite. Keys that could
// reach Object.prototype are ignored.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])

function normalizeVariant(value: unknown): Record<string, Record<string, string>> | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const result: Record<string, Record<string, string>> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) {
      continue
    }
    if (typeof entry === "string") {
      result[DRAFT_SCOPE] = { ...(result[DRAFT_SCOPE] ?? {}), [key]: entry }
      continue
    }
    if (!isRecord(entry)) {
      continue
    }
    const bucket = Object.fromEntries(Object.entries(entry).filter(([, item]) => typeof item === "string")) as Record<
      string,
      string
    >
    if (Object.keys(bucket).length > 0) {
      result[key] = { ...(result[key] ?? {}), ...bucket }
    }
  }
  return result
}

function createLayer(fs = AppNodeBuilder.build(FSUtil.node)) {
  return Layer.fresh(
    Layer.effect(
      Service,
      Effect.gen(function* () {
        const file = yield* FSUtil.Service

        const read = Effect.fn("RunVariant.read")(function* () {
          return yield* file.readJson(MODEL_FILE).pipe(
            Effect.map(state),
            Effect.catchCause(() => Effect.succeed(state(undefined))),
          )
        })

        const resolveSavedVariant = Effect.fn("RunVariant.resolveSavedVariant")(function* (model: RunInput["model"]) {
          if (!model) {
            return undefined
          }

          return (yield* read()).variant?.[DRAFT_SCOPE]?.[variantKey(model)]
        })

        const saveVariant = Effect.fn("RunVariant.saveVariant")(function* (
          model: RunInput["model"],
          variant: string | undefined,
        ) {
          if (!model) {
            return
          }

          const current = yield* read()
          const next = { ...current.variant }
          const bucket = { ...(next[DRAFT_SCOPE] ?? {}) }
          const key = variantKey(model)
          if (variant) {
            bucket[key] = variant
          }

          if (!variant) {
            delete bucket[key]
          }

          if (Object.keys(bucket).length > 0) {
            next[DRAFT_SCOPE] = bucket
          } else {
            delete next[DRAFT_SCOPE]
          }

          yield* file
            .writeJson(MODEL_FILE, {
              ...current,
              variant: next,
            })
            .pipe(Effect.orElseSucceed(() => undefined))
        })

        return Service.of({
          resolveSavedVariant,
          saveVariant,
        })
      }),
    ).pipe(Layer.provide(fs)),
  )
}

/** @internal Exported for testing. */
export function createVariantRuntime(fs = AppNodeBuilder.build(FSUtil.node)): VariantRuntime {
  const runtime = makeRuntime(Service, createLayer(fs))
  return {
    resolveSavedVariant: (model) => runtime.runPromise((svc) => svc.resolveSavedVariant(model)).catch(() => undefined),
    saveVariant: (model, variant) => runtime.runPromise((svc) => svc.saveVariant(model, variant)).catch(() => {}),
  }
}

const runtime = createVariantRuntime()

export async function resolveSavedVariant(model: RunInput["model"]): Promise<string | undefined> {
  return runtime.resolveSavedVariant(model)
}

export function saveVariant(model: RunInput["model"], variant: string | undefined): void {
  void runtime.saveVariant(model, variant)
}
