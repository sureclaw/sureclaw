// src/utils/tracing.ts — OpenTelemetry SDK initialization (lazy-loaded)
import { trace, type Tracer } from '@opentelemetry/api';

let initialized = false;

/**
 * Starts the OTel SDK if OTEL_EXPORTER_OTLP_ENDPOINT is set.
 * Lazy-loads the heavy SDK packages so there's zero import cost when tracing
 * is disabled.
 */
export async function initTracing(): Promise<void> {
  if (initialized || !isTracingEnabled()) return;
  initialized = true;

  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');

  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'ax',
    traceExporter: new OTLPTraceExporter({
      url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
    }),
  });

  sdk.start();
}

/** Returns the shared AX tracer. No-op tracer when SDK is not registered. */
export function getTracer(): Tracer {
  return trace.getTracer('ax');
}

/** True when the OTLP endpoint env var is set. */
export function isTracingEnabled(): boolean {
  return !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
}
