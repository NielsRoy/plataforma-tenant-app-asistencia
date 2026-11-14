const { mkdir, rm, writeFile, rename } = require('node:fs/promises');
const path = require('node:path');

// Targets de Prometheus (file_sd): un archivo por tenant con los agentes de sus
// 3 EC2. Prometheus relee la carpeta sola. Las etiquetas tenant, environment y
// role permiten filtrar en Grafana. __metrics_path__ y __param_format adaptan
// el endpoint de Netdata, que no está en /metrics.
const exporters = [
  { exporter: 'node_exporter', port: 9100 },
  { exporter: 'process_exporter', port: 9256 },
  { exporter: 'otelcol', port: 8889 },
  { exporter: 'netdata', port: 19999, labels: { __metrics_path__: '/api/v1/allmetrics', __param_format: 'prometheus' } },
];

function targetGroups(tenant, outputs) {
  const groups = [];
  for (const role of ['frontend', 'backend', 'database']) {
    const ip = outputs.public_ips?.[role];
    if (!ip) continue;
    for (const { exporter, port, labels = {} } of exporters) {
      groups.push({
        targets: [`${ip}:${port}`],
        labels: {
          tenant: tenant.slug,
          environment: tenant.environment,
          role,
          exporter,
          instance: `${tenant.slug}-${role}`,
          ...labels,
        },
      });
    }
  }
  return groups;
}

async function writeTargets(config, tenant, outputs) {
  await mkdir(config.targetsDir, { recursive: true });
  const file = path.join(config.targetsDir, `${tenant.slug}.json`);
  // Escritura atómica: Prometheus nunca lee un archivo a medias
  await writeFile(`${file}.tmp`, `${JSON.stringify(targetGroups(tenant, outputs), null, 2)}\n`);
  await rename(`${file}.tmp`, file);
  return file;
}

async function removeTargets(config, slug) {
  await rm(path.join(config.targetsDir, `${slug}.json`), { force: true });
}

module.exports = { writeTargets, removeTargets, targetGroups };
