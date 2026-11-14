const { transaction } = require('../runtime/db');

class QueueError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Operaciones permitidas según el estado del tenant. Un tenant en "failed" admite
// repetir cualquiera: todos los pasos son idempotentes (RF-12).
const allowed = {
  pending: ['create', 'delete'],
  active: ['suspend', 'redeploy', 'delete'],
  suspended: ['resume', 'delete'],
  failed: ['create', 'redeploy', 'suspend', 'resume', 'delete'],
};

function allowedOperations(status) {
  return allowed[status] ?? [];
}

async function enqueueOperation(pool, { tenantId, kind, requestedBy = null, params = {}, retryOf = null }) {
  try {
    return await transaction(pool, async (client) => {
      const { rows: [tenant] } = await client.query(
        'SELECT id, slug, status, engine FROM platform_tenants WHERE id = $1 FOR UPDATE', [tenantId],
      );
      if (!tenant) throw new QueueError(404, 'Tenant no encontrado.');
      if (!allowedOperations(tenant.status).includes(kind)) {
        throw new QueueError(409, `No se puede ejecutar "${kind}" con el tenant en estado "${tenant.status}".`);
      }
      const { rows: [{ attempts }] } = await client.query(
        'SELECT count(*)::int AS attempts FROM platform_operations WHERE tenant_id = $1 AND kind = $2', [tenantId, kind],
      );
      const { rows: [operation] } = await client.query(`
        INSERT INTO platform_operations (tenant_id, kind, engine, params, requested_by, retry_of, attempt)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [tenantId, kind, tenant.engine, JSON.stringify(params), requestedBy, retryOf, attempts + 1]);
      return operation;
    });
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'platform_operations_one_active_idx') {
      throw new QueueError(409, 'El tenant ya tiene una operación en curso.');
    }
    throw error;
  }
}

module.exports = { QueueError, allowedOperations, enqueueOperation };
