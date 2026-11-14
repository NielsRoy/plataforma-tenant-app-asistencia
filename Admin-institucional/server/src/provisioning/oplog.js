// Log de una operación: pasos con su estado y líneas saneadas en
// platform_operation_logs. Escribe por lotes para no hacer un INSERT por línea.

class OperationLog {
  constructor(pool, operationId, redactor) {
    this.pool = pool;
    this.operationId = operationId;
    this.redactor = redactor;
    this.step = 'preparar';
    this.steps = [];
    this.buffer = [];
    this.recent = [];
    this.timer = null;
    this.pending = Promise.resolve();
  }

  write(stream, text) {
    for (const raw of String(text).split('\n')) {
      const line = this.redactor.redact(raw).slice(0, 4000);
      this.buffer.push({ step: this.step, stream, line });
      this.recent.push(line);
    }
    if (this.recent.length > 300) this.recent.splice(0, this.recent.length - 300);
    if (this.buffer.length >= 50) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), 500);
  }

  system(text) {
    this.write('system', text);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const rows = this.buffer.splice(0);
    if (rows.length === 0) return this.pending;
    this.pending = this.pending.then(() => this.pool.query(`
      INSERT INTO platform_operation_logs (operation_id, step, stream, line)
      SELECT $1, step, stream, line
      FROM unnest($2::text[], $3::text[], $4::text[]) AS l(step, stream, line)
    `, [this.operationId, rows.map((r) => r.step), rows.map((r) => r.stream), rows.map((r) => r.line)]))
      .catch((error) => console.error('No se pudo guardar el log de la operación.', error.code ?? error.message));
    return this.pending;
  }

  async saveSteps() {
    await this.pool.query(
      'UPDATE platform_operations SET steps = $2, current_step = $3, heartbeat_at = now() WHERE id = $1',
      [this.operationId, JSON.stringify(this.steps), this.step],
    );
  }

  async startStep(name) {
    await this.flush();
    this.step = name;
    this.recent = [];
    this.steps.push({ name, status: 'running', startedAt: new Date().toISOString() });
    await this.saveSteps();
  }

  async endStep(status) {
    await this.flush();
    const current = this.steps.at(-1);
    if (current && current.status === 'running') {
      current.status = status;
      current.finishedAt = new Date().toISOString();
    }
    await this.saveSteps();
  }

  async close() {
    await this.flush();
  }
}

module.exports = { OperationLog };
