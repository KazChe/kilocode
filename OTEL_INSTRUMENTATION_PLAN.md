# Kilo Code OTel GenAI Instrumentation Plan

Reference implementation in TypeScript / VS Code extension context for two
OTel GenAI semantic-convention proposals authored by @KazChe:

- [open-telemetry/semantic-conventions#3661](https://github.com/open-telemetry/semantic-conventions/issues/3661)
  Generic Grouping Attributes for Agentic Workflow Spans
- [open-telemetry/semantic-conventions#3662](https://github.com/open-telemetry/semantic-conventions/issues/3662)
  Causal Span Linking for LLM-Triggered Tool Execution

Companion to the Python framework integration tests at
[KazChe/otel-genai-semconv-grouping-causality-prototype](https://github.com/KazChe/otel-genai-semconv-grouping-causality-prototype).
Kilo Code adds a TypeScript / single-process / IDE-extension reference point
that the Python prototype repo does not cover.

## Goals

1. Demonstrate the causality proposal by emitting `execute_tool` spans whose
   parent context comes from the specific LLM stream that triggered them, not
   from the wrapping `streamText` call.
2. Demonstrate the grouping proposal by setting W3C Baggage at the agent-loop
   boundary so `gen_ai.group.id` and `gen_ai.group.iteration.type` propagate
   to all downstream spans.
3. Stay vendor-neutral: emit standard OTel via OTLP so any backend (Phoenix,
   Arize, Galileo, Jaeger, Tempo) can ingest, filter, and group.

## Non-goals (v0)

- Skill detection. Kilo's skills are markdown content the model reads, not
  runtime-orchestrated entities. `gen_ai.group.skill.id` and
  `gen_ai.group.skill.type` are not emitted by Kilo. The grouping proposal
  explicitly allows absent dimensions.
- Span-link-based causality. The causality proposal explicitly argues against
  span links as the recovery mechanism. Parent-child only.
- Re-parenting Vercel AI SDK's existing `ai.toolCall` spans. We layer our
  `execute_tool` span on top and accept span duplication for v0. Reversible.
- Replacing PostHog export. The existing PostHog flow stays. OTLP is added as
  a parallel exporter, opt-in via config.

## Decisions

| Decision | Choice | Notes |
|---|---|---|
| `gen_ai.group.id` semantics | Per-step (Interpretation A) | Matches the proposal's own example (`round-2`). Session identity carried by existing `gen_ai.conversation.id`. |
| `gen_ai.group.iteration.type` value | Both `gen_ai.agent.id` (Kilo agent name, literal) and `gen_ai.group.iteration.type` (generalized taxonomy) | Option (c). Lets backends filter on either. |
| Iteration boundary | One pass through the `while` body in [`SessionPrompt.run`](packages/opencode/src/session/prompt.ts#L1340), indexed by the local `step` integer at [prompt.ts:1349](packages/opencode/src/session/prompt.ts#L1349) | Each pass is one LLM round-trip plus its tool executions. |
| Span links | Not used | Per #3662 stated stance. |
| Vercel AI SDK tool spans | Layer our `execute_tool` span on top, accept duplication | Reversible; revisit after v0. |
| OTLP export | Opt-in via config flag | Default off; existing PostHog flow unchanged. |
| Carrier mechanism | In-memory `Map<toolCallId, SpanContext>` | Single-process, no cross-framework serialization needed. |

## Span hierarchy: before and after

### Before (current state)

```
Effect.fn spans (existing): Session.touch, SessionPrompt.prompt, SessionPrompt.run, ...
└─ ai.streamText (Vercel AI SDK)
   ├─ ai.streamText.doStream  (round 1: model returns tool_call read)
   ├─ ai.toolCall read         ← sibling of doStream, no causal link to round 1
   ├─ ai.streamText.doStream  (round 2: model returns tool_call edit)
   ├─ ai.toolCall edit         ← sibling, no causal link to round 2
   └─ ai.streamText.doStream  (round 3: final answer)
```

Tool execution spans are flat siblings under `ai.streamText`. Reconstructing
which LLM call triggered which tool requires timestamp matching.

### After (target state)

```
SessionPrompt.prompt span                                gen_ai.conversation.id, gen_ai.agent.id,
                                                          gen_ai.group.iteration.type
└─ SessionPrompt.run span                                + (same baggage)
   ├─ step 1                                             gen_ai.group.id = "<sessionID>:step-1"
   │  └─ ai.streamText
   │     ├─ ai.streamText.doStream
   │     │  └─ execute_tool read     (ours)              gen_ai.tool.name, gen_ai.tool.call.id,
   │     │                                                gen_ai.operation.name = execute_tool
   │     └─ ai.toolCall read         (Vercel's, layered)
   ├─ step 2                                             gen_ai.group.id = "<sessionID>:step-2"
   │  └─ ai.streamText
   │     ├─ ai.streamText.doStream
   │     │  └─ execute_tool edit     (ours)
   │     └─ ai.toolCall edit         (Vercel's, layered)
   └─ step 3
      └─ ai.streamText                                   no tool calls; final answer
```

The new `execute_tool` spans are children of the specific `doStream` that
triggered them. Vercel's `ai.toolCall` spans remain where they are; we don't
touch them.

## Attributes emitted

| Attribute | Source | Scope | Value |
|---|---|---|---|
| `gen_ai.conversation.id` | Existing OTel GenAI semconv | Per-turn (set in `SessionPrompt.prompt`) | Kilo `sessionID` |
| `gen_ai.agent.id` | Existing OTel GenAI semconv | Per-turn | Kilo agent name (`code`, `plan`, `explore`, `debug`, `orchestrator`, `ask`) |
| `gen_ai.group.iteration.type` | Proposal #3661 | Per-turn | Generalized taxonomy: `code → code_react`, `plan → plan_execute`, `explore → tool_use`, `debug → debug_react`, `orchestrator → orchestrate`, `ask → ask`. Default `react` if no mapping. |
| `gen_ai.group.id` | Proposal #3661 | Per-step (set inside `while` body) | `"<sessionID>:step-<N>"` for global uniqueness across sessions. Adheres to the proposal (the proposal does not constrain format); the proposal's `round-2` example is illustrative, not normative. |
| `gen_ai.operation.name` | Existing OTel GenAI semconv | Per-tool-execution span | `execute_tool` |
| `gen_ai.tool.name` | Existing OTel GenAI semconv | Per-tool-execution span | The tool ID (`read`, `edit`, `bash`, etc.) |
| `gen_ai.tool.call.id` | Existing OTel GenAI semconv | Per-tool-execution span | The model-assigned tool call ID |
| `gen_ai.tool.call.arguments` | Existing OTel GenAI semconv | Per-tool-execution span (gated by content-capture flag) | Tool arguments as JSON string |
| `gen_ai.tool.call.result` | Existing OTel GenAI semconv | Per-tool-execution span (gated by content-capture flag) | Tool result string |

Skill attributes (`gen_ai.group.skill.id`, `gen_ai.group.skill.type`) are
intentionally absent. See "Non-goals."

## Instrumentation points

Five sites change. File:line references are current as of the branch base
commit; verify before editing.

### 1. [`packages/kilo-telemetry/src/tracer.ts`](packages/kilo-telemetry/src/tracer.ts)

**Add `BaggageSpanProcessor`** alongside the existing `SimpleSpanProcessor`
that exports to PostHog. Without this, baggage set in step 4 below does not
propagate to span attributes automatically.

**Add OTLP exporter** behind a config flag. When enabled, attach a second
`SpanProcessor` (`BatchSpanProcessor` recommended for OTLP) to the same
`NodeTracerProvider`. Both PostHog and OTLP receive the same spans; PostHog
keeps content filtering, OTLP optionally includes content per its own flag.

**New config fields** (additive to `experimental.openTelemetry`):

```ts
experimental.otlpExport: {
  enabled: boolean              // default false
  endpoint: string              // OTLP/HTTP endpoint, e.g. http://localhost:4318/v1/traces
  headers?: Record<string, string>  // for backends like Arize, Galileo that need API keys
  recordContent?: boolean       // default false; when true, include prompts/completions/tool args
}
```

The existing PostHog filtering at [otel-exporter.ts:12-32](packages/kilo-telemetry/src/otel-exporter.ts#L12-L32) is unchanged. The
content-capture decision is per-exporter.

### 2. [`packages/kilo-telemetry/src/`](packages/kilo-telemetry/src/) (new file: `causality-map.ts`)

**Module-level `Map<toolCallId, SpanContext>`** with insert and read APIs.
Lifecycle: insert at carrier-capture point (step 5), read at extract point
(step 4), delete after extract to bound memory. Keys are tool call IDs which
are short-lived (one round of an agent loop), so the map stays small. No
need for periodic cleanup if reads always delete.

```ts
export namespace CausalityCarrier {
  export function capture(toolCallId: string, ctx: SpanContext): void
  export function extract(toolCallId: string): SpanContext | undefined  // also deletes
  export function clear(): void  // for testing
}
```

### 3. [`packages/opencode/src/session/prompt.ts`](packages/opencode/src/session/prompt.ts) — turn-level baggage

**At entry to `SessionPrompt.prompt`** (around [line 1287](packages/opencode/src/session/prompt.ts#L1287), after looking up
`session`), set baggage:

```ts
const ctx = propagation.setBaggage(context.active(), propagation.createBaggage({
  'gen_ai.conversation.id': { value: input.sessionID },
  'gen_ai.agent.id': { value: input.agent },           // assuming agent is on input
  'gen_ai.group.iteration.type': { value: mapAgentToIterationType(input.agent) },
}))
context.with(ctx, () => /* rest of prompt */)
```

The exact wiring may need adjustment for Effect's context model; verify that
OTel context set this way propagates across `Effect.gen` yields. See "Open
questions."

### 4. [`packages/opencode/src/session/prompt.ts`](packages/opencode/src/session/prompt.ts) — step-level baggage

**Inside the `while (true)` body in `runLoop`** at [prompt.ts:1352](packages/opencode/src/session/prompt.ts#L1352),
before the model call, update baggage to include the step ID:

```ts
while (true) {
  const stepId = `${sessionID}:step-${step + 1}`  // step is incremented later, +1 for 1-indexed
  const ctx = propagation.setBaggage(context.active(), updatedBaggageWith({
    'gen_ai.group.id': { value: stepId },
  }))
  yield* context.with(ctx, () => /* rest of step */)
  // ... existing body ...
}
```

### 5. [`packages/opencode/src/session/processor.ts`](packages/opencode/src/session/processor.ts) — carrier capture

**At the `case "tool-call":` block** at [processor.ts:298](packages/opencode/src/session/processor.ts#L298), capture
the active span context (which is the `ai.streamText.doStream` span at this
point) keyed by the tool call ID:

```ts
case "tool-call": {
  CausalityCarrier.capture(value.toolCallId, trace.getSpanContext(context.active())!)
  // ... existing logic ...
}
```

This is the critical sidecar correlation point. The `doStream` span is active
when the tool-call event arrives, so its context is what we capture.

### 6. [`packages/opencode/src/tool/tool.ts`](packages/opencode/src/tool/tool.ts) — execute_tool span

**Inside `Tool.wrap` at [tool.ts:83-112](packages/opencode/src/tool/tool.ts#L83-L112)**, wrap the call to
`execute(args, ctx)` in a new span whose parent is the captured carrier:

```ts
toolInfo.execute = (args, ctx) =>
  Effect.gen(function* () {
    const carrier = ctx.callID ? CausalityCarrier.extract(ctx.callID) : undefined
    const parentCtx = carrier ? trace.setSpanContext(context.active(), carrier) : context.active()

    return yield* Effect.tryPromise(() =>
      tracer.startActiveSpan(
        'execute_tool',
        {
          attributes: {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': id,
            'gen_ai.tool.call.id': ctx.callID,
            // gen_ai.tool.call.arguments: gated on content-capture flag
          },
        },
        parentCtx,
        async (span) => {
          try {
            // existing body: validate args, execute, truncate output
            return await runEffect(/* ... */)
          } finally {
            span.end()
          }
        },
      ),
    )
  })
```

The Effect-OTel boundary needs care here. The actual implementation may need
to use `Effect.acquireRelease` with `tracer.startSpan` + `span.end()` rather
than `startActiveSpan` to fit the Effect generator pattern. Decide during
implementation.

## Open questions

These do not block drafting the plan but must be resolved during
implementation.

### Q1. Does OTel context propagate across Effect.gen yields?

Effect.fn creates spans via Effect's own tracing integration. OTel's default
context manager uses `AsyncLocalStorage` (Node), which generally survives
async function boundaries. Effect runs generators in its own runtime; need to
verify the runtime preserves AsyncLocalStorage across yields. If not, we
need to use Effect's own context propagation primitives or capture/reattach
manually at boundaries.

**Validation step:** before implementing the full plan, write a small test
that sets baggage in an Effect.gen, yields several times (including across an
await), creates a child span, and verifies the baggage is present on the
child span. If yes, the plan as drafted works. If no, we need a different
mechanism for baggage propagation inside Effect.

### Q2. Carrier map cleanup if extract is never called

If a tool call ID is captured but the tool never executes (cancelled, error
during dispatch, etc.), the entry leaks. Extract auto-deletes on read but a
captured-and-never-extracted entry persists. Mitigations:

- TTL on entries (timestamp on capture, periodic sweep)
- Per-session map with cleanup on session close
- Bounded map size with LRU eviction

For v0, accept the leak. Tool call IDs are 30+ characters and rare; even
1000 leaked entries is sub-MB. Revisit if real usage shows growth.

### Q3. Effective parent for `execute_tool` when carrier is missing

If `ctx.callID` is undefined or no carrier was captured (race condition,
manually-invoked tool, etc.), the `execute_tool` span needs a fallback
parent. Options:

- (a) Use the currently active context (would make it a child of whatever's
  on the stack, likely the same place Vercel's ai.toolCall span goes)
- (b) Create as a root span (orphaned in the trace tree)
- (c) Skip span creation entirely

Recommend (a). It degrades gracefully: in the worst case, our span ends up in
the same place as Vercel's ai.toolCall span. The tree is still readable.

### Q4. Iteration type mapping for unknown / custom agents

Kilo allows user-defined agents via config. For built-in agents we have a
fixed mapping table. For user-defined: default to `react` (the most common
agentic pattern) and document that users can override via a future config
attribute (out of scope for v0).

### Q5. Does the existing PostHog `recordInputs: false` decision apply to OTLP?

The Vercel AI SDK telemetry config at [llm.ts:417-418](packages/opencode/src/session/llm.ts#L417-L418) hardcodes
`recordInputs: false, recordOutputs: false`. This is a global config: the AI
SDK will or won't include prompts/completions in spans, and that choice is
seen by all attached exporters.

For OTLP-bound traces, users may want content captured (it's their own
backend, their own data). Options:

- (a) Make the AI SDK content flags configurable
- (b) Always include content in spans, let the PostHog exporter strip
  (matches existing PostHog filter pattern)
- (c) Two TracerProviders: one with content for OTLP, one without for PostHog

**Decision:** option (a). Add a config flag `experimental.otlpExport.recordContent`
and thread it through to the Vercel AI SDK call. **Default ON** when OTLP
export is enabled, so the user sees full content by default in their own
backend. PostHog keeps its defense-in-depth filter at
[otel-exporter.ts:12-32](packages/kilo-telemetry/src/otel-exporter.ts#L12-L32),
so content present in spans is still stripped before send to PostHog.

## Validation strategy

Before merging any code, validate the design with two micro-experiments:

1. **OTel + Effect baggage propagation test.** A 50-line test that sets
   baggage, runs an Effect.gen with multiple yields, and asserts baggage is
   on a child span. Resolves Q1.

2. **Sidecar carrier round-trip test.** A test that simulates a tool call
   ID capture/extract cycle and asserts the parent context resolves
   correctly. Resolves Q2 and Q3 by exercise.

After implementation, validate the demo path:

3. **End-to-end trace visual.** Run a Kilo task locally that exercises
   multiple tool calls (e.g. "read auth.ts, find callers via grep, edit one,
   run tests"). Export OTLP to a local Phoenix or Jaeger. Confirm:
   - `execute_tool` spans are children of the specific `doStream`
   - `gen_ai.group.id` increments per step
   - `gen_ai.agent.id`, `gen_ai.conversation.id`, `gen_ai.group.iteration.type`
     are present on every span in the trace tree
   - Vercel's `ai.toolCall` spans coexist (duplication acknowledged)

## Implementation order (commit-by-commit)

Bottom-up sequencing. Each commit is reviewable in isolation and (commits 1
through 4) does not change user-visible behavior. Behavior changes start at
commit 5.

| # | Commit | Scope | User-visible? |
|---|---|---|---|
| 1 | `docs: add OTel instrumentation plan` | This file | No |
| 2 | `test: validate OTel context propagation through Effect.gen` | Micro-experiment for Q1, lives as a test in `packages/kilo-telemetry/src/__tests__/`. **Blocks commit 3+ until passing.** | No |
| 3 | `feat(telemetry): add BaggageSpanProcessor` | kilo-telemetry/src/tracer.ts | No (no baggage set yet) |
| 4 | `feat(telemetry): add OTLP exporter behind config flag` | kilo-telemetry/src/tracer.ts + new exporter wiring + config schema | No (default off) |
| 5 | `feat(telemetry): add CausalityCarrier module` | New `packages/kilo-telemetry/src/causality-carrier.ts` + tests | No (not wired yet) |
| 6 | `feat(session): set turn-level baggage in SessionPrompt.prompt` | session/prompt.ts; emits `gen_ai.conversation.id`, `gen_ai.agent.id`, `gen_ai.group.iteration.type` on turn-scoped spans | Yes (new attributes appear in OTLP traces if enabled) |
| 7 | `feat(session): set step-level baggage in runLoop` | session/prompt.ts while body; emits `gen_ai.group.id = "<sessionID>:step-<N>"` | Yes |
| 8 | `feat(session): capture LLM/tool-call carrier in processor` | session/processor.ts case "tool-call" | No (capture-only, not extracted yet) |
| 9 | `feat(tool): emit execute_tool span with causal parent` | tool/tool.ts wrap | Yes — capstone; causality tree appears in OTLP traces |
| 10 | `feat(telemetry): thread recordContent flag to Vercel AI SDK` | session/llm.ts, kilo-telemetry config | Yes (when otlpExport.recordContent=true) |
| 11 | `docs(telemetry): OTLP configuration recipe` | README in kilo-telemetry or top-level | No |

If commit 2 fails (Effect does not preserve OTel context across yields), the
plan needs revision before commits 3+ proceed. See Q1.

## References

- Filed proposals
  - [#3661 Generic Grouping Attributes for Agentic Workflow Spans](https://github.com/open-telemetry/semantic-conventions/issues/3661)
  - [#3662 Causal Span Linking for LLM-Triggered Tool Execution](https://github.com/open-telemetry/semantic-conventions/issues/3662)
- Local working copies
  - `/Users/kam/development/OTEL/oss-contrib-prototypes/ISSUE_GROUPING.md`
  - `/Users/kam/development/OTEL/oss-contrib-prototypes/ISSUE_CAUSALITY.md`
- Python framework integration tests
  - [KazChe/otel-genai-semconv-grouping-causality-prototype](https://github.com/KazChe/otel-genai-semconv-grouping-causality-prototype)
- Existing Kilo telemetry foundation
  - [packages/kilo-telemetry/src/tracer.ts](packages/kilo-telemetry/src/tracer.ts)
  - [packages/kilo-telemetry/src/otel-exporter.ts](packages/kilo-telemetry/src/otel-exporter.ts)
- Key Kilo runtime files
  - Agent loop: [packages/opencode/src/session/prompt.ts](packages/opencode/src/session/prompt.ts) (`SessionPrompt.run` at L1340)
  - Stream event handling: [packages/opencode/src/session/processor.ts](packages/opencode/src/session/processor.ts) (`case "tool-call":` at L298)
  - LLM call site: [packages/opencode/src/session/llm.ts](packages/opencode/src/session/llm.ts) (`streamText` at L338)
  - Tool wrap: [packages/opencode/src/tool/tool.ts](packages/opencode/src/tool/tool.ts) (`Tool.wrap` at L83)
