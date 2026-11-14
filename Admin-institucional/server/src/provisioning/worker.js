const os = require('node:os');
const { runOperation } = require('./pipeline');

// Worker en segundo plano dentro del proceso de la API. Toma las operaciones de
// la cola de una en una (FOR UPDATE SKIP LOCKED permite más de un worker sin
// tomar dos veces la misma) y marca un latido mientras trabaja.
class ProvisioningWorker {
  constructor(pool, config) {
    this.pool = pool;
    this.config = config;
    this.id = `${os.hostname()}-${process.pid}`;
    this.current = null;
    this.stopped = false;
    this.lastRecovery = 0;
  }

  start() {
    this.timer = setInterval(() => this.tick(), this.config.pollIntervalMs);
    this.tick();
    console.log(`Worker de aprovisionamiento activo (${this.id}).`);
  }

  // Operaciones "running" sin latido: la plataforma se detuvo a mitad de camino
  async recoverStale() {
    const { rows } = await this.pool.query(`
      UPDATE platform_operations
      SET status = 'failed', finished_at = now(), current_step = NULL,
          error_message = 'La plataforma se detuvo mientras la operación estaba en curso. Revisa el log y vuelve a intentarlo.'
      WHERE status = 'running' AND heartbeat_at < now() - make_interval(secs => $1)
      RETURNING tenant_id
    `, [this.config.staleAfterMs / 1000]);
    for (const { tenant_id: tenantId } of rows) {
      await this.pool.query("UPDATE platform_tenants SET status = 'failed', status_updated_at = now() WHERE id = $1", [tenantId]);
    }
  }

  async claim() {
    const { rows: [operation] } = await this.pool.query(`
      UPDATE platform_operations o
      SET status = 'running', started_at = now(), heartbeat_at = now(), worker_id = $1
      WHERE o.id = (
        SELECT id FROM platform_operations WHERE status = 'queued'
        ORDER BY queued_at FOR UPDATE SKIP LOCKED LIMIT 1
      )
      RETURNING o.*
    `, [this.id]);
    return operation;
  }

  async tick() {
    if (this.current || this.stopped) return;
    let operation;
    try {
      if (Date.now() - this.lastRecovery > 30000) {
        this.lastRecovery = Date.now();
        await this.recoverStale();
      }
      operation = await this.claim();
    } catch (error) {
      console.error('El worker no pudo leer la cola.', error.code ?? error.message);
      return;
    }
    if (!operation) return;
    this.current = this.execute(operation).finally(() => {
      this.current = null;
      if (!this.stopped) setImmediate(() => this.tick());
    });
  }

  async execute(operation) {
    const heartbeat = setInterval(() => {
      this.pool.query('UPDATE platform_operations SET heartbeat_at = now() WHERE id = $1', [operation.id]).catch(() => {});
    }, this.config.heartbeatMs);
    try {
      await runOperation(this.pool, this.config, operation);
    } catch (error) {
      console.error('Error inesperado en el worker.', error);
    } finally {
      clearInterval(heartbeat);
    }
  }

  // Espera a que termine la operación en curso: cortarla a medias dejaría el
  // estado de Terraform bloqueado.
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    if (this.current) {
      console.log('Esperando a que termine la operación en curso antes de cerrar...');
      await this.current;
    }
  }
}

module.exports = { ProvisioningWorker };
