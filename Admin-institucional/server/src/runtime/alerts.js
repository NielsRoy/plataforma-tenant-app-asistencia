const express = require('express');
const { createHash, timingSafeEqual } = require('node:crypto');

// Alertas del monitoreo (RF-28, RF-29).
//   POST /api/platform/alerts/webhook   lo llama Grafana (contact point "plataforma").
//                                       Se autentica con PLATFORM_ALERTS_TOKEN, no con la
//                                       sesión del operador.
//   GET  /api/platform/alerts           para la interfaz (con sesión): ?status=firing|resolved
//                                       &tenant=<slug>&limit=N

const digest = (value) => createHash('sha256').update(value).digest();
const zeroDate = /^0001-01-01/;

function validToken(header) {
  const expected = process.env.PLATFORM_ALERTS_TOKEN?.trim();
  if (!expected || expected.length < 32) return null;
  const supplied = /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1] ?? '';
  return timingSafeEqual(digest(supplied), digest(expected));
}

function text(value, max) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function date(value) {
  if (typeof value !== 'string' || zeroDate.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Payload del contact point webhook de Grafana: { status, alerts: [{ status, labels,
// annotations, startsAt, endsAt, fingerprint, ... }], ... }
async function storeAlerts(pool, payload) {
  const alerts = Array.isArray(payload?.alerts) ? payload.alerts.slice(0, 500) : [];
  let stored = 0;
  for (const alert of alerts) {
    const labels = alert?.labels && typeof alert.labels === 'object' ? alert.labels : {};
    const fingerprint = text(alert?.fingerprint, 128);
    const startsAt = date(alert?.startsAt);
    const status = alert?.status === 'resolved' ? 'resolved' : 'firing';
    if (!fingerprint || !startsAt) continue;
    const slug = text(labels.tenant, 63);
    await pool.query(`
      INSERT INTO platform_alerts (fingerprint, tenant_id, tenant_slug, environment, role, alert_name, severity,
                                   status, summary, labels, starts_at, ends_at)
      VALUES ($1, (SELECT id FROM platform_tenants WHERE slug = $2 AND status <> 'deleted' LIMIT 1), $2, $3, $4, $5, $6,
              $7, $8, $9, $10, $11)
      ON CONFLICT (fingerprint, starts_at) DO UPDATE
      SET status = EXCLUDED.status, ends_at = EXCLUDED.ends_at, summary = EXCLUDED.summary,
          labels = EXCLUDED.labels, severity = EXCLUDED.severity, updated_at = now()
    `, [
      fingerprint, slug, text(labels.environment, 20), text(labels.role, 20),
      text(labels.alertname, 120) ?? 'alerta', text(labels.severity, 20) ?? 'warning', status,
      text(alert?.annotations?.summary, 500) ?? text(alert?.annotations?.description, 500),
      JSON.stringify(labels), startsAt, status === 'resolved' ? date(alert?.endsAt) ?? new Date() : null,
    ]);
    stored += 1;
  }
  return stored;
}

function serializeAlert(row) {
  return {
    id: row.id,
    name: row.alert_name,
    severity: row.severity,
    status: row.status,
    summary: row.summary,
    tenantSlug: row.tenant_slug,
    tenantId: row.tenant_id,
    institutionName: row.institution_name,
    environment: row.environment,
    role: row.role,
    instance: row.labels?.instance ?? null,
    exporter: row.labels?.exporter ?? null,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    updatedAt: row.updated_at,
  };
}

// Se monta antes del parser JSON global (16 kB): un lote de Grafana puede ser mayor
function alertsWebhook(pool) {
  return [express.json({ limit: '1mb' }), async (request, response) => {
    const valid = validToken(request.get('Authorization'));
    if (valid === null) return response.status(503).json({ message: 'El webhook de alertas no está configurado (PLATFORM_ALERTS_TOKEN).' });
    if (!valid) return response.status(401).json({ message: 'Token del webhook inválido.' });
    const stored = await storeAlerts(pool, request.body);
    return response.json({ stored });
  }];
}

function alertsRouter(pool) {
  const router = express.Router();
  router.get('/alerts', async (request, response) => {
    const status = ['firing', 'resolved'].includes(request.query.status) ? request.query.status : null;
    const tenant = typeof request.query.tenant === 'string' && request.query.tenant.length <= 63 ? request.query.tenant : null;
    const limit = Math.min(Math.max(Number.parseInt(request.query.limit ?? '100', 10) || 100, 1), 500);
    const { rows } = await pool.query(`
      SELECT a.*, r.institution_name
      FROM platform_alerts a
      LEFT JOIN platform_tenants t ON t.id = a.tenant_id
      LEFT JOIN platform_requests r ON r.id = t.request_id
      WHERE ($1::text IS NULL OR a.status = $1) AND ($2::text IS NULL OR a.tenant_slug = $2)
      ORDER BY (a.status = 'firing') DESC, a.starts_at DESC
      LIMIT $3
    `, [status, tenant, limit]);
    const { rows: [counts] } = await pool.query(`
      SELECT count(*) FILTER (WHERE status = 'firing')::int AS firing,
             count(*) FILTER (WHERE status = 'firing' AND severity = 'critical')::int AS critical
      FROM platform_alerts WHERE ($1::text IS NULL OR tenant_slug = $1)
    `, [tenant]);
    response.json({ alerts: rows.map(serializeAlert), counts });
  });
  return router;
}

module.exports = { alertsRouter, alertsWebhook, storeAlerts };
