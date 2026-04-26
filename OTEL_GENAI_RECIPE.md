# OTel GenAI semconv recipe (Kilo Code reference impl)

Get traces flowing from this Kilo Code fork into a local OTLP backend so you can see the [`gen_ai.*`](https://github.com/open-telemetry/semantic-conventions/tree/main/docs/gen-ai) attributes proposed in:

- [open-telemetry/semantic-conventions#3661](https://github.com/open-telemetry/semantic-conventions/issues/3661): Generic Grouping Attributes
- [open-telemetry/semantic-conventions#3662](https://github.com/open-telemetry/semantic-conventions/issues/3662): Causal Span Linking

For architecture and design rationale, see [OTEL_INSTRUMENTATION_PLAN.md](OTEL_INSTRUMENTATION_PLAN.md).

## Prerequisites

- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
- Docker (for running Phoenix locally)
- This fork on branch `feat/otel-genai-causality-grouping`

## 1. Start an OTLP backend

[Arize Phoenix](https://github.com/Arize-ai/phoenix) works out of the box:

```bash
docker run --rm -p 6006:6006 -p 4317:4317 -p 4318:4318 \
  --name phoenix arizephoenix/phoenix:latest
```

Phoenix UI: http://localhost:6006. Any OTLP/HTTP receiver that accepts protobuf works (Jaeger, Tempo, hosted vendors). The exporter sends `application/x-protobuf`, not JSON.

## 2. Configure Kilo

Create the global config dir (if it doesn't exist) and add `kilo.jsonc`:

```bash
mkdir -p ~/.config/kilo
```

Then edit `~/.config/kilo/kilo.jsonc`:

```jsonc
{
  "experimental": {
    "otlp_export": {
      "enabled": true,
      "endpoint": "http://localhost:6006/v1/traces"
      // "headers": { "Authorization": "Bearer ..." },  // for hosted vendors
      // "record_content": false                         // include prompts/completions in traces
    }
  }
}
```

## 3. Run Kilo

```bash
git clone -b feat/otel-genai-causality-grouping https://github.com/KazChe/kilocode.git
cd kilocode
bun install
PATH="$HOME/.bun/bin:$PATH" bun run dev run "list the files in this directory"
```

Open Phoenix at http://localhost:6006 and look for spans named `ai.streamText`, `ai.streamText.doStream`, and `execute_tool`.

> **Important:** use `bun run dev run`, not `kilo run`. If the Kilo VS Code extension is installed, it runs its own `kilo serve` daemon in the background, and `kilo run` attaches to that daemon instead of this fork's source, so your prompts execute through the released, uninstrumented code path and no traces flow. To clear any orphan daemon:
>
> ```bash
> pkill -f "kilo serve"   # or: ps aux | grep "kilo serve"  →  kill <pid>
> ```

## 4. What to look for

On the LLM and tool spans, you should see:

- `gen_ai.conversation.id`: stable per session (#3661 turn boundary)
- `gen_ai.group.id`: `<sessionID>:step-<N>` (#3661 step boundary)
- `gen_ai.agent.id` and `gen_ai.group.iteration.type` (e.g. `code_react`)
- `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.operation.name=execute_tool`

Causality (#3662): the `execute_tool` span's parent is the LLM span that requested the tool call, even though execution happens out-of-band (parent captured in `processor.ts`, replayed in `tool.ts` via the `CausalityCarrier` map keyed by `tool_call_id`).

## 5. Troubleshooting

**No traces in Phoenix?**

Enable OTel SDK diagnostic logs (canonical first check):

```ts
// e.g. near the top of packages/kilo-telemetry/src/tracer.ts
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api"
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG)
```

This prints exporter activity, batch flushes, and HTTP errors (e.g. the 415 you'll see if you point at a backend that needs `-proto`).

**TUI swallowing your `console.log`?** Write to a file instead:

```ts
import fs from "node:fs"
fs.appendFileSync("/tmp/kilo-otel-debug.log", `[baggage] ${JSON.stringify(values)}\n`)
```

Drop this near a span boundary you care about. `LLM.run` immediately before `streamText({...})` is a good entry point for verifying turn/step baggage; `tool.ts` inside the `execute_tool` span is the spot for verifying causal parent capture. Then `tail -f /tmp/kilo-otel-debug.log`.
