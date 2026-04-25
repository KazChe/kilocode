import type { Context } from "@opentelemetry/api"

/**
 * Maps LLM-assigned tool call IDs to captured OTel contexts so an
 * `execute_tool` span can be parented to the specific LLM stream span that
 * triggered the tool call.
 *
 * Use sites (wired in commits 9 and 10):
 *
 * - capture: session/processor.ts on the "tool-call" stream event,
 *   storing the active OTel context (which at that moment is the
 *   ai.streamText.doStream span) keyed by the model-assigned tool call ID.
 * - extract: tool/tool.ts inside Tool.wrap, reading the carrier keyed by
 *   Tool.Context.callID and using it as parent context for the new
 *   execute_tool span.
 *
 * Lifecycle: extract auto-deletes on read to bound memory. If a tool call
 * is captured but never executes (cancellation, dispatch error), the entry
 * leaks. For v0 we accept the leak. Tool call IDs are 30+ char strings and
 * tool call counts per session are bounded; even thousands of leaked entries
 * is sub-MB. See OTEL_INSTRUMENTATION_PLAN.md Q2.
 *
 * Single-process scope: this is an in-memory module-level Map. The OTel
 * GenAI causality proposal (open-telemetry/semantic-conventions#3662) calls
 * this the "out-of-band correlation" pattern, used when no native sidecar
 * field exists on the framework's tool call object. Kilo's tool layer
 * exposes Tool.Context.callID which is exactly the correlation key the
 * proposal recommends.
 */
export namespace CausalityCarrier {
  const carriers = new Map<string, Context>()

  /**
   * Store an OTel context keyed by the model-assigned tool call ID. Typically
   * called at the moment a "tool-call" stream event is observed, with
   * `context.active()` as the value.
   */
  export function capture(toolCallId: string, ctx: Context): void {
    carriers.set(toolCallId, ctx)
  }

  /**
   * Read and remove the captured context for the given tool call ID. Returns
   * undefined if no context was captured (e.g. the tool was invoked outside
   * an LLM-driven tool call, or capture/extract are racing).
   *
   * Auto-deletes on read so the carrier map stays bounded under normal flow.
   */
  export function extract(toolCallId: string): Context | undefined {
    const ctx = carriers.get(toolCallId)
    if (ctx !== undefined) {
      carriers.delete(toolCallId)
    }
    return ctx
  }

  /** Remove all captured carriers. Intended for tests. */
  export function clear(): void {
    carriers.clear()
  }

  /** Number of currently captured carriers. Intended for tests and monitoring. */
  export function size(): number {
    return carriers.size
  }
}
