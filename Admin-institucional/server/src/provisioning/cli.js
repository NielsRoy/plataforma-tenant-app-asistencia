// Herramienta de línea de comandos para la cola de operaciones. El worker que las
// ejecuta corre dentro de la API (npm start); esta CLI solo encola y consulta.
//
//   npm run op -- enqueue <slug> <create|suspend|resume|redeploy|delete>
//   npm run op -- list [slug]
//   npm run op -- logs <operation-id> [--follow]
const { databaseUrl } = require('../config');
const { createPool } = require('../runtime/db');
const { enqueueOperation } = require('./queue');

async function tenantBySlug(pool, slug) {
  const { rows: [tenant] } = await pool.query(
    "SELECT id, slug, status FROM platform_tenants WHERE slug = $1 AND status <> 'deleted'", [slug],
  );
  if (!tenant) throw new Error(`No hay un tenant registrado con el slug "${slug}".`);
  return tenant;
}

async function enqueue(pool, slug, kind) {
  const tenant = await tenantBySlug(pool, slug);
  const operation = await enqueueOperation(pool, { tenantId: tenant.id, kind, requestedBy: 'cli' });
  console.log(`Operación ${operation.kind} encolada: ${operation.id}`);
  console.log(`Sigue el log con: npm run op -- logs ${operation.id} --follow`);
}

async function list(pool, slug) {
  const { rows } = await pool.query(`
    SELECT o.id, t.slug, t.status AS tenant_status, o.kind, o.status, o.current_step, o.queued_at, o.error_message
    FROM platform_operations o JOIN platform_tenants t ON t.id = o.tenant_id
    WHERE $1::text IS NULL OR t.slug = $1
    ORDER BY o.queued_at DESC LIMIT 20
  `, [slug ?? null]);
  console.table(rows.map((row) => ({
    id: row.id, tenant: row.slug, tenantStatus: row.tenant_status, kind: row.kind,
    status: row.status, step: row.current_step ?? '', error: row.error_message ?? '',
  })));
}

async function logs(pool, operationId, follow) {
  let last = 0;
  for (;;) {
    const { rows } = await pool.query(
      'SELECT id, step, stream, line FROM platform_operation_logs WHERE operation_id = $1 AND id > $2 ORDER BY id',
      [operationId, last],
    );
    for (const row of rows) {
      console.log(`[${row.step}] ${row.stream === 'stderr' ? '! ' : ''}${row.line}`);
      last = row.id;
    }
    const { rows: [operation] } = await pool.query(
      'SELECT status, error_message FROM platform_operations WHERE id = $1', [operationId],
    );
    if (!operation) throw new Error('Operación no encontrada.');
    if (!follow || ['succeeded', 'failed', 'cancelled'].includes(operation.status)) {
      console.log(`== Estado: ${operation.status}${operation.error_message ? ` — ${operation.error_message}` : ''}`);
      return;
    }
    await new Promise((resolve) => { setTimeout(resolve, 2000); });
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const pool = createPool(databaseUrl());
  try {
    if (command === 'enqueue' && args.length === 2) await enqueue(pool, args[0], args[1]);
    else if (command === 'list') await list(pool, args[0]);
    else if (command === 'logs' && args[0]) await logs(pool, args[0], args.includes('--follow'));
    else {
      console.log('Uso: npm run op -- enqueue <slug> <kind> | list [slug] | logs <operation-id> [--follow]');
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
