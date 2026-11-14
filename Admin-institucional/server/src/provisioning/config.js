const os = require('node:os');
const path = require('node:path');

// Configuración del aprovisionamiento. Todo tiene un valor por defecto pensado
// para la PC del operador; las variables de entorno permiten cambiarlo.
function provisioningConfig(env = process.env) {
  const repoRoot = path.resolve(env.PLATFORM_REPO_ROOT?.trim() || path.join(__dirname, '..', '..', '..', '..'));
  const operatorCidrs = (env.PLATFORM_OPERATOR_CIDRS ?? '').split(',').map((cidr) => cidr.trim()).filter(Boolean);
  return {
    repoRoot,
    workspacesDir: path.join(repoRoot, '.workspaces'),
    targetsDir: path.join(repoRoot, 'monitoring', 'prometheus', 'targets'),
    backendConfig: path.join(repoRoot, 'infra', 'terraform', 'tenant', 'backend.hcl'),
    lockFile: path.join(repoRoot, 'infra', 'terraform', 'tenant', '.terraform.lock.hcl'),
    toolboxImage: env.IAC_TOOLBOX_IMAGE?.trim() || 'asistencia-iac-toolbox:1',
    awsDir: path.join(os.homedir(), '.aws'),
    sshDir: env.ASISTENCIA_SSH_DIR?.trim() || path.join(os.homedir(), '.ssh', 'asistencia'),
    awsProfile: env.AWS_PROFILE?.trim() || '',
    // Vacío = se detecta la IP pública de esta PC en cada operación
    operatorCidrs,
    supportedRegions: ['us-east-1'],
    workerEnabled: (env.PLATFORM_WORKER ?? 'on').trim().toLowerCase() !== 'off',
    pollIntervalMs: 2000,
    heartbeatMs: 15000,
    staleAfterMs: 120000,
  };
}

module.exports = { provisioningConfig };
