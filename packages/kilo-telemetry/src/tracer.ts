import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { BatchSpanProcessor, SimpleSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-base"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions"
import type { Tracer } from "@opentelemetry/api"
import { BaggageSpanProcessor } from "@opentelemetry/baggage-span-processor"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { PostHogSpanExporter } from "./otel-exporter.js"
import { Client } from "./client.js"

// Filter for baggage entries that get copied onto spans by BaggageSpanProcessor.
// Limited to the gen_ai.* namespace so unrelated baggage (e.g. set by other
// libraries or by upstream HTTP headers) does not leak onto our spans.
// See OTel GenAI semconv proposal #3661 for the namespace.
const BAGGAGE_KEY_FILTER = (key: string) => key.startsWith("gen_ai.")

let provider: NodeTracerProvider | null = null
let exporter: PostHogSpanExporter | null = null
let tracer: Tracer | null = null

export namespace TracerSetup {
  export function init(options: {
    version: string
    enabled: boolean
    appName: string
    platform: string
    editorName?: string
    vscodeVersion?: string
    otlpExport?: {
      enabled?: boolean
      endpoint?: string
      headers?: Record<string, string>
      recordContent?: boolean
    }
  }): Tracer {
    if (tracer) return tracer

    const client = Client.getClient()
    if (!client) {
      throw new Error("PostHog client not initialized. Call Client.init() first.")
    }

    exporter = new PostHogSpanExporter(client, {
      appName: options.appName,
      appVersion: options.version,
      platform: options.platform,
      editorName: options.editorName,
      vscodeVersion: options.vscodeVersion,
    })
    exporter.setEnabled(options.enabled)

    // BaggageSpanProcessor must precede the exporter processors so baggage
    // entries (e.g. gen_ai.group.id) are copied onto span attributes before
    // export. Filtered to the gen_ai.* namespace.
    const spanProcessors: SpanProcessor[] = [
      new BaggageSpanProcessor(BAGGAGE_KEY_FILTER),
      new SimpleSpanProcessor(exporter),
    ]

    // Optionally add an OTLP exporter for vendor-neutral GenAI observability
    // (Phoenix, Arize, Galileo, Jaeger, Tempo, etc). PostHog flow above is
    // unaffected; both exporters see the same enriched spans.
    if (options.otlpExport?.enabled) {
      if (!options.otlpExport.endpoint) {
        console.warn(
          "[kilo-telemetry] experimental.otlp_export.enabled=true but otlp_export.endpoint is missing; skipping OTLP exporter setup.",
        )
      } else {
        const otlpExporter = new OTLPTraceExporter({
          url: options.otlpExport.endpoint,
          headers: options.otlpExport.headers,
        })
        spanProcessors.push(new BatchSpanProcessor(otlpExporter))
      }
    }

    provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: options.appName,
        [ATTR_SERVICE_VERSION]: options.version,
      }),
      spanProcessors,
    })

    // Register the provider globally so all tracers use our exporter
    provider.register()

    // Get tracer from our provider
    tracer = provider.getTracer(options.appName, options.version)

    return tracer
  }

  export function getTracer(): Tracer | null {
    return tracer
  }

  export function setEnabled(value: boolean) {
    exporter?.setEnabled(value)
  }

  export async function shutdown(): Promise<void> {
    if (provider) {
      await provider.shutdown()
      provider = null
      tracer = null
      exporter = null
    }
  }
}
