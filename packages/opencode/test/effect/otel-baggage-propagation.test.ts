/**
 * Validation experiment for OTel baggage propagation through Effect.gen.
 *
 * Validates the assumption that powers the grouping side of the planned
 * OTel GenAI instrumentation (see OTEL_INSTRUMENTATION_PLAN.md, Q1).
 *
 * Question under test: when baggage is set in OTel context and an Effect
 * generator yields multiple times (including across an Effect.fn span and
 * across awaits), is the baggage still readable from `context.active()`
 * inside the generator?
 *
 * If yes: the planned grouping mechanism (set baggage at SessionPrompt.prompt
 * entry, read via BaggageSpanProcessor at span emission) works as designed.
 * If no: grouping needs manual capture/reattach at every Effect boundary,
 * a much larger code surface.
 *
 * Mirrors the production setup in src/effect/observability.ts which registers
 * AsyncLocalStorageContextManager to bridge the @effect/opentelemetry tracer
 * provider with the global @opentelemetry/api context.
 */

import { beforeAll, describe, expect, test } from "bun:test"
import { context, propagation, trace } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { Effect } from "effect"

beforeAll(() => {
  const mgr = new AsyncLocalStorageContextManager()
  mgr.enable()
  context.setGlobalContextManager(mgr)
})

function readGroupId(): string | undefined {
  return propagation.getBaggage(context.active())?.getEntry("gen_ai.group.id")?.value
}

function withGroupId<T>(value: string, fn: () => T): T {
  const baggage = propagation.createBaggage({
    "gen_ai.group.id": { value },
  })
  const ctx = propagation.setBaggage(context.active(), baggage)
  return context.with(ctx, fn)
}

describe("OTel baggage survives Effect.gen yields", () => {
  test("baggage is readable after a single Effect.sync yield", async () => {
    const observed = await withGroupId("step-1", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.sync(() => "noop")
          return readGroupId()
        }),
      ),
    )
    expect(observed).toBe("step-1")
  })

  test("baggage is readable after multiple yields including a sleep", async () => {
    const observed = await withGroupId("step-2", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.sleep("1 millis")
          yield* Effect.sync(() => "intermediate")
          yield* Effect.sleep("1 millis")
          return readGroupId()
        }),
      ),
    )
    expect(observed).toBe("step-2")
  })

  test("baggage is readable inside an Effect.fn span", async () => {
    const inner = Effect.fn("Test.inner")(function* () {
      return readGroupId()
    })
    const observed = await withGroupId("step-3", () => Effect.runPromise(inner()))
    expect(observed).toBe("step-3")
  })

  test("baggage is readable after Effect.promise resolves", async () => {
    const observed = await withGroupId("step-4", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() => Promise.resolve("async-work"))
          return readGroupId()
        }),
      ),
    )
    expect(observed).toBe("step-4")
  })

  test("nested context.with allows baggage updates that scope correctly", async () => {
    const result = await withGroupId("outer", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const before = readGroupId()
          const inner = yield* Effect.sync(() => {
            // Mid-effect baggage update, mirroring step-level baggage update inside a turn
            const updated = propagation.createBaggage({
              "gen_ai.group.id": { value: "inner" },
            })
            const ctx = propagation.setBaggage(context.active(), updated)
            return context.with(ctx, () => readGroupId())
          })
          const after = readGroupId()
          return { before, inner, after }
        }),
      ),
    )
    expect(result.before).toBe("outer")
    expect(result.inner).toBe("inner")
    expect(result.after).toBe("outer")
  })

  test("baggage propagates to a span created via the global tracer", async () => {
    // This test validates the path that AI SDK and our future execute_tool span will use:
    // tracer.startActiveSpan() reads context.active() to find the parent. If baggage rides
    // along on that context, BaggageSpanProcessor (when added) can copy it onto the span.
    const tracer = trace.getTracer("test")
    let observedOnSpan: string | undefined

    await withGroupId("step-5", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            tracer.startActiveSpan("child", (span) => {
              observedOnSpan = readGroupId()
              span.end()
            })
          })
        }),
      ),
    )

    expect(observedOnSpan).toBe("step-5")
  })
})

describe("OTel baggage set INSIDE an Effect propagates to nested Effects (Q1b)", () => {
  // Production-shaped test. SessionPrompt.prompt is itself an Effect.fn. We need to set
  // baggage at its entry, then have that baggage visible inside deeper Effect.fn calls
  // (the agent loop, tool execution, etc.). The bracketing pattern below is what we'd
  // use in production. If this test passes, the plan's baggage strategy is viable.

  function withBaggage<A, E>(values: Record<string, string>, eff: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return Effect.callback<A, E>((resume) => {
      const previousContext = context.active()
      const existing = propagation.getBaggage(previousContext) ?? propagation.createBaggage()
      let merged = existing
      for (const [key, value] of Object.entries(values)) {
        merged = merged.setEntry(key, { value })
      }
      const newContext = propagation.setBaggage(previousContext, merged)
      context.with(newContext, () => {
        Effect.runPromise(eff).then(
          (v) => {
            // Restore outer context before resuming so the surrounding Effect
            // sees its own baggage, not the inner scope's overrides.
            context.with(previousContext, () => resume(Effect.succeed(v)))
          },
          (e) => {
            context.with(previousContext, () => resume(Effect.die(e)))
          },
        )
      })
    })
  }

  test("baggage set inside outer Effect.fn is visible in nested Effect.fn", async () => {
    let observed: string | undefined

    const inner = Effect.fn("Test.q1b.inner")(function* () {
      yield* Effect.sleep("1 millis")
      observed = readGroupId()
    })

    const outer = Effect.fn("Test.q1b.outer")(function* () {
      yield* withBaggage({ "gen_ai.group.id": "from-outer-effect" }, inner())
    })

    await Effect.runPromise(outer())
    expect(observed).toBe("from-outer-effect")
  })

  test("baggage update mid-Effect overrides outer baggage in scope, then restores", async () => {
    // Mirrors step-level baggage update: turn sets group.id once at entry; runLoop
    // re-sets it per step. After the step, outer baggage should still be visible.
    const trace_: { stage: string; value: string | undefined }[] = []

    const innerStep = Effect.fn("Test.q1b.step")(function* () {
      yield* Effect.sleep("1 millis")
      trace_.push({ stage: "inside-step", value: readGroupId() })
    })

    const turn = Effect.fn("Test.q1b.turn")(function* () {
      yield* Effect.sleep("1 millis")
      trace_.push({ stage: "turn-before-step", value: readGroupId() })
      yield* withBaggage({ "gen_ai.group.id": "step-1" }, innerStep())
      trace_.push({ stage: "turn-after-step", value: readGroupId() })
    })

    await withGroupId("conversation-baggage", () =>
      Effect.runPromise(withBaggage({ "gen_ai.conversation.id": "conv-1", "gen_ai.group.id": "turn-1" }, turn())),
    )

    expect(trace_).toEqual([
      { stage: "turn-before-step", value: "turn-1" },
      { stage: "inside-step", value: "step-1" },
      { stage: "turn-after-step", value: "turn-1" },
    ])
  })
})
