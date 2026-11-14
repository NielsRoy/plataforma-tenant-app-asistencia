const { execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const { mkdir, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { deliverInvitation, issueTenantInvitation } = require('../runtime/invitations');
const { decryptSecrets, encryptSecrets, generateTenantSecrets, secretsKey, secretsYaml } = require('./crypto');
const { getEngine } = require('./engines');
const { OperationError, explainFailure } = require('./errors');
const { OperationLog } = require('./oplog');
const { Redactor } = require('./redact');
const { removeTargets, writeTargets } = require('./targets');
const { runToolbox } = require('./toolbox');

// Pipeline de cada operación. Ejecuta, en el toolbox, los mismos comandos de
// docs/tenant-manual.md y guarda cada paso y su log en la base de la plataforma.
//
//   create   preparar > escanear > init > plan > apply > outputs > ansible > salud > invitacion > monitoreo
//   suspend  preparar > init > plan > apply > monitoreo
//   resume   preparar > init > plan > apply > refrescar > outputs > salud > monitoreo
//   redeploy preparar > init > outputs > ansible > salud > monitoreo
//   delete   preparar > init > plan (vista previa) > apply (destroy) > monitoreo > limpieza

const transitions = {
  create: { running: 'provisioning', success: 'active' },
  redeploy: { running: 'provisioning', success: 'active' },
  suspend: { running: 'suspending', success: 'suspended' },
  resume: { running: 'resuming', success: 'active' },
  delete: { running: 'deleting', success: 'deleted' },
};

async function loadTenant(pool, tenantId) {
  const { rows: [tenant] } = await pool.query(`
    SELECT t.*, r.institution_name, r.admin_name, r.admin_email
    FROM platform_tenants t JOIN platform_requests r ON r.id = t.request_id
    WHERE t.id = $1
  `, [tenantId]);
  return tenant;
}

async function setTenantStatus(pool, tenantId, status) {
  await pool.query('UPDATE platform_tenants SET status = $2, status_updated_at = now() WHERE id = $1', [tenantId, status]);
}

async function platformCommit(repoRoot) {
  try {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, windowsHide: true });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function detectOperatorCidrs(config) {
  if (config.operatorCidrs.length > 0) return config.operatorCidrs;
  try {
    const response = await fetch('https://checkip.amazonaws.com', { signal: AbortSignal.timeout(5000) });
    const ip = (await response.text()).trim();
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return [`${ip}/32`];
  } catch {
    // se informa abajo
  }
  throw new OperationError('No se pudo detectar la IP pública de esta PC. Configura PLATFORM_OPERATOR_CIDRS.');
}

// Ejecuta un comando en el toolbox y vuelca su salida al log del paso actual.
function createExec(ctx) {
  let counter = 0;
  return async (command, options = {}) => {
    counter += 1;
    const name = `asistencia-op-${ctx.operation.id.slice(0, 8)}-${counter}`;
    if (!options.quiet) ctx.log.system(`$ ${command.join(' ')}`);
    let result;
    try {
      result = await runToolbox(ctx.config, command, {
        ...options,
        name,
        onLine: (stream, line) => ctx.log.write(stream, line),
      });
    } catch (error) {
      ctx.log.system(error.message);
      throw new OperationError(explainFailure(ctx.log.step, [...ctx.log.recent, error.message]));
    }
    if (result.timedOut) throw new OperationError(`El paso "${ctx.log.step}" superó el tiempo máximo y se detuvo.`);
    if (result.code !== 0 && !options.allowFailure) {
      ctx.log.system(`El comando terminó con código ${result.code}.`);
      throw new OperationError(explainFailure(ctx.log.step, ctx.log.recent));
    }
    return result;
  };
}

async function step(ctx, name, work) {
  await ctx.log.startStep(name);
  try {
    const result = await work();
    await ctx.log.endStep('succeeded');
    return result;
  } catch (error) {
    await ctx.log.endStep('failed');
    throw error;
  }
}

async function saveVersions(ctx) {
  await ctx.pool.query('UPDATE platform_operations SET versions = $2 WHERE id = $1', [ctx.operation.id, JSON.stringify(ctx.versions)]);
}

async function prepare(ctx) {
  const { config, tenant, operation, log, pool } = ctx;
  ctx.engine = getEngine(operation.engine);
  if (!config.supportedRegions.includes(tenant.region)) {
    throw new OperationError(`Las AMIs del proyecto solo existen en ${config.supportedRegions.join(', ')}; el tenant usa ${tenant.region}.`);
  }
  if (!existsSync(config.backendConfig)) {
    throw new OperationError('Falta infra/terraform/tenant/backend.hcl. Aplica primero el bootstrap de Terraform.');
  }
  await mkdir(ctx.hostPaths.dir, { recursive: true });

  const { rows: instances } = await pool.query(
    'SELECT role, aws_type, system_disk_gb FROM platform_plan_instances WHERE plan_id = $1', [tenant.plan_id],
  );
  if (instances.length !== 3) throw new OperationError(`El plan ${tenant.plan_id} no define las 3 máquinas.`);
  ctx.instances = instances;
  ctx.operatorCidrs = operation.kind === 'delete' ? ['127.0.0.1/32'] : await detectOperatorCidrs(config);

  // Secretos: se generan una sola vez (al crear) y se guardan cifrados
  if (['create', 'redeploy'].includes(operation.kind)) {
    let key;
    try {
      key = secretsKey();
    } catch (error) {
      throw new OperationError(error.message);
    }
    if (!tenant.secrets_enc) {
      if (operation.kind !== 'create') throw new OperationError('El tenant no tiene secretos guardados. Créalo de nuevo.');
      const generated = generateTenantSecrets();
      const encrypted = encryptSecrets(key, generated);
      await pool.query('UPDATE platform_tenants SET secrets_enc = $2 WHERE id = $1', [tenant.id, encrypted]);
      tenant.secrets_enc = encrypted;
      log.system('Secretos del tenant generados y guardados cifrados (AES-256-GCM).');
    }
    try {
      ctx.secrets = decryptSecrets(key, tenant.secrets_enc);
    } catch {
      throw new OperationError('No se pudieron descifrar los secretos del tenant. ¿Cambió PLATFORM_SECRETS_KEY?');
    }
    ctx.redactor.add(Object.values(ctx.secrets));
  }

  // RF-13: con qué se hizo esta operación
  const toolbox = await ctx.exec(['toolbox-versions'], { capture: true, quiet: true });
  ctx.versions = {
    engine: operation.engine,
    toolbox: JSON.parse(toolbox.stdout || '{}'),
    ...(await ctx.engine.versions(ctx)),
    platformCommit: await platformCommit(config.repoRoot),
    plan: tenant.plan_id,
    instanceTypes: Object.fromEntries(instances.map((i) => [i.role, i.aws_type])),
  };
  await saveVersions(ctx);
  log.system(`Tenant ${tenant.slug} (${tenant.environment}, plan ${tenant.plan_id}) con ${operation.engine}.`);
  log.system(`Versiones: ${JSON.stringify(ctx.versions)}`);
  log.system(`IP del operador permitida para SSH y métricas: ${ctx.operatorCidrs.join(', ')}`);
}

function describePlan(ctx, summary) {
  const { create, update, replace, delete: destroy } = summary;
  ctx.log.system(`Resumen del plan: ${create.length} a crear, ${update.length} a cambiar, ${replace.length} a reemplazar, ${destroy.length} a destruir.`);
}

// Crear, suspender o reanudar nunca deben destruir ni reemplazar una EC2, un disco
// o la IP elástica: protege los datos y la URL del tenant. Las reglas de los
// Security Groups sí pueden recrearse (p. ej. si cambió la IP del operador).
const protectedResource = /\baws_(instance|eip|eip_association|ebs_volume|volume_attachment)\./;

function refuseDestruction(summary) {
  const risky = [...summary.replace, ...summary.delete].filter((address) => protectedResource.test(address));
  if (risky.length > 0) {
    throw new OperationError(
      `El plan quiere destruir o reemplazar recursos (${risky.join(', ')}). Se canceló para no perder datos.`,
    );
  }
}

async function planAndApply(ctx, desiredState) {
  await ctx.engine.writeVariables(ctx, { desiredState });
  const summary = await step(ctx, 'plan', async () => {
    const result = await ctx.engine.plan(ctx);
    describePlan(ctx, result);
    refuseDestruction(result);
    return result;
  });
  await step(ctx, 'apply', () => ctx.engine.apply(ctx));
  return summary;
}

async function readOutputs(ctx) {
  return step(ctx, 'outputs', async () => {
    const outputs = await ctx.engine.outputs(ctx);
    if (!outputs.app_url) throw new OperationError('El motor no devolvió app_url: el tenant no tiene infraestructura.');
    await ctx.pool.query('UPDATE platform_tenants SET outputs = $2 WHERE id = $1', [ctx.tenant.id, JSON.stringify(outputs)]);
    ctx.outputs = outputs;
    ctx.versions.amiIds = outputs.ami_ids;
    await saveVersions(ctx);
    ctx.log.system(`URL de la app: ${outputs.app_url}`);
    ctx.log.system(`IP públicas: ${JSON.stringify(outputs.public_ips)}`);
    return outputs;
  });
}

async function deploy(ctx) {
  await step(ctx, 'ansible', async () => {
    const file = path.join(ctx.hostPaths.dir, `.secrets-${ctx.operation.id.slice(0, 8)}.yml`);
    await writeFile(file, secretsYaml(ctx.secrets), { mode: 0o600 });
    try {
      await ctx.exec(['bash', 'scripts/deploy-tenant.sh', ctx.tenant.slug], {
        timeoutMs: 20 * 60_000,
        env: {
          ...ctx.engine.toolboxEnv(ctx),
          TENANT_SECRETS_FILE: `/workspace/.workspaces/${ctx.tenant.slug}/${path.basename(file)}`,
        },
      });
    } finally {
      await rm(file, { force: true });
    }
  });
}

async function checkHealth(ctx) {
  await step(ctx, 'salud', async () => {
    const url = `${ctx.outputs.app_url}/api/health`;
    for (let attempt = 1; attempt <= 24; attempt += 1) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
        const body = await response.json().catch(() => null);
        if (response.ok && body?.status === 'ok') {
          ctx.log.system(`${url} respondió {"status":"ok"} (intento ${attempt}).`);
          return;
        }
        ctx.log.system(`Intento ${attempt}: ${url} respondió ${response.status}.`);
      } catch (error) {
        ctx.log.system(`Intento ${attempt}: ${url} no responde (${error.name}).`);
      }
      await new Promise((resolve) => { setTimeout(resolve, 5000); });
    }
    throw new OperationError('La app no respondió en /api/health después de 2 minutos.');
  });
}

async function invite(ctx) {
  await step(ctx, 'invitacion', async () => {
    const { tenant, outputs, log, pool } = ctx;
    if (tenant.invitation_status === 'activated') {
      log.system('El administrador ya activó su cuenta; no se envía otra invitación.');
      return;
    }
    let status;
    try {
      const issued = await issueTenantInvitation(outputs.app_url, {
        bootstrapKey: ctx.secrets.tenant_bootstrap_key, slug: tenant.slug, email: tenant.admin_email, name: tenant.admin_name,
      });
      if (issued.activated) {
        status = 'activated';
      } else {
        const delivery = await deliverInvitation({
          email: tenant.admin_email, name: tenant.admin_name, institutionName: tenant.institution_name,
          appUrl: outputs.app_url, activationUrl: issued.activationUrl,
        });
        status = delivery.status;
        if (delivery.previewUrl) log.system(`Enlace de activación (modo preview, solo desarrollo): ${delivery.previewUrl}`);
        if (status === 'sent') log.system(`Invitación enviada por correo a ${tenant.admin_email}.`);
        if (status === 'failed') log.system('No se pudo enviar el correo de invitación. Se puede reenviar desde la plataforma.');
      }
    } catch (error) {
      throw new OperationError(error.status ? error.message : 'No se pudo pedir la invitación a la app del tenant.');
    }
    try {
      await pool.query(`
        UPDATE platform_tenants SET app_url = $2, invitation_status = $3, invitation_updated_at = now() WHERE id = $1
      `, [tenant.id, outputs.app_url, status]);
    } catch (error) {
      if (error.code === '23505') throw new OperationError(`La URL ${outputs.app_url} ya está registrada para otro tenant.`);
      throw error;
    }
  });
}

async function monitoring(ctx, enabled) {
  await step(ctx, 'monitoreo', async () => {
    if (enabled) {
      const file = await writeTargets(ctx.config, ctx.tenant, ctx.outputs);
      ctx.log.system(`Targets de Prometheus escritos en ${path.relative(ctx.config.repoRoot, file)}.`);
    } else {
      await removeTargets(ctx.config, ctx.tenant.slug);
      ctx.log.system('Targets de Prometheus retirados (el tenant no está encendido).');
    }
  });
}

const handlers = {
  async create(ctx) {
    await step(ctx, 'escanear', () => ctx.engine.scan(ctx));
    await step(ctx, 'init', async () => {
      await ctx.engine.init(ctx);
      // Primera creación: el estado debe estar vacío. Evita adueñarse de un tenant
      // creado a mano con el mismo slug (docs/tenant-manual.md).
      const { rows: [previous] } = await ctx.pool.query(
        "SELECT count(*)::int AS n FROM platform_operations WHERE tenant_id = $1 AND kind = 'create' AND id <> $2",
        [ctx.tenant.id, ctx.operation.id],
      );
      if (previous.n === 0 && (await ctx.engine.resources(ctx)).length > 0) {
        throw new OperationError(`Ya existe infraestructura en el estado tenants/${ctx.tenant.slug}. Usa otro slug o elimina ese tenant.`);
      }
    });
    await planAndApply(ctx, 'running');
    await readOutputs(ctx);
    await deploy(ctx);
    await checkHealth(ctx);
    await invite(ctx);
    await monitoring(ctx, true);
  },

  async redeploy(ctx) {
    await step(ctx, 'init', () => ctx.engine.init(ctx));
    await readOutputs(ctx);
    await deploy(ctx);
    await checkHealth(ctx);
    await monitoring(ctx, true);
  },

  async suspend(ctx) {
    await step(ctx, 'init', () => ctx.engine.init(ctx));
    await planAndApply(ctx, 'stopped');
    await monitoring(ctx, false);
  },

  async resume(ctx) {
    await step(ctx, 'init', () => ctx.engine.init(ctx));
    await planAndApply(ctx, 'running');
    // Al reanudar, backend y database reciben IP públicas nuevas
    await step(ctx, 'refrescar', () => ctx.engine.refresh(ctx));
    await readOutputs(ctx);
    await checkHealth(ctx);
    await monitoring(ctx, true);
  },

  async delete(ctx) {
    await step(ctx, 'init', () => ctx.engine.init(ctx));
    await ctx.engine.writeVariables(ctx, { desiredState: 'running' });
    await step(ctx, 'plan', async () => {
      const summary = await ctx.engine.plan(ctx, { destroy: true });
      describePlan(ctx, summary);
      ctx.log.system(`Recursos que se eliminan: ${summary.delete.join(', ') || 'ninguno'}`);
    });
    await step(ctx, 'apply', () => ctx.engine.apply(ctx));
    await monitoring(ctx, false);
    await step(ctx, 'limpieza', async () => {
      await rm(ctx.hostPaths.dir, { recursive: true, force: true });
      await ctx.pool.query(`
        UPDATE platform_tenants SET secrets_enc = NULL, outputs = '{}'::jsonb, deleted_at = now() WHERE id = $1
      `, [ctx.tenant.id]);
      ctx.log.system('Carpeta de trabajo y secretos del tenant eliminados.');
    });
  },
};

async function finishOperation(pool, operationId, status, errorMessage) {
  await pool.query(`
    UPDATE platform_operations
    SET status = $2, error_message = $3, finished_at = now(), current_step = NULL
    WHERE id = $1
  `, [operationId, status, errorMessage]);
}

async function runOperation(pool, config, operation) {
  const tenant = await loadTenant(pool, operation.tenant_id);
  const redactor = new Redactor();
  const log = new OperationLog(pool, operation.id, redactor);
  const dir = path.join(config.workspacesDir, tenant.slug);
  const ctx = {
    pool, config, operation, tenant, log, redactor,
    hostPaths: { dir, varFile: path.join(dir, 'terraform.tfvars.json') },
    versions: {},
  };
  ctx.exec = createExec(ctx);
  const transition = transitions[operation.kind];

  await setTenantStatus(pool, tenant.id, transition.running);
  log.system(`Operación ${operation.kind} del tenant ${tenant.slug} (intento ${operation.attempt}).`);
  try {
    await step(ctx, 'preparar', () => prepare(ctx));
    await handlers[operation.kind](ctx);
    await log.close();
    await finishOperation(pool, operation.id, 'succeeded', null);
    await setTenantStatus(pool, tenant.id, transition.success);
  } catch (error) {
    const message = error.userMessage ?? 'Error interno de la plataforma. Revisa el log de la operación.';
    if (!error.userMessage) {
      log.system(`Error interno: ${redactor.redact(error.message)}`);
      console.error('Operación fallida por un error interno.', error);
    }
    log.system(`La operación falló: ${message}`);
    await log.close();
    await finishOperation(pool, operation.id, 'failed', message);
    await setTenantStatus(pool, tenant.id, 'failed');
  }
}

module.exports = { runOperation };
