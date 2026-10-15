# AI Package Guide

## Fork scope

This fork ships the Alibaba, DeepSeek and `xiaomi-token-plan-cn` vendors only (ADR 0005, ADR 0006), carried by two protocol families: OpenAI-style Chat Completions and Anthropic Messages. Every other provider, protocol and SDK dependency is deleted, not disabled; their replay cassettes are the one exception and stay in the tree (see Known limitations). The generic frameworks (routes, schema, tools, and the image/video/speech/transcription modality contracts) stay as upstream has them even where no bundled route uses them. When a merge from upstream touches a deleted provider or protocol file, resolve it with `git rm`.

## Principles

- **Forward compatibility.** Providers ship new models, options, and values constantly. Accept unknown pass-through values (`Known | (string & {})` for string options); use closed literals only when OpenCode branches on the value.
- **One canonical model.** The Schema classes in `src/schema/` are the data model. Do not add a parallel shape or a second construction path.
- **Independent of Session.** Auth, permissions, plugins, and orchestration belong in Core. `LLM.stream`/`LLM.generate` run exactly one model call.
- **Reuse protocols.** Providers compose existing protocols with `Route.make(...)` instead of cloning them.

## Code style

- Use `HttpClient`, `Stream`, and Schema codecs instead of `fetch`, async generators, and `JSON.parse`/`JSON.stringify`.
- `return yield* new MyError(...)` instead of `Effect.fail(...)`; `Effect.void` instead of `Effect.succeed(undefined)`.
- Only `src/promise.ts` may use Promises.

## Tests

- Use `testEffect(...)` from `test/lib/effect.ts` for tests that need Effect layers.
- Provider tests replay cassettes: recorded HTTP exchanges stored as JSON in `test/fixtures/recordings/`, one file per scenario. Replay is the default and needs no API keys.
- To record, unset `CI` and run with `RECORD=true` plus the provider's API key. Re-record only the cassette you are changing; recordings contain volatile IDs that create noisy diffs.

## Known limitations

- **Replay cassettes for deleted providers remain in the tree.** `test/fixtures/recordings/` holds 69 cassette directories (226 files, ~14 MB), but only four are loaded: the `prefix:` values in `test/provider/*.recorded.test.ts` are `alibaba-chat`, `alibaba-messages`, `anthropic-messages` and `anthropic-messages-cache`. The rest belong to providers and protocol families this fork deleted. They are kept rather than deleted because removing 65 upstream-tracked directories buys 65 recurring `deleted by us` conflicts in the merge-based sync for no test-visible gain.
- **The golden scenario harness is dead in this fork.** `test/recorded-golden.ts` has no importer, so the scenario ids it drives are never selected; two recorded test files still import helper constants from `test/recorded-scenarios.ts`, which is why that file stays. Nothing in the default `bun test` run exercises the golden path.
- **A cassette proves the wire shape at record time, not the provider's current API.** Replay is the default mode, so a provider-side change stays invisible until the cassette is re-recorded, and recording needs the provider's API key with `CI` unset (`test/recorded-test.ts:87`).
- **Modality contracts are carried, not exercised against a live provider.** `image-client.ts`, `video-client.ts`, `speech-client.ts` and `transcription-client.ts` keep their upstream shape and no bundled route in this fork produces them, so only scripted or recorded fixture tests cover them.
