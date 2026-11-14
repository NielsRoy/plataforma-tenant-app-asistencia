/**
 * Métricas OpenTelemetry del backend.
 *
 * Se activa con OTEL_ENABLED=true (en las EC2 de los tenants). Mide automáticamente
 * las peticiones HTTP (latencia y código de respuesta) y las consultas a PostgreSQL,
 * y envía las métricas por OTLP al OpenTelemetry Collector local de la máquina
 * (http://localhost:4318). Prometheus las lee desde el collector.
 *
 * Debe importarse antes que cualquier otro módulo: la instrumentación funciona
 * interceptando la carga de http, express y pg.
 */
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';

export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OTEL_ENABLED ?? '').trim().toLowerCase() === 'true';
}

function startTelemetry(): NodeSDK | undefined {
  if (!telemetryEnabled()) return undefined;

  // Solo métricas: no hay backend de trazas ni de logs en esta arquitectura.
  process.env.OTEL_TRACES_EXPORTER ??= 'none';
  process.env.OTEL_LOGS_EXPORTER ??= 'none';
  // Convenciones HTTP estables: http.server.request.duration (segundos) con http.response.status_code.
  process.env.OTEL_SEMCONV_STABILITY_OPT_IN ??= 'http';

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';
  const intervalMs = Number(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 15000);

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME ?? 'asistencia-api',
      'service.version': process.env.APP_VERSION ?? 'dev',
    }),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/metrics` }),
        exportIntervalMillis: intervalMs,
      }),
    ],
    instrumentations: [
      new HttpInstrumentation({
        // El health check se consulta cada pocos segundos y distorsionaría la latencia
        ignoreIncomingRequestHook: (request) => request.url?.startsWith('/api/health') ?? false,
      }),
      new ExpressInstrumentation(),
      new PgInstrumentation(),
    ],
  });

  // NestJS (enableShutdownHooks) gestiona SIGTERM; perder el último intervalo de
  // métricas al detener el servicio no es relevante, así que no se registran señales aquí.
  sdk.start();
  return sdk;
}

export const telemetry = startTelemetry();
