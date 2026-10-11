# Session LLM Runtime Boundaries

`../llm.ts` is the opencode session LLM service. It owns opencode concerns: config, model/provider resolution, plugins, telemetry headers, and the AI SDK call. It is the only file in this area that should know about the full session request shape.

This folder contains adapters behind that service boundary:

- `request.ts` prepares one provider turn: system prompt, plugin hooks (`chat.params`, `chat.headers`), options merge, tool filtering, and request headers.
- `ai-sdk.ts` converts AI SDK `fullStream` parts into `@opencode-ai/llm` `LLMEvent`s.

## File Structure

```txt
src/session/
  llm.ts                    session-owned orchestration and the streamText call
  llm/
    AGENTS.md               boundary notes for the adapter layer
    request.ts              per-turn request preparation
    ai-sdk.ts               AI SDK fullStream -> @opencode-ai/llm LLMEvent adapter
```

Integration points:

- `../llm.ts` calls `LLMRequestPrep.prepare(...)`, then `streamText(...)` locally, and adapts `result.fullStream` into shared `LLMEvent`s with `LLMAISDK`.
- The session processor consumes the `LLMEvent` stream and does not know which SDK produced it.
