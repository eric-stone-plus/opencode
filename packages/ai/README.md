# @opencode/ai

Schema-first APIs for text, built with Effect. This fork bundles providers for Alibaba, DeepSeek and the Xiaomi
token plan (through the Alibaba, DeepSeek, `Anthropic*` and `OpenAICompatible` facades) and nothing else.

```ts
import { Effect } from "effect"
import { AIClient, LLM } from "@opencode/ai"
import { DeepSeek } from "@opencode/ai/providers"

const deepseek = DeepSeek.configure({ apiKey: process.env.DEEPSEEK_API_KEY })

const program = Effect.gen(function* () {
  const response = yield* LLM.generate({
    model: deepseek.model("deepseek-chat"),
    system: "You are concise.",
    prompt: "Say hello in one short sentence.",
    generation: { maxTokens: 40 },
  })
  console.log(response.text)
})

// Every modality client plus the HTTP request executor; `AIClient.layerWith(executor)` swaps the executor.
await Effect.runPromise(program.pipe(Effect.provide(AIClient.layer)))
```

Run `LLM.stream(...)` instead of `generate` when you want incremental `LLMEvent`s. Both accept input or a prebuilt
`LLM.request(...)`. The event stream is provider-neutral — same shape across OpenAI Chat, Anthropic Messages, and any
OpenAI-compatible or Anthropic-compatible deployment.

To share a policy such as logging across every client, wrap the executor once with `RequestExecutor.middleware`:

```ts
import { RequestExecutor } from "@opencode/ai/route"

const logged = RequestExecutor.middleware((request, next) =>
  Effect.log(`${request.method} ${request.url}`).pipe(Effect.andThen(next(request))),
)

const everything = AIClient.layerWith(logged) // or AI.make({ layer: logged })
```

Prefer promises? `@opencode/ai/promise` exposes the same LLM APIs over one managed runtime:

```ts
import { AI } from "@opencode/ai/promise"

const ai = AI.make()
const input = { model: deepseek.model("deepseek-chat"), prompt: "Say hello." }
const text = await ai.llm.generate(input)
for await (const event of ai.llm.stream(ai.llm.request(input))) {
  // LLMEvent
}
await ai.dispose()
```

## Alibaba Cloud Model Studio

`Alibaba` provides standard Model Studio inference. Configure a region explicitly, then select
Chat Completions (`.model` or `.chat`) or Anthropic-compatible Messages (`.messages`). These routes use HTTP/SSE.

```ts
import { LLM } from "@opencode/ai"
import { Alibaba } from "@opencode/ai/providers"

const alibaba = Alibaba.configure({
  region: "ap-southeast-1", // Singapore
  apiKey: process.env.DASHSCOPE_API_KEY,
  // workspaceID: "llm-your-workspace", // use a workspace-dedicated endpoint
})

const request = LLM.request({
  model: alibaba.model("qwen3.8-max"),
  prompt: "Explain this design.",
  providerOptions: { reasoningEffort: "medium" },
})
```

### Regions and credentials

| Region              | `region`         | Shared host when `workspaceID` is omitted |
| ------------------- | ---------------- | ----------------------------------------- |
| Singapore           | `ap-southeast-1` | `dashscope-intl.aliyuncs.com`             |
| China (Beijing)     | `cn-beijing`     | `dashscope.aliyuncs.com`                  |
| China (Hong Kong)   | `cn-hongkong`    | `cn-hongkong.dashscope.aliyuncs.com`      |
| US (Virginia)       | `us-east-1`      | `dashscope-us.aliyuncs.com`               |
| Germany (Frankfurt) | `eu-central-1`   | Supply `workspaceID` or `baseURL`         |
| Japan (Tokyo)       | `ap-northeast-1` | Supply `workspaceID` or `baseURL`         |

With `workspaceID`, the host is `{workspaceID}.{region}.maas.aliyuncs.com`. A complete `baseURL`
overrides regional setup, including the API prefix: `/compatible-mode/v1` for Chat,
or `/apps/anthropic/v1` for Messages. The selector appends its operation path.

Keys and model availability are region-specific. Auth resolves from explicit `auth` or `apiKey`,
then `DASHSCOPE_API_KEY`, then `ALIBABA_API_KEY`.

The access region and inference scope differ: Virginia's `-us` model IDs request US-only inference;
some regions select scope through their workspace. Model IDs pass through unchanged.
Alibaba's [regional guide](https://www.alibabacloud.com/help/en/model-studio/regions) and
[base URL table](https://www.alibabacloud.com/help/en/model-studio/base-url) disagree about Virginia's
shared host; the entry above follows the base URL table. Dedicated hosts can be copied from the console.

### Native options

- **Chat:** `reasoningEffort` → `reasoning_effort`, `enableThinking` → `enable_thinking`,
  `thinkingBudget` → `thinking_budget`, and `preserveThinking` → `preserve_thinking`.
  Replay complete `response.message` values to retain `reasoning_content` separately from answer text.
  Qwen 3.8 defaults to preserving thinking; older models have different defaults.
  Additional options include `toolStream`, `parallelToolCalls`, `repetitionPenalty`, `responseFormat`,
  `enableSearch`, and native `searchOptions`. `generation.topK` lowers to `top_k`.
  `clearThinking` is a hosted GLM control, and `thinking.type` is available for hosted MiniMax models.
- **Messages:** `effort` → `output_config.effort`. `thinking.type` accepts enabled/disabled with an
  optional `budgetTokens` (or native `budget_tokens`). `outputConfig.format` accepts a JSON schema.
  Model Studio's empty thinking signatures are accepted; supplied signatures are replayed unchanged.

Omitted options preserve provider defaults. Effort values pass through unchanged and accept future
strings. Qwen 3.8 Chat rejects requests combining a thinking budget with effort.

Package entrypoints are `@opencode/ai/providers/alibaba`, `alibaba/chat`, and `alibaba/messages`. Live
recordings cover both APIs in Singapore; regional URL construction is unit-tested for all six regions.

## DeepSeek

`DeepSeek` is Chat Completions against `https://api.deepseek.com/v1`. It reads `DEEPSEEK_API_KEY` when `apiKey` is
omitted and accepts an explicit `auth` override or a `baseURL` for gateways:

```ts
import { LLM } from "@opencode/ai"
import { DeepSeek } from "@opencode/ai/providers"

const deepseek = DeepSeek.configure({ apiKey: process.env.DEEPSEEK_API_KEY })
const request = LLM.request({
  model: deepseek.model("deepseek-chat"),
  prompt: "Explain this design.",
  providerOptions: { reasoningEffort: "high" },
})
```

## Anthropic and Anthropic-compatible

`Anthropic` talks to Anthropic Messages and reads `ANTHROPIC_API_KEY` (or accepts `authToken` for bearer
credentials). `AnthropicCompatible` takes any Messages-protocol endpoint and requires `baseURL`; provider
identity and the metadata key come from the optional `provider` setting:

```ts
import { Anthropic, AnthropicCompatible } from "@opencode/ai/providers"

const claude = Anthropic.configure({ apiKey: process.env.ANTHROPIC_API_KEY }).model("claude-sonnet-4-6")
const compatible = AnthropicCompatible.configure({
  apiKey: process.env.EXAMPLE_API_KEY,
  baseURL: "https://messages.example.com/v1",
  provider: "example",
}).model("example-model")
```

`apiKey` and `authToken` are mutually exclusive. Provider options include `thinking` (`enabled` with a token
budget, `adaptive`, or `disabled`) and `effort`.

## OpenAI-compatible

`OpenAICompatible` targets any Chat Completions endpoint and requires `baseURL`. The optional `provider` setting names
the provider for metadata and routing; `apiKey` is optional for local or gateway deployments.

```ts
import { OpenAICompatible } from "@opencode/ai/providers"

const model = OpenAICompatible.configure({ baseURL: "https://gateway.example.com/v1", apiKey }).model("some-model")
```

## Public API

- **`LLM.request({...})`** — build a provider-neutral `LLMRequest`. Accepts ergonomic inputs (`system: string`, `prompt: string`) that normalize into the canonical Schema classes.
- **`LLM.generate` / `LLM.stream`** — run direct input or an `LLMRequest` through `LLMClient` for one-import use.
- **`Message.user(...)` / `Message.assistant(...)` / `Message.tool(...)`** — message constructors from the canonical schema model.
- **`LanguageModel.make(...)` / `ToolCallPart.make(...)` / `ToolResultPart.make(...)` / `ToolDefinition.make(...)`** — model and tool-related constructors from the canonical schema model.
- **`LLMEvent.is.*`** — typed guards (`is.textDelta`, `is.toolCall`, `is.finish`, …) for filtering streams.
- **`Image.request` / `generate` / `stream` / `start` / `resume`** — images over inline, streaming (partial previews), and queued routes through a provider-neutral request and response model. No bundled provider ships an image route.
- **`ImageClient`** — Effect service and layer for image execution, parallel to `LLMClient`.
- **`Media`** — the shared asset type (`Media.Asset`, `Media.Source`) and constructors used by messages, tool results, and media requests.
- **`Generation`** — provider-neutral handle for an in-flight media generation (`await`, `refresh`, `cancel`, `events`) used by queued media routes.
- **`Video.request` / `generate` / `stream` / `start` / `resume`** — queued video generation through a provider-neutral request; `VideoClient` is its Effect service and layer.
- **`Speech.request` / `Speech.generate` / `Speech.stream`** — text-to-speech through a provider-neutral request; `SpeechClient` is its Effect service and layer.
- **`Transcription.request` / `generate` / `stream` / `start` / `resume`** — speech-to-text over inline, streaming, and queued routes; `TranscriptionClient` is its Effect service and layer.
- **`AIClient.layer` / `AIClient.layerWith(executor)`** — every modality client plus the request executor in one layer.
- **`@opencode/ai/promise`** — `AI.make({ layer? })` and a default `ai` client exposing `llm`, `image`, `video`, `speech`, and `transcription` as Promise / `AsyncIterable` APIs, plus `file`, `write`, `bytes`, `base64`, and `materialize` for assets.

## Testing

Use the deterministic test client from `@opencode/ai/testing` to script provider-neutral responses and inspect
the requests sent by code under test:

```ts
import { Effect } from "effect"
import { TestLLM } from "@opencode/ai/testing"

const programWithTestClient = Effect.gen(function* () {
  const test = yield* TestLLM.Test
  yield* test.push(TestLLM.text("Hello from the test model", "text-1"))
  const result = yield* program
  console.log(yield* test.requests())
  return result
}).pipe(Effect.provide(TestLLM.testLayer()))
```

`testLayer()` provides the same object under `LLMClient.Service` and `TestLLM.Test`. Production consumes the
normal client; tests use the additional controls. Each layer build has fresh state.

- `test.push(...)` queues one-shot responses in execution order. Each argument is one response.
- `test.always(response)` installs a repeatable fallback. The layer's `fallback` option sets its initial value.
- `test.serve(request => response)` installs a request-dependent fallback. `always` and `serve` replace each
  other without changing queued replies; queued replies take precedence.
- `test.requests()` returns an array snapshot. `transformRequest` changes only the recorded observation;
  `serve` receives the original canonical request.
- `test.wait(count)` waits for request arrivals, not output or completion, and supports concurrent waiters.
- `test.gate()` returns a scoped gate with countable `started` notifications and a `release` Effect. Release
  unblocks all requests captured by that gate; closing its scope also releases it. Effect-aware test runners
  already provide Scope.

Constructing `stream()` or `generate()` does not record a request, invoke a responder, or consume a script.
Each execution does. An exhausted queue without a fallback defects immediately rather than waiting for a
future reply.

Generation responses remain canonical event arrays or arbitrary `Stream<LLMEvent, AIError>` values. The client consumes
supplied streams directly, preserving failure identity, finalizers, incomplete output, and post-finish tails;
it does not repair or truncate them.

For explicit compaction, script a `CompactionResponse` through `push`, `always`, or `serve` (no bundled route implements the operation, so a route must supply a `compact` implementation first). Its `replacement` contains the next context window, including retained user messages. The client returns that result and usage directly, with the same lazy request recording and gates. Generation and compaction reject fixtures for the wrong operation instead of converting between response shapes.

For `compact(request, { mechanism: "trigger" })`, script a `CompactionCheckpointResponse` instead. It carries `checkpoint`, `responseID`, and optional `usage`. Endpoint and trigger calls reject each other's fixtures; both share the same queue, gates, lazy recording, and fallback controls.

The published legacy `Service`, `layer`, `clientLayer`, and module-level controls remain available as adapters
over the same implementation, including the legacy live `requests` array. New tests should use `Test` and
`testLayer`.

## Provider compaction

The only bundled in-band mechanism is Anthropic's `contextManagement` edit. The explicit and checkpoint operations on `LLMClient.compact` remain available to routes that implement them, but no route shipped by this fork does.

### Advanced: in-band compaction

`providerOptions.contextManagement` lets the provider decide when to compact during an ordinary `generate` or `stream` call. This is an advanced option for callers that own persistence and recovery: persist the complete assistant message, including its checkpoint, before continuing. Enabling the option does not provide durable checkpoint storage, interruption recovery, or model-switch policy. Keep the prior context until a successful checkpoint has been persisted.

Enable it through `contextManagement`:

```ts
providerOptions: {
  contextManagement: {
    edits: [{
      type: "compact_20260112",
      trigger: { type: "input_tokens", value: 150_000 },
      pauseAfterCompaction: true,
      instructions: "Summarize the task and decisions. Do not call tools while summarizing.",
    }],
  },
}
```

Keep the entire `response.message`, not just `response.text`. Compaction events become ordered `CompactionPart`s alongside text and reasoning. The conversation contains everything needed to continue; there is no separate replay object or hidden provider transcript.

A compaction part has `provider` and exactly one representation: `text` for Anthropic (a Responses-style `encrypted` checkpoint is part of the schema but no bundled route produces one). These fields survive message serialization without becoming visible assistant text. Sending a checkpoint to another provider or an incompatible API fails rather than silently losing context.

```ts
import { CompactionPart, ProviderID } from "@opencode/ai"

CompactionPart.make({ provider: ProviderID.make("anthropic"), text: "Summary of the conversation..." })
```

- The trigger is optional (provider default: 150,000 tokens), with a minimum of 50,000.
- Custom instructions replace Anthropic's default summarization instructions.
- The route adds `compact-2026-01-12` to existing beta headers, including when replaying a checkpoint without enabling new compactions.
- A pause is exposed as `response.finishReason.raw === "compaction"`. It occurs only if the threshold triggers compaction: `pauseAfterCompaction` does not mean "compact now". The caller explicitly issues the next request; the package never automatically resumes.
- Anthropic can return a compaction block with `content: null` when summarization fails. This becomes a compaction part with `text: null`, which is **not** a successful replacement for prior history. The package never prunes history automatically.
- `Usage` totals include all reported Anthropic `usage.iterations`, including compaction. `contextTokens` separately reports the final message iteration's inclusive input size, when available. A compaction-only pause does not report a post-compaction context size. Raw iteration usage remains in `providerMetadata`.

## Caching

Prompt caching is **on by default**. Every `LLMRequest` resolves to `cache: "auto"` unless the caller opts out with `cache: "none"`. Each protocol translates `CacheHint`s to its wire format (`cache_control` on Anthropic Messages; OpenAI-style chat endpoints cache implicitly server-side and don't need inline markers — auto is a no-op there).

### Auto placement

`"auto"` places up to four breakpoints — the last tool definition, the first system part, the last system part when distinct, and the final message boundary. These expose successively larger reusable prefixes for tool definitions, system instructions, and the active conversation. The rolling final-message boundary advances on every request so recent conversation prefixes remain reusable during tool loops.

Tools precede every system and conversation block in the provider prefix, so tool definitions must remain byte-stable and deterministically ordered for downstream breakpoints to remain reusable.

Requests below a provider's minimum cacheable size simply do not produce a reusable cache entry.

### Opting out

```ts
LLM.request({
  model,
  system,
  prompt: "one-off question",
  cache: "none",
})
```

### Granular policy

```ts
cache: {
  tools?: boolean,
  system?: boolean,
  messages?: "latest-user-message" | "latest-assistant" | { tail: number },
  ttlSeconds?: number,         // ≥ 3600 → 1h on Anthropic; else 5m
}
```

### Manual hints

Inline `CacheHint` on any text / system / tool / tool-result part overrides automatic placement. The auto policy preserves manual hints, counts them against Anthropic's four-breakpoint limit, and only fills the remaining slots.

```ts
LLM.request({
  model,
  system: [
    { type: "text", text: "stable system prompt", cache: { type: "ephemeral" } },
  ],
  ...
})
```

### Provider behavior table

| Protocol                                  | `cache: "auto"`                                                   |
| ----------------------------------------- | ----------------------------------------------------------------- |
| Anthropic Messages (and Alibaba)          | emits up to 4 `cache_control` markers (4-breakpoint cap enforced) |
| Alibaba Chat                              | emits `cache_control` markers on Qwen models                      |
| OpenAI Chat (DeepSeek, OpenAI-compatible) | no-op (implicit server-side caching)                              |

Normalized cache usage is read back into `response.usage.cacheReadInputTokens` and `cacheWriteInputTokens` across every provider.

## Providers

Provider facades configure endpoint/auth/deployment details first, then expose model selectors that take only a model or deployment id. The selected model carries the executable route value used at runtime.

This fork ships the following providers and nothing else: `Alibaba`, `Anthropic`, `AnthropicCompatible`, `DeepSeek`, and `OpenAICompatible` (the Xiaomi token plan composes `OpenAICompatible`). Each owns its module, endpoint, authentication, and route setup, and providers with the same wire format compose the shared protocol directly. Two protocols carry all of them: OpenAI-style Chat Completions (`OpenAIChat`, `OpenAICompatibleChat`, plus the Alibaba variant) and Anthropic Messages.

### Provider entrypoints

Provider modules are available through dedicated exports from `@opencode/ai`. Each LLM entrypoint exports `model(modelID, settings)`, where `settings` contains provider configuration plus common `headers` and `body` overlays.

```ts
import { model } from "@opencode/ai/providers/alibaba/messages"

const selected = model("qwen3.8-max", {
  region: "ap-southeast-1",
  apiKey: process.env.DASHSCOPE_API_KEY,
  headers: { "x-application": "example" },
})
```

APIs have separate entrypoints:

- `@opencode/ai/providers/alibaba` (also `alibaba/chat` and `alibaba/messages`)
- `@opencode/ai/providers/anthropic`
- `@opencode/ai/providers/anthropic-compatible`
- `@opencode/ai/providers/deepseek`
- `@opencode/ai/providers/openai-compatible`

## Provider options & HTTP overlays

Request options in order of stability:

1. **`generation`** — portable knobs (`maxTokens`, `temperature`, `topP`, `topK`, penalties, seed, stop).
2. **`promptCacheKey`** — stable cache affinity lowered by every protocol that supports it.
3. **`providerOptions: { ... }`** — flat options inferred from the selected model (`reasoningEffort`, Anthropic `thinking`, Alibaba `enableThinking`).
4. **`http: { body, headers, query }`** — last-resort serializable overlays merged into the final HTTP request. Reach for this only when a stable typed path doesn't yet exist.

Route/provider defaults are overridden by request-level values for each axis.

The selected model supplies the provider-specific option type, so per-request overrides stay flat while the canonical runtime request remains provider-neutral:

```ts
LLM.request({
  model,
  prompt,
  providerOptions: {
    reasoningEffort: "low",
  },
})
```

## Routes

Compose a route with `Route.make({ protocol, endpoint, auth, framing, ... })`. The route owns endpoint/auth/framing and the protocol owns body construction plus stream parsing. Transports receive the route's endpoint and auth when preparing requests. Unsupported request shapes fail during protocol lowering.

## Effect

This package is built on Effect. Public methods return `Effect` or `Stream`; provide `AIClient.layer` (or `AIClient.layerWith(executor)`) for every modality, then import the provider/protocol modules for the routes you use. The example at `example/tutorial.ts` is a runnable walkthrough.

## See also

- `AGENTS.md` — architecture, route construction, contributor guide
- `example/tutorial.ts` — runnable end-to-end walkthrough
- `test/provider/*.test.ts` — fixture-first protocol tests; `*.recorded.test.ts` files cover live cassettes
