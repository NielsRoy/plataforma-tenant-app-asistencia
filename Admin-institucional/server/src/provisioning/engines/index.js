const terraform = require('./terraform');
const opentofu = require('./opentofu');
const pulumi = require('./pulumi');
const cloudformation = require('./cloudformation');
const { OperationError } = require('../errors');

const engines = { terraform, opentofu, pulumi, cloudformation };

function getEngine(name) {
  const engine = engines[name];
  if (!engine) throw new OperationError(`El motor de infraestructura "${name}" no existe.`);
  if (!engine.implemented) {
    throw new OperationError(`El motor ${engine.label} todavía no está implementado. Usa Terraform para este tenant.`);
  }
  return engine;
}

function engineCatalog() {
  return Object.values(engines).map((engine) => ({
    name: engine.name,
    label: engine.label ?? 'Terraform',
    implemented: engine.implemented,
  }));
}

module.exports = { getEngine, engineCatalog };
