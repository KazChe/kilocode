import { context, propagation } from "@opentelemetry/api"
import { Effect } from "effect"

/**
 * Brackets an Effect with OTel baggage values. Baggage entries are merged
 * with whatever is in the surrounding context (so callers can layer
 * step-level baggage on top of turn-level baggage without losing the latter)
 * and the outer context is restored on exit so scoping is clean.
 *
 * Implementation: synchronously activates a new OTel context via
 * `context.with(...)` and starts the inner Effect via `Effect.runPromise`
 * inside that scope. AsyncLocalStorage (registered globally in
 * `src/effect/observability.ts`) carries the active OTel context across the
 * runPromise boundary, so spans and yields inside `eff` see the new baggage.
 * On completion, `resume()` is wrapped in `context.with(previousContext, ...)`
 * so the surrounding Effect resumes with its own baggage, not the inner
 * scope's overrides.
 *
 * Limitation (R = never): Effect 4 does not expose a way to capture the
 * current runtime from within an `Effect.callback` register, so we cannot
 * use `Runtime.runPromise(rt)(eff)` to satisfy R-requirements of the inner
 * Effect. The Effect.async-replacement pattern that DOES propagate
 * AsyncLocalStorage (Effect.runPromise + .then) requires R = never.
 * Callers must pre-resolve dependencies via `Effect.provide(layer)` on the
 * inner Effect before passing, or wrap at the outer boundary where R has
 * already been satisfied.
 *
 * For turn-level baggage in production, prefer setting OTel context at the
 * boundary where Kilo invokes Effect.runPromise (e.g. the exported
 * `prompt = (input) => runPromise(...)` wrapper at session/prompt.ts L1971),
 * not inside an Effect.fn body. The Q1a tests show that pattern propagates
 * cleanly via AsyncLocalStorage.
 *
 * Validated by packages/opencode/test/effect/otel-baggage-propagation.test.ts
 * (Q1a + Q1b in OTEL_INSTRUMENTATION_PLAN.md).
 */
export function withBaggage<A, E>(
  values: Record<string, string>,
  eff: Effect.Effect<A, E>,
): Effect.Effect<A, E> {
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
          context.with(previousContext, () => resume(Effect.succeed(v)))
        },
        (e) => {
          context.with(previousContext, () => resume(Effect.die(e)))
        },
      )
    })
  })
}
