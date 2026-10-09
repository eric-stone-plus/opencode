import { createStore, produce, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { batch, createEffect, createMemo } from "solid-js"
import { useSync } from "./sync"
import { useEvent } from "./event"
import path from "path"
import { useTuiPaths } from "./runtime"
import { useArgs } from "./args"
import { useSDK } from "./sdk"
import { RGBA } from "@opentui/core"
import { readJson, writeJsonAtomic } from "../util/persistence"
import { useTheme } from "./theme"
import { useToast } from "../ui/toast"
import { useRoute, type Route } from "./route"
import { usePermission } from "./permission"
import { DRAFT_SCOPE, normalizeVariantStore, type VariantStore } from "@opencode-ai/core/variant"

export type LocalTheme = {
  secondary: RGBA
  accent: RGBA
  success: RGBA
  warning: RGBA
  primary: RGBA
  error: RGBA
  info: RGBA
}

export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID: providerID,
    modelID: rest.join("/"),
  }
}

export function recentModels(
  model: { providerID: string; modelID: string },
  recent: { providerID: string; modelID: string }[],
) {
  const seen = new Set<string>()
  return [model, ...recent]
    .filter((item) => {
      const key = `${item.providerID}/${item.modelID}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 10)
    .map((item) => ({ providerID: item.providerID, modelID: item.modelID }))
}

// Mirrors the server's variant resolution (packages/opencode/src/session/prompt.ts createUserMessage):
// the explicit pick wins, otherwise the agent default applies only when the request model is the
// agent's own model and the variant exists on that model. "default" is the unset sentinel that
// variant.set(undefined) persists, so it is treated as no selection.
export function resolveVariant(input: {
  selected: string | undefined
  variants: string[]
  model: { providerID: string; modelID: string }
  agentModel: { providerID: string; modelID: string } | undefined
  agentVariant: string | undefined
}) {
  if (input.selected && input.selected !== "default" && input.variants.includes(input.selected)) return input.selected
  const same =
    !!input.agentModel &&
    input.model.providerID === input.agentModel.providerID &&
    input.model.modelID === input.agentModel.modelID
  if (input.agentVariant && same && input.variants.includes(input.agentVariant)) return input.agentVariant
  return undefined
}

// Display-only companion to resolveVariant: when no explicit or agent variant
// resolves, a model-level `options.reasoningEffort` pin still reaches every
// request (the server merges model options over the variant), so the footer
// must show it instead of hiding the effort. This never feeds back into the
// request or the variant store.
export function effectiveVariant(input: {
  selected: string | undefined
  variants: string[]
  model: { providerID: string; modelID: string }
  agentModel: { providerID: string; modelID: string } | undefined
  agentVariant: string | undefined
  pinned: string | undefined
}) {
  const resolved = resolveVariant(input)
  if (resolved) return resolved
  if (input.pinned && input.variants.includes(input.pinned)) return input.pinned
  return undefined
}

export type ModelRef = { providerID: string; modelID: string }

// The model is a per-session choice, not a per-agent one: once the user picks
// a model in a session (or the session is opened with a model on its last user
// message) it survives agent switches (Tab, follow, plan_exit). Sessions
// without a choice resolve to the agent's pinned model, then the fallback.
// `null` marks a session known to have no choice (created from a draft that
// had none), `undefined` one this TUI has not seen yet. The draft composer
// (home, before the first prompt creates a session) has its own scope, handed
// to the session it creates.
export type ModelChoice = ModelRef | null | undefined

export function modelScope(route: Route) {
  return route.type === "session" ? route.sessionID : DRAFT_SCOPE
}

// Precedence: the session's explicit choice > the agent's pinned model > the
// global fallback (--model, config model, recents, provider default). Invalid
// candidates (disconnected provider, removed model) are skipped — except an
// explicitly configured fallback (`configured`), which is kept as-is so the
// server reports ModelNotFound instead of the TUI silently using another model.
export function resolveModel(input: {
  choice: ModelChoice
  agentModel: ModelRef | undefined
  fallback: ModelRef | undefined
  configured?: boolean
  valid(model: ModelRef): boolean
}) {
  for (const model of [input.choice, input.agentModel, input.fallback]) {
    if (model && input.valid(model)) return model
  }
  if (input.configured) return input.fallback
}

// The explicitly requested global model (--model, else config `model`). It is
// authoritative: when it is not in the provider list the TUI keeps it (and
// warns) rather than falling through to recents or a provider default.
export function configuredModel(input: { arg?: string; config?: string }) {
  const value = input.arg || input.config
  if (!value) return undefined
  return { ...parseModel(value), source: input.arg ? ("--model" as const) : ("config" as const) }
}

// Variants are stored per session and model, like the model choice itself: a
// variant picked in one session must not leak into another. The draft composer
// (home, before the first prompt creates a session) has its own bucket that is
// handed to the session it creates. A stored variant the newly chosen model
// does not offer is dropped (unset, i.e. default) rather than kept as a
// dangling selection; the model dialog then offers the variant picker again.
// The store shape and its migration live in core, shared with `opencode run`.
export function readVariant(store: VariantStore, scope: string, model: ModelRef | undefined) {
  if (!model) return undefined
  return store[scope]?.[`${model.providerID}/${model.modelID}`]
}

// Hands the draft bucket to the session and clears the draft. Returns a new
// store because Solid merges plain objects written into a store path: writing
// the draft node into the session key directly would alias the two buckets,
// and writing `{}` would not replace an existing one.
export function adoptVariant(store: VariantStore, sessionID: string): VariantStore {
  return {
    ...store,
    [sessionID]: { ...(store[DRAFT_SCOPE] ?? {}) },
    [DRAFT_SCOPE]: {},
  }
}

export function variantAfterModelChange(selected: string | undefined, variants: string[]) {
  if (!selected || selected === "default" || variants.includes(selected)) return selected
  return undefined
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sync = useSync()
    const sdk = useSDK()
    const toast = useToast()
    const theme = useTheme().theme
    const route = useRoute()
    const paths = useTuiPaths()
    const args = useArgs()
    const event = useEvent()
    const permission = usePermission()

    function isModelValid(model: { providerID: string; modelID: string }) {
      const provider = sync.data.provider.find((item) => item.id === model.providerID)
      return !!provider?.models[model.modelID]
    }

    function createAgent() {
      const agents = createMemo(() => sync.data.agent.filter((agent) => agent.mode !== "subagent" && !agent.hidden))
      const visibleAgents = createMemo(() => sync.data.agent.filter((agent) => !agent.hidden))
      const [agentStore, setAgentStore] = createStore({
        current: undefined as string | undefined,
      })
      const colors = createMemo(() => [
        theme.secondary,
        theme.accent,
        theme.success,
        theme.warning,
        theme.primary,
        theme.error,
        theme.info,
      ])
      return {
        list() {
          return agents()
        },
        current() {
          return agents().find((x) => x.name === agentStore.current) ?? agents().at(0)
        },
        set(name: string) {
          if (!agents().some((x) => x.name === name))
            return toast.show({
              variant: "warning",
              message: `Agent not found: ${name}`,
              duration: 3000,
            })
          setAgentStore("current", name)
        },
        move(direction: 1 | -1) {
          batch(() => {
            const current = this.current()
            if (!current) return
            let next = agents().findIndex((x) => x.name === current.name) + direction
            if (next < 0) next = agents().length - 1
            if (next >= agents().length) next = 0
            const value = agents()[next]
            setAgentStore("current", value.name)
          })
        },
        color(name: string) {
          const index = visibleAgents().findIndex((x) => x.name === name)
          if (index === -1) return colors()[0]
          const agent = visibleAgents()[index]

          if (agent?.color) {
            const color = agent.color
            if (color.startsWith("#")) return RGBA.fromHex(color)
            // already validated by config, just satisfying TS here
            return theme[color as keyof typeof theme] as RGBA
          }
          return colors()[index % colors().length]
        },
      }
    }

    const agent = createAgent()

    function createModel() {
      const [modelStore, setModelStore] = createStore<{
        ready: boolean
        // Session-scoped explicit choice, keyed by modelScope(); in memory only.
        model: Record<string, ModelChoice>
        recent: {
          providerID: string
          modelID: string
        }[]
        favorite: {
          providerID: string
          modelID: string
        }[]
        variant: VariantStore
      }>({
        ready: false,
        model: {},
        recent: [],
        favorite: [],
        variant: {},
      })

      const filePath = path.join(paths.state, "model.json")
      const state = {
        pending: false,
      }

      function save() {
        if (!modelStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        void writeJsonAtomic(filePath, {
          recent: modelStore.recent,
          favorite: modelStore.favorite,
          variant: modelStore.variant,
        })
      }

      readJson<unknown>(filePath)
        .then((x) => {
          if (!x || typeof x !== "object") return
          const value = x as Record<string, unknown>
          if (Array.isArray(value.recent)) setModelStore("recent", value.recent)
          if (Array.isArray(value.favorite)) setModelStore("favorite", value.favorite)
          if (typeof value.variant === "object" && value.variant !== null)
            setModelStore("variant", normalizeVariantStore(value.variant))
        })
        .catch(() => {})
        .finally(() => {
          setModelStore("ready", true)
          if (state.pending) save()
        })

      // Session buckets are only useful while the session exists; without this
      // the store grows with every session ever opened or created.
      event.on("session.deleted", (evt) => {
        const sessionID = evt.properties.info.id
        if (modelStore.variant[sessionID] === undefined && modelStore.model[sessionID] === undefined) return
        setModelStore(
          produce((draft) => {
            delete draft.variant[sessionID]
            delete draft.model[sessionID]
          }),
        )
        save()
      })

      const configured = createMemo(() => configuredModel({ arg: args.model, config: sync.data.config.model }))

      // Warn (once per value) when the configured model is not offered by any
      // connected provider; it is still used so the server reports the error.
      let warned: string | undefined
      createEffect(() => {
        const model = configured()
        if (!model || sync.status === "loading") return
        const key = `${model.providerID}/${model.modelID}`
        if (isModelValid(model) || warned === key) return
        warned = key
        toast.show({
          variant: "warning",
          message: `Configured model ${key} (${model.source}) is not available from any connected provider`,
          duration: 5000,
        })
      })

      const fallbackModel = createMemo(() => {
        const explicit = configured()
        if (explicit) return { providerID: explicit.providerID, modelID: explicit.modelID }

        for (const item of modelStore.recent) {
          if (isModelValid(item)) {
            return item
          }
        }

        const provider = sync.data.provider[0]
        if (!provider) return undefined
        const defaultModel = sync.data.provider_default[provider.id]
        const firstModel = Object.values(provider.models)[0]
        const model = defaultModel ?? firstModel?.id
        if (!model) return undefined
        return {
          providerID: provider.id,
          modelID: model,
        }
      })

      const scope = createMemo(() => modelScope(route.data))

      const currentModel = createMemo(() =>
        resolveModel({
          choice: modelStore.model[scope()],
          agentModel: agent.current()?.model,
          fallback: fallbackModel(),
          configured: configured() !== undefined,
          valid: isModelValid,
        }),
      )

      function variantsOf(model: ModelRef) {
        const info = sync.data.provider.find((item) => item.id === model.providerID)?.models[model.modelID]
        return info?.variants ? Object.keys(info.variants) : []
      }

      function choose(model: ModelRef) {
        batch(() => {
          setModelStore("model", scope(), { providerID: model.providerID, modelID: model.modelID })
          const key = `${model.providerID}/${model.modelID}`
          const previous = modelStore.variant[scope()]?.[key]
          const next = variantAfterModelChange(previous, variantsOf(model))
          if (next === previous) return
          setModelStore(
            produce((draft) => {
              draft.variant[scope()] ??= {}
              draft.variant[scope()]![key] = next
            }),
          )
          save()
        })
      }

      return {
        current: currentModel,
        get ready() {
          return modelStore.ready
        },
        // Whether this TUI already holds the session's model state, in which
        // case opening it must not re-initialize from its last user message.
        known(sessionID: string) {
          return modelStore.model[sessionID] !== undefined
        },
        // Hand the draft composer's choice (or its absence) to the session it
        // just created, so the next new session starts from defaults/pins.
        adopt(sessionID: string) {
          batch(() => {
            setModelStore("model", sessionID, modelStore.model[DRAFT_SCOPE] ?? null)
            setModelStore("model", DRAFT_SCOPE, undefined)
            setModelStore("variant", reconcile(adoptVariant(modelStore.variant, sessionID)))
          })
          save()
        },
        recent() {
          return modelStore.recent
        },
        favorite() {
          return modelStore.favorite
        },
        parsed: createMemo(() => {
          const value = currentModel()
          if (!value) {
            return {
              provider: "Connect a provider",
              model: "No provider selected",
              reasoning: false,
            }
          }
          const provider = sync.data.provider.find((item) => item.id === value.providerID)
          const info = provider?.models[value.modelID]
          return {
            provider: provider?.name ?? value.providerID,
            model: info?.name ?? value.modelID,
            reasoning: info?.capabilities?.reasoning ?? false,
          }
        }),
        cycle(direction: 1 | -1) {
          const current = currentModel()
          if (!current) return
          const recent = modelStore.recent
          const index = recent.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          if (index === -1) return
          let next = index + direction
          if (next < 0) next = recent.length - 1
          if (next >= recent.length) next = 0
          const val = recent[next]
          if (!val) return
          choose(val)
        },
        cycleFavorite(direction: 1 | -1) {
          const favorites = modelStore.favorite.filter((item) => isModelValid(item))
          if (!favorites.length) {
            toast.show({
              variant: "info",
              message: "Add a favorite model to use this shortcut",
              duration: 3000,
            })
            return
          }
          const current = currentModel()
          let index = -1
          if (current) {
            index = favorites.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          }
          if (index === -1) {
            index = direction === 1 ? 0 : favorites.length - 1
          } else {
            index += direction
            if (index < 0) index = favorites.length - 1
            if (index >= favorites.length) index = 0
          }
          const next = favorites[index]
          if (!next) return
          choose(next)
          setModelStore("recent", recentModels(next, modelStore.recent))
          save()
        },
        set(model: { providerID: string; modelID: string }, options?: { recent?: boolean }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            choose(model)
            if (options?.recent) {
              setModelStore("recent", recentModels(model, modelStore.recent))
              save()
            }
          })
        },
        toggleFavorite(model: { providerID: string; modelID: string }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const exists = modelStore.favorite.some(
              (x) => x.providerID === model.providerID && x.modelID === model.modelID,
            )
            const next = exists
              ? modelStore.favorite.filter((x) => x.providerID !== model.providerID || x.modelID !== model.modelID)
              : [model, ...modelStore.favorite]
            setModelStore(
              "favorite",
              next.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
            )
            save()
          })
        },
        variant: {
          selected() {
            return readVariant(modelStore.variant, scope(), currentModel())
          },
          current() {
            const m = currentModel()
            if (!m) return undefined
            const variants = this.list()
            if (variants.length === 0) return undefined
            const a = agent.current()
            return resolveVariant({
              selected: this.selected(),
              variants,
              model: m,
              agentModel: a?.model,
              agentVariant: a?.variant,
            })
          },
          effective() {
            const m = currentModel()
            if (!m) return undefined
            const variants = this.list()
            if (variants.length === 0) return undefined
            const a = agent.current()
            const info = sync.data.provider.find((item) => item.id === m.providerID)?.models[m.modelID]
            const pinned = info?.options?.reasoningEffort
            return effectiveVariant({
              selected: this.selected(),
              variants,
              model: m,
              agentModel: a?.model,
              agentVariant: a?.variant,
              pinned: typeof pinned === "string" ? pinned : undefined,
            })
          },
          list() {
            const m = currentModel()
            if (!m) return []
            return variantsOf(m)
          },
          set(value: string | undefined) {
            const m = currentModel()
            if (!m) return
            const key = `${m.providerID}/${m.modelID}`
            setModelStore(
              produce((draft) => {
                draft.variant[scope()] ??= {}
                draft.variant[scope()]![key] = value ?? "default"
              }),
            )
            save()
          },
          cycle() {
            const variants = this.list()
            if (variants.length === 0) return
            const current = this.current()
            if (!current) {
              this.set(variants[0])
              return
            }
            const index = variants.indexOf(current)
            if (index === -1 || index === variants.length - 1) {
              this.set(undefined)
              return
            }
            this.set(variants[index + 1])
          },
        },
      }
    }

    const model = createModel()

    function createSession() {
      const [sessionStore, setSessionStore] = createStore<{
        ready: boolean
        pinned: string[]
      }>({
        ready: false,
        pinned: [],
      })

      const filePath = path.join(paths.state, "session.json")
      const state = {
        pending: false,
      }

      function save() {
        if (!sessionStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        void writeJsonAtomic(filePath, {
          pinned: sessionStore.pinned,
        })
      }

      readJson<unknown>(filePath)
        .then((x) => {
          if (!x || typeof x !== "object") return
          const pinned = (x as Record<string, unknown>).pinned
          if (Array.isArray(pinned))
            setSessionStore(
              "pinned",
              pinned.filter((item): item is string => typeof item === "string"),
            )
        })
        .catch(() => {})
        .finally(() => {
          setSessionStore("ready", true)
          if (state.pending) save()
        })

      const slots = createMemo(() => {
        const existing = new Set(sync.data.session.filter((x) => x.parentID === undefined).map((x) => x.id))
        return sessionStore.pinned.filter((id) => existing.has(id)).slice(0, 9)
      })

      function prune(sessionID: string) {
        batch(() => {
          if (sessionStore.pinned.includes(sessionID)) {
            setSessionStore(
              "pinned",
              sessionStore.pinned.filter((x) => x !== sessionID),
            )
          }
          save()
        })
      }

      event.on("session.deleted", (evt) => {
        prune(evt.properties.info.id)
      })

      return {
        get ready() {
          return sessionStore.ready
        },
        pinned() {
          return sessionStore.pinned
        },
        slots,
        isPinned(sessionID: string) {
          return sessionStore.pinned.includes(sessionID)
        },
        togglePin(sessionID: string) {
          batch(() => {
            const exists = sessionStore.pinned.includes(sessionID)
            const next = exists
              ? sessionStore.pinned.filter((x) => x !== sessionID)
              : [...sessionStore.pinned, sessionID]
            setSessionStore("pinned", next)
            save()
          })
        },
        quickSwitch(slot: number) {
          const target = slots()[slot - 1]
          if (!target) return
          if (route.data.type === "session" && route.data.sessionID === target) return
          route.navigate({ type: "session", sessionID: target })
        },
      }
    }

    const session = createSession()

    const mcp = {
      isEnabled(name: string) {
        const status = sync.data.mcp[name]
        return status?.status === "connected"
      },
      async toggle(name: string) {
        const status = sync.data.mcp[name]
        if (status?.status === "connected") {
          // Disable: disconnect the MCP
          await sdk.client.mcp.disconnect({ name })
        } else {
          // Enable/Retry: connect the MCP (handles disabled, failed, and other states)
          await sdk.client.mcp.connect({ name })
        }
      },
    }

    createEffect(() => {
      const value = agent.current()
      if (!value?.model) return
      if (isModelValid(value.model)) return
      toast.show({
        variant: "warning",
        message: `Agent ${value.name}'s configured model ${value.model.providerID}/${value.model.modelID} is not valid`,
        duration: 3000,
      })
    })

    const result = {
      model,
      agent,
      mcp,
      session,
      permission,
    }
    return result
  },
})
