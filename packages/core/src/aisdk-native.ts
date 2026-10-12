export * as AISDKNative from "./aisdk-native.js"

import { Effect, Option, Schema, Struct } from "effect"
import { Provider } from "./provider.js"

type Overlays = {
  settings?: Provider.Settings
  headers?: Record<string, string>
  body?: Record<string, unknown>
}

type Target<ID extends string> = Overlays & {
  package?: string
  variants?: (Overlays & { id: ID })[]
}

type Context = {
  readonly providerID: string
  readonly canonical?: string
  readonly modelID?: string
}

export function rewrite<ID extends string>(
  target: Target<ID>,
  input: Context & { readonly specifier: string | undefined },
) {
  if (input.specifier === undefined) return
  const replacement = resolve(input.specifier, input)
  if (!replacement) return
  const translated = options(decode(target.settings ?? {}))
  if (target.package !== undefined || replacement !== input.specifier) target.package = replacement
  target.settings =
    target.settings === undefined
      ? undefined
      : {
          ...translated.settings,
          ...(!NATIVE.has(input.specifier) && replacement === "@opencode/ai/providers/openai-compatible"
            ? { provider: input.canonical ?? input.providerID }
            : {}),
        }
  target.headers = Provider.mergeHeaders(translated.headers, target.headers)
  target.body = Provider.mergeOverlay(translated.body, target.body)
  target.variants = target.variants?.map((variant) => {
    const overlay = options(decode(variant.settings ?? {}))
    const headers = Provider.mergeHeaders(overlay.headers, variant.headers)
    const body = Provider.mergeOverlay(overlay.body, variant.body)
    return {
      id: variant.id,
      ...(variant.settings === undefined ? {} : { settings: overlay.settings }),
      ...(headers === undefined ? {} : { headers }),
      ...(body === undefined ? {} : { body }),
    }
  })
}

const PACKAGES: Readonly<Record<string, string>> = {
  "@ai-sdk/alibaba": "@opencode/ai/providers/alibaba/chat",
  "@ai-sdk/anthropic": "@opencode/ai/providers/anthropic",
  "@ai-sdk/openai-compatible": "@opencode/ai/providers/openai-compatible",
}

const protocols = (name: string) => ({
  "@ai-sdk/openai-compatible": `@opencode/ai/providers/${name}/chat`,
  "@ai-sdk/anthropic": `@opencode/ai/providers/${name}/messages`,
})

const HOSTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  alibaba: protocols("alibaba"),
  "alibaba-cn": protocols("alibaba"),
  "alibaba-coding-plan": protocols("alibaba"),
  "alibaba-coding-plan-cn": protocols("alibaba"),
  "alibaba-token-plan": protocols("alibaba"),
  "alibaba-token-plan-cn": protocols("alibaba"),
  deepseek: { "@ai-sdk/openai-compatible": "@opencode/ai/providers/deepseek" },
  zai: { "@ai-sdk/openai-compatible": "@opencode/ai/providers/zai/chat" },
  "zai-coding-plan": protocols("zai-coding-plan"),
  zhipuai: { "@ai-sdk/openai-compatible": "@opencode/ai/providers/zai/chat" },
  "zhipuai-coding-plan": protocols("zai-coding-plan"),
}

const NATIVE = new Set([...Object.values(PACKAGES), ...Object.values(HOSTS).flatMap((host) => Object.values(host))])

export function native(npm: string, context: Context): string | undefined {
  return HOSTS[context.providerID]?.[npm] ?? PACKAGES[npm]
}

function resolve(specifier: string, context: Context): string | undefined {
  const npm = Provider.packageName(specifier)
  if (Provider.isAISDK(specifier) || npm in PACKAGES || npm in (HOSTS[context.providerID] ?? {}))
    return native(npm, context)
  return NATIVE.has(npm) ? npm : undefined
}

type Overlay = {
  readonly settings: Provider.Settings
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: Readonly<Record<string, unknown>>
}

function options(settings: Legacy): Overlay {
  return {
    settings: Struct.omit(settings, ["headers", "extraBody"]),
    ...(settings.headers === undefined ? {} : { headers: settings.headers }),
    ...(settings.extraBody === undefined ? {} : { body: settings.extraBody }),
  }
}

const lenient = <S extends Schema.Top>(schema: S) =>
  Schema.optional(Schema.UndefinedOr(schema).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(undefined)))))

const Legacy = Schema.StructWithRest(
  Schema.Struct({
    apiKey: lenient(Schema.String),
    baseURL: lenient(Schema.String),
    headers: lenient(Schema.Record(Schema.String, Schema.String)),
    extraBody: lenient(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
type Legacy = typeof Legacy.Type
const decode = Schema.decodeUnknownSync(Legacy)
