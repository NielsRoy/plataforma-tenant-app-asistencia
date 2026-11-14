const express = require('express');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { decryptSecrets, secretsKey } = require('../provisioning/crypto');
const { engineCatalog, getEngine } = require('../provisioning/engines');
const { QueueError, allowedOperations, enqueueOperation } = require('../provisioning/queue');
const { runToolbox } = require('../provisioning/toolbox');
const { deliverInvitation, issueTenantInvitation, tenantIsActivated } = require('./invitations');
const { newToken, tokenHash, validEmail } = require('./security');

// API del ciclo de vida de los tenants (todas las rutas requieren sesión de operador):
//   GET    /engines                       motores IaC y cuáles están implementados
//   GET    /tenants                       lista con filtros name, status, plan, environment (RF-14)
//   POST   /tenants                       registra una solicitud (o crea una con los datos de la
//                                         institución) y encola su creación (RF-07)
//   GET    /tenants/:id                   detalle, infraestructura y últimas operaciones
//   POST   /tenants/:id/operations        { kind: create | suspend | resume | redeploy } (RF-16/17)
//   GET    /tenants/:id/deletion-preview  recursos y datos que se eliminarían (RF-18)
//   DELETE /tenants/:id                   { confirmSlug } encola la eliminación (RF-18)
//   POST   /tenants/:id/invitation        reenvía la invitación del administrador
//   GET    /operations/:id                estado y pasos de una operación
//   GET    /operations/:id/logs?after=N   log saneado, por partes

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const statuses = ['pending', 'provisioning', 'active', 'suspending', 'suspended', 'resuming', 'deleting', 'deleted', 'failed'];
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const tenantSelect = `
  SELECT t.id, t.slug, t.status, t.status_updated_at, t.region, t.environment, t.engine, t.plan_id,
         t.created_at, t.deleted_at, t.app_url, t.invitation_status, t.invitation_updated_at, t.outputs,
         r.id AS request_id, r.institution_name, r.admin_name, r.admin_email,
         p.name AS plan_name,
         o.id AS op_id, o.kind AS op_kind, o.status AS op_status, o.current_step AS op_step,
         o.error_message AS op_error, o.queued_at AS op_queued_at, o.finished_at AS op_finished_at
  FROM platform_tenants t
  JOIN platform_requests r ON r.id = t.request_id
  JOIN platform_plans p ON p.id = t.plan_id
  LEFT JOIN LATERAL (
    SELECT * FROM platform_operations WHERE tenant_id = t.id ORDER BY queued_at DESC LIMIT 1
  ) o ON true
`;

function serializeOperation(row) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    currentStep: row.current_step,
    steps: row.steps,
    errorMessage: row.error_message,
    versions: row.versions,
    attempt: row.attempt,
    requestedBy: row.requested_by,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function serializeTenant(row) {
  const outputs = row.outputs ?? {};
  return {
    id: row.id,
    slug: row.slug,
    status: row.status,
    statusUpdatedAt: row.status_updated_at,
    institutionName: row.institution_name,
    adminName: row.admin_name,
    adminEmail: row.admin_email,
    requestId: row.request_id,
    planId: row.plan_id,
    planName: row.plan_name,
    region: row.region,
    environment: row.environment,
    engine: row.engine,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    appUrl: row.app_url ?? outputs.app_url ?? null,
    invitationStatus: row.invitation_status,
    invitationUpdatedAt: row.invitation_updated_at,
    // Contrato de outputs del motor: IPs, ids y AMIs. No contiene secretos.
    infrastructure: Object.keys(outputs).length > 0 ? {
      appUrl: outputs.app_url,
      availabilityZone: outputs.availability_zone,
      publicIps: outputs.public_ips,
      privateIps: outputs.private_ips,
      instanceIds: outputs.instance_ids,
      amiIds: outputs.ami_ids,
      securityGroupIds: outputs.security_group_ids,
    } : null,
    allowedOperations: allowedOperations(row.status),
    lastOperation: row.op_id ? {
      id: row.op_id,
      kind: row.op_kind,
      status: row.op_status,
      currentStep: row.op_step,
      errorMessage: row.op_error,
      queuedAt: row.op_queued_at,
      finishedAt: row.op_finished_at,
    } : null,
  };
}

function requireId(id, label = 'Identificador') {
  if (!uuidPattern.test(id)) throw new ApiError(400, `${label} inválido.`);
}

function readFilter(value, max) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > max) throw new ApiError(400, 'Filtro inválido.');
  return value.trim();
}

async function loadTenant(pool, id) {
  requireId(id, 'Identificador de tenant');
  const { rows: [row] } = await pool.query(`${tenantSelect} WHERE t.id = $1`, [id]);
  if (!row) throw new ApiError(404, 'Tenant no encontrado.');
  return row;
}

// Recursos que hay hoy en el estado del tenant (terraform state list)
async function stateResources(config, row) {
  // "pending" = nunca se aprovisionó: no hay estado que leer
  if (row.status === 'pending') return [];
  const engine = getEngine(row.engine);
  const lines = [];
  const ctx = {
    config,
    tenant: row,
    exec: async (command, options = {}) => {
      const result = await runToolbox(config, command, { ...options, onLine: (_stream, line) => lines.push(line) });
      if (result.code !== 0 && !options.allowFailure) {
        throw new ApiError(502, 'No se pudo leer el estado del tenant con el motor IaC. Revisa Docker y las credenciales de AWS.');
      }
      return result;
    },
  };
  if (!existsSync(path.join(config.workspacesDir, row.slug, '.terraform'))) await engine.init(ctx);
  // Las consultas de datos (data.aws_ami, data.aws_vpc...) no son recursos y no se eliminan
  return (await engine.resources(ctx)).filter((address) => !/(^|\.)data\./.test(address));
}

function describeResources(addresses) {
  const count = (pattern) => addresses.filter((address) => pattern.test(address)).length;
  return {
    instances: count(/\baws_instance\./),
    securityGroups: count(/\baws_security_group\./),
    securityGroupRules: count(/\baws_vpc_security_group_(ingress|egress)_rule\./),
    elasticIps: count(/\baws_eip\./),
    total: addresses.length,
  };
}

async function sendInvitation(pool, row) {
  if (!row.app_url && !row.outputs?.app_url) throw new ApiError(409, 'El tenant todavía no tiene una app desplegada.');
  if (row.invitation_status === 'activated') return { invitationStatus: 'activated' };
  let secrets;
  try {
    secrets = decryptSecrets(secretsKey(), (await pool.query('SELECT secrets_enc FROM platform_tenants WHERE id = $1', [row.id])).rows[0].secrets_enc);
  } catch {
    throw new ApiError(409, 'El tenant no tiene secretos legibles. Revisa PLATFORM_SECRETS_KEY.');
  }
  const appUrl = row.app_url ?? row.outputs.app_url;
  const issued = await issueTenantInvitation(appUrl, {
    bootstrapKey: secrets.tenant_bootstrap_key, slug: row.slug, email: row.admin_email, name: row.admin_name,
  });
  const delivery = issued.activated ? { status: 'activated' } : await deliverInvitation({
    email: row.admin_email, name: row.admin_name, institutionName: row.institution_name, appUrl, activationUrl: issued.activationUrl,
  });
  await pool.query(
    'UPDATE platform_tenants SET app_url = $2, invitation_status = $3, invitation_updated_at = now() WHERE id = $1',
    [row.id, appUrl, delivery.status],
  );
  return { invitationStatus: delivery.status, previewUrl: delivery.previewUrl };
}

// La activación del administrador ocurre en la app del tenant; se consulta al ver el detalle
async function refreshActivation(pool, row) {
  const appUrl = row.app_url ?? row.outputs?.app_url;
  if (!appUrl || row.status !== 'active' || row.invitation_status === 'activated') return row;
  if (!(await tenantIsActivated(appUrl, { trusted: true }))) return row;
  await pool.query(
    "UPDATE platform_tenants SET invitation_status = 'activated', invitation_updated_at = now() WHERE id = $1", [row.id],
  );
  return { ...row, invitation_status: 'activated', invitation_updated_at: new Date() };
}

function readField(value, label, min, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < min || text.length > max || text.includes(' ')) {
    throw new ApiError(400, `${label} debe tener entre ${min} y ${max} caracteres.`);
  }
  return text;
}

// Alta directa desde el panel: crea la solicitud ya con los datos de la institución
async function createRequest(pool, body, slug) {
  const institution = readField(body.institutionName, 'El nombre de la institución', 2, 160);
  const name = readField(body.adminName, 'El nombre del administrador', 2, 120);
  const email = readField(body.adminEmail, 'El correo del administrador', 3, 254).toLowerCase();
  const plan = readField(body.planId, 'El plan', 1, 40);
  if (!validEmail(email)) throw new ApiError(400, 'Ingresa un correo válido.');
  const { rows: [taken] } = await pool.query(
    "SELECT 1 FROM platform_tenants WHERE slug = $1 AND status <> 'deleted'", [slug],
  );
  if (taken) throw new ApiError(409, 'Ya hay una institución registrada con ese slug.');
  const { rows: [created] } = await pool.query(`
    INSERT INTO platform_requests (institution_name, admin_name, admin_email, plan_id, tracking_token_hash)
    SELECT $1, $2, $3, id, $5 FROM platform_plans WHERE id = $4
    RETURNING id
  `, [institution, name, email, plan, tokenHash(newToken())]);
  if (!created) throw new ApiError(400, 'El plan seleccionado no existe.');
  return created.id;
}

function tenantsRouter({ pool, config, registerTenant, tenantConfig }) {
  const router = express.Router();
  const actor = (response) => response.locals.user?.email ?? null;

  router.get('/engines', (_request, response) => {
    response.json({ engines: engineCatalog() });
  });

  router.get('/tenants', async (request, response) => {
    const name = readFilter(request.query.name, 100);
    const status = readFilter(request.query.status, 20);
    const plan = readFilter(request.query.plan, 40);
    const environment = readFilter(request.query.environment, 20);
    if (status && !statuses.includes(status)) throw new ApiError(400, 'Estado inválido.');
    if (environment && !['production', 'staging'].includes(environment)) throw new ApiError(400, 'Entorno inválido.');
    const { rows } = await pool.query(`
      ${tenantSelect}
      WHERE ($1::text IS NULL OR r.institution_name ILIKE '%' || $1 || '%' OR t.slug ILIKE '%' || $1 || '%')
        AND (CASE WHEN $2::text IS NULL THEN t.status <> 'deleted' ELSE t.status = $2 END)
        AND ($3::text IS NULL OR t.plan_id = $3)
        AND ($4::text IS NULL OR t.environment = $4)
      ORDER BY t.created_at DESC
    `, [name, status, plan, environment]);
    response.json({ tenants: rows.map(serializeTenant) });
  });

  // RF-07: crear un tenant a partir de una solicitud pendiente, o directamente con los
  // datos de la institución (el operador la da de alta desde el panel)
  router.post('/tenants', async (request, response) => {
    const body = request.body ?? {};
    const settings = tenantConfig(body);
    const engine = engineCatalog().find((item) => item.name === settings.engine);
    if (!engine?.implemented) {
      throw new ApiError(422, `El motor ${engine?.label ?? settings.engine} todavía no está implementado. Usa Terraform.`);
    }
    if (!config.supportedRegions.includes(settings.region)) {
      throw new ApiError(422, `Las imágenes del proyecto solo existen en ${config.supportedRegions.join(', ')}.`);
    }
    let requestId = body.requestId;
    if (requestId === undefined) requestId = await createRequest(pool, body, settings.slug);
    if (typeof requestId !== 'string') throw new ApiError(400, 'Solicitud inválida.');
    const registered = await registerTenant(pool, requestId, settings);
    const operation = await enqueueOperation(pool, { tenantId: registered.tenant.id, kind: 'create', requestedBy: actor(response) });
    const row = await loadTenant(pool, registered.tenant.id);
    response.status(202).json({ tenant: serializeTenant(row), operation: serializeOperation(operation) });
  });

  router.get('/tenants/:id', async (request, response) => {
    const row = await refreshActivation(pool, await loadTenant(pool, request.params.id));
    const { rows } = await pool.query(
      'SELECT * FROM platform_operations WHERE tenant_id = $1 ORDER BY queued_at DESC LIMIT 20', [row.id],
    );
    response.json({ tenant: serializeTenant(row), operations: rows.map(serializeOperation) });
  });

  router.post('/tenants/:id/operations', async (request, response) => {
    const kind = request.body?.kind;
    if (!['create', 'suspend', 'resume', 'redeploy'].includes(kind)) {
      throw new ApiError(400, 'Operación inválida. Usa create, suspend, resume o redeploy (para eliminar, usa DELETE).');
    }
    const row = await loadTenant(pool, request.params.id);
    const operation = await enqueueOperation(pool, { tenantId: row.id, kind, requestedBy: actor(response) });
    response.status(202).json({ operation: serializeOperation(operation) });
  });

  // RF-18: lo que se eliminaría, leído del estado real del tenant
  router.get('/tenants/:id/deletion-preview', async (request, response) => {
    const row = await loadTenant(pool, request.params.id);
    if (!allowedOperations(row.status).includes('delete')) {
      throw new ApiError(409, `No se puede eliminar el tenant en estado "${row.status}".`);
    }
    const resources = await stateResources(config, row);
    response.json({
      slug: row.slug,
      institutionName: row.institution_name,
      appUrl: row.app_url ?? row.outputs?.app_url ?? null,
      resources,
      summary: describeResources(resources),
      dataLoss: resources.length === 0 ? [] : [
        'La base de datos PostgreSQL del tenant y el disco de su EC2: usuarios, cursos, asistencias y justificaciones.',
        'Las 3 EC2 (frontend, backend y base de datos) y sus discos.',
        'La IP elástica: la URL actual dejará de funcionar.',
        'Los secretos del tenant guardados en la plataforma.',
      ],
      irreversible: true,
      confirmWith: row.slug,
    });
  });

  router.delete('/tenants/:id', async (request, response) => {
    const row = await loadTenant(pool, request.params.id);
    if (request.body?.confirmSlug !== row.slug) {
      throw new ApiError(400, `Para confirmar la eliminación escribe el slug del tenant: ${row.slug}`);
    }
    const operation = await enqueueOperation(pool, { tenantId: row.id, kind: 'delete', requestedBy: actor(response) });
    response.status(202).json({ operation: serializeOperation(operation) });
  });

  router.post('/tenants/:id/invitation', async (request, response) => {
    const row = await loadTenant(pool, request.params.id);
    if (row.status !== 'active') throw new ApiError(409, 'El tenant debe estar activo para enviar la invitación.');
    response.json(await sendInvitation(pool, row));
  });

  router.get('/operations/:id', async (request, response) => {
    requireId(request.params.id, 'Identificador de operación');
    const { rows: [row] } = await pool.query('SELECT * FROM platform_operations WHERE id = $1', [request.params.id]);
    if (!row) throw new ApiError(404, 'Operación no encontrada.');
    response.json({ operation: serializeOperation(row) });
  });

  router.get('/operations/:id/logs', async (request, response) => {
    requireId(request.params.id, 'Identificador de operación');
    const after = Number(request.query.after ?? 0);
    const limit = Math.min(Number(request.query.limit ?? 500), 2000);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1) {
      throw new ApiError(400, 'Parámetros de paginación inválidos.');
    }
    const { rows } = await pool.query(`
      SELECT id, step, stream, line, created_at FROM platform_operation_logs
      WHERE operation_id = $1 AND id > $2 ORDER BY id LIMIT $3
    `, [request.params.id, after, limit]);
    const { rows: [operation] } = await pool.query('SELECT status FROM platform_operations WHERE id = $1', [request.params.id]);
    if (!operation) throw new ApiError(404, 'Operación no encontrada.');
    response.json({
      lines: rows.map((row) => ({ id: Number(row.id), step: row.step, stream: row.stream, line: row.line, at: row.created_at })),
      next: rows.length > 0 ? Number(rows.at(-1).id) : after,
      finished: ['succeeded', 'failed', 'cancelled'].includes(operation.status),
    });
  });

  return router;
}

module.exports = { ApiError, QueueError, tenantsRouter };
