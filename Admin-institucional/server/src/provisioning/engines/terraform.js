const { readFile, writeFile } = require('node:fs/promises');

// Motor Terraform. Usa el stack infra/terraform/tenant con un directorio de datos
// propio por tenant (TF_DATA_DIR), así varios tenants comparten el código sin
// pisarse, y el estado de cada uno vive en S3 en tenants/<slug>/terraform.tfstate.
//
// Todos los motores devuelven el mismo contrato de outputs (ver outputs()).

const stack = 'infra/terraform/tenant';

function containerPaths(ctx) {
  const dir = `/workspace/.workspaces/${ctx.tenant.slug}`;
  return {
    dir,
    dataDir: `${dir}/.terraform`,
    varFile: `${dir}/terraform.tfvars.json`,
    planFile: `${dir}/tfplan`,
  };
}

function terraform(ctx, args, options = {}) {
  const paths = containerPaths(ctx);
  return ctx.exec(['terraform', `-chdir=${stack}`, ...args], {
    ...options,
    env: { TF_DATA_DIR: paths.dataDir, ...(options.env ?? {}) },
  });
}

async function writeVariables(ctx, { desiredState }) {
  const { tenant, instances, operatorCidrs } = ctx;
  const byRole = Object.fromEntries(instances.map((instance) => [instance.role, instance]));
  const variables = {
    region: tenant.region,
    tenant_slug: tenant.slug,
    environment: tenant.environment,
    instance_types: {
      frontend: byRole.frontend.aws_type,
      backend: byRole.backend.aws_type,
      database: byRole.database.aws_type,
    },
    volume_sizes: {
      frontend: byRole.frontend.system_disk_gb,
      backend: byRole.backend.system_disk_gb,
      database: byRole.database.system_disk_gb,
    },
    operator_cidrs: operatorCidrs,
    desired_state: desiredState,
  };
  await writeFile(ctx.hostPaths.varFile, `${JSON.stringify(variables, null, 2)}\n`);
  ctx.log.system(`Variables del tenant: ${JSON.stringify({ ...variables, operator_cidrs: variables.operator_cidrs })}`);
}

module.exports = {
  name: 'terraform',
  implemented: true,

  writeVariables,

  async scan(ctx) {
    await ctx.exec(['bash', 'scripts/scan-terraform.sh'], { timeoutMs: 15 * 60_000 });
  },

  async init(ctx) {
    await terraform(ctx, [
      'init', '-input=false', '-no-color', '-reconfigure', '-lockfile=readonly',
      '-backend-config=backend.hcl', `-backend-config=key=tenants/${ctx.tenant.slug}/terraform.tfstate`,
    ], { timeoutMs: 10 * 60_000 });
  },

  async resources(ctx) {
    const { code, stdout, stderr } = await terraform(ctx, ['state', 'list'], { capture: true, quiet: true, allowFailure: true });
    if (code !== 0) {
      if (stderr.some((line) => /No state file was found/i.test(line))) return [];
      throw new Error('terraform state list falló');
    }
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  },

  // Devuelve un resumen del plan: recursos a crear, cambiar, reemplazar y destruir
  async plan(ctx, { destroy = false } = {}) {
    const paths = containerPaths(ctx);
    await terraform(ctx, [
      'plan', '-input=false', '-no-color', '-lock-timeout=60s',
      `-var-file=${paths.varFile}`, `-out=${paths.planFile}`, ...(destroy ? ['-destroy'] : []),
    ], { timeoutMs: 15 * 60_000 });
    const { stdout } = await terraform(ctx, ['show', '-json', '-no-color', paths.planFile], { capture: true, quiet: true });
    const changes = JSON.parse(stdout).resource_changes ?? [];
    const summary = { create: [], update: [], replace: [], delete: [] };
    for (const change of changes) {
      const actions = change.change.actions;
      if (actions.includes('delete') && actions.includes('create')) summary.replace.push(change.address);
      else if (actions.includes('delete')) summary.delete.push(change.address);
      else if (actions.includes('create')) summary.create.push(change.address);
      else if (actions.includes('update')) summary.update.push(change.address);
    }
    return summary;
  },

  async apply(ctx) {
    await terraform(ctx, ['apply', '-input=false', '-no-color', '-lock-timeout=60s', containerPaths(ctx).planFile], {
      timeoutMs: 30 * 60_000,
    });
  },

  // Relee las EC2 (p. ej. IP públicas nuevas tras reanudar) sin cambiar nada en AWS
  async refresh(ctx) {
    await terraform(ctx, [
      'apply', '-refresh-only', '-auto-approve', '-input=false', '-no-color', '-lock-timeout=60s',
      `-var-file=${containerPaths(ctx).varFile}`,
    ], { timeoutMs: 10 * 60_000 });
  },

  async outputs(ctx) {
    const { stdout } = await terraform(ctx, ['output', '-json', '-no-color'], { capture: true, quiet: true });
    const raw = JSON.parse(stdout || '{}');
    return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value.value]));
  },

  // RF-13: versiones exactas de los providers (lock file versionado)
  async versions(ctx) {
    const lock = await readFile(ctx.config.lockFile, 'utf8').catch(() => '');
    const providers = {};
    for (const match of lock.matchAll(/provider "([^"]+)" \{\s*version\s*=\s*"([^"]+)"/g)) {
      providers[match[1].replace('registry.terraform.io/', '')] = match[2];
    }
    return { providers };
  },

  // Variables de entorno para que los scripts del toolbox (inventario de
  // Ansible) lean los outputs de este tenant
  toolboxEnv(ctx) {
    return { TF_DIR: `/workspace/${stack}`, TF_DATA_DIR: containerPaths(ctx).dataDir };
  },
};
