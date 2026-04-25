import z from "zod"
import { Cause, Effect, Exit } from "effect"
import { context, SpanStatusCode } from "@opentelemetry/api" // kilocode_change - execute_tool span
import { CausalityCarrier, Telemetry } from "@kilocode/kilo-telemetry" // kilocode_change - execute_tool span
import type { MessageV2 } from "../session/message-v2"
import type { Permission } from "../permission"
import type { SessionID, MessageID } from "../session/schema"
import * as Truncate from "./truncate"
import { Agent } from "@/agent/agent"

interface Metadata {
  [key: string]: any
}

// TODO: remove this hack
export type DynamicDescription = (agent: Agent.Info) => Effect.Effect<string>

export type Context<M extends Metadata = Metadata> = {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: { [key: string]: unknown }
  messages: MessageV2.WithParts[]
  metadata(input: { title?: string; metadata?: M }): Effect.Effect<void>
  ask(input: Omit<Permission.Request, "id" | "sessionID" | "tool">): Effect.Effect<void>
}

export interface ExecuteResult<M extends Metadata = Metadata> {
  title: string
  metadata: M
  output: string
  attachments?: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[]
}

export interface Def<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
  id: string
  description: string
  parameters: Parameters
  execute(args: z.infer<Parameters>, ctx: Context): Effect.Effect<ExecuteResult<M>>
  formatValidationError?(error: z.ZodError): string
}
export type DefWithoutID<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> = Omit<
  Def<Parameters, M>,
  "id"
>

export interface Info<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
  id: string
  init: () => Effect.Effect<DefWithoutID<Parameters, M>>
}

type Init<Parameters extends z.ZodType, M extends Metadata> =
  | DefWithoutID<Parameters, M>
  | (() => Effect.Effect<DefWithoutID<Parameters, M>>)

export type InferParameters<T> =
  T extends Info<infer P, any> ? z.infer<P> : T extends Effect.Effect<Info<infer P, any>, any, any> ? z.infer<P> : never
export type InferMetadata<T> =
  T extends Info<any, infer M> ? M : T extends Effect.Effect<Info<any, infer M>, any, any> ? M : never

export type InferDef<T> =
  T extends Info<infer P, infer M>
    ? Def<P, M>
    : T extends Effect.Effect<Info<infer P, infer M>, any, any>
      ? Def<P, M>
      : never

function wrap<Parameters extends z.ZodType, Result extends Metadata>(
  id: string,
  init: Init<Parameters, Result>,
  truncate: Truncate.Interface,
  agents: Agent.Interface,
) {
  return () =>
    Effect.gen(function* () {
      const toolInfo = typeof init === "function" ? { ...(yield* init()) } : { ...init }
      const execute = toolInfo.execute
      toolInfo.execute = (args, ctx) => {
        // kilocode_change start - execute_tool span (OTel GenAI causality, #3662)
        //
        // Replaces the previous `Effect.withSpan("Tool.execute")` with a span
        // emitted via kilo-telemetry's NodeTracerProvider so the
        // BaggageSpanProcessor (commit 4) copies turn-level baggage onto the
        // span as attributes (gen_ai.conversation.id, gen_ai.agent.id,
        // gen_ai.group.iteration.type from commit 7).
        //
        // Parent context is the carrier captured in
        // session/processor.ts case "tool-call" (commit 9) keyed by the
        // model-assigned tool call ID. This is the proposal's out-of-band
        // correlation pattern, recovering the parent-child causal link from
        // the LLM call to the tool execution. Falls back to context.active()
        // when no carrier is captured (e.g. tool invoked outside an LLM-driven
        // flow). See "Instrumentation roles and proposal alignment" in
        // OTEL_INSTRUMENTATION_PLAN.md.
        const attrs = {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": id,
          ...(ctx.callID ? { "gen_ai.tool.call.id": ctx.callID } : {}),
          "session.id": ctx.sessionID,
          "message.id": ctx.messageID,
        }
        // kilocode_change end

        const body = Effect.gen(function* () {
          yield* Effect.try({
            try: () => toolInfo.parameters.parse(args),
            catch: (error) => {
              if (error instanceof z.ZodError && toolInfo.formatValidationError) {
                return new Error(toolInfo.formatValidationError(error), { cause: error })
              }
              return new Error(
                `The ${id} tool was called with invalid arguments: ${error}.\nPlease rewrite the input so it satisfies the expected schema.`,
                { cause: error },
              )
            },
          })
          const result = yield* execute(args, ctx)
          if (result.metadata.truncated !== undefined) {
            return result
          }
          const agent = yield* agents.get(ctx.agent)
          const truncated = yield* truncate.output(result.output, {}, agent)
          return {
            ...result,
            output: truncated.content,
            metadata: {
              ...result.metadata,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
        }).pipe(Effect.orDie)

        // kilocode_change start - bracket body with execute_tool span lifecycle
        return Effect.acquireUseRelease(
          Effect.sync(() => {
            const tracer = Telemetry.getTracer()
            if (!tracer) return undefined
            const carrier = ctx.callID ? CausalityCarrier.extract(ctx.callID) : undefined
            const parent = carrier ?? context.active()
            return tracer.startSpan("execute_tool", { attributes: attrs }, parent)
          }),
          () => body,
          (span, exit) =>
            Effect.sync(() => {
              if (!span) return
              if (Exit.isFailure(exit)) {
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: Cause.pretty(exit.cause),
                })
              }
              span.end()
            }),
        )
        // kilocode_change end
      }
      return toolInfo
    })
}

export function define<Parameters extends z.ZodType, Result extends Metadata, R, ID extends string = string>(
  id: ID,
  init: Effect.Effect<Init<Parameters, Result>, never, R>,
): Effect.Effect<Info<Parameters, Result>, never, R | Truncate.Service | Agent.Service> & { id: ID } {
  return Object.assign(
    Effect.gen(function* () {
      const resolved = yield* init
      const truncate = yield* Truncate.Service
      const agents = yield* Agent.Service
      return { id, init: wrap(id, resolved, truncate, agents) }
    }),
    { id },
  )
}

export function init<P extends z.ZodType, M extends Metadata>(info: Info<P, M>): Effect.Effect<Def<P, M>> {
  return Effect.gen(function* () {
    const init = yield* info.init()
    return {
      ...init,
      id: info.id,
    }
  })
}
