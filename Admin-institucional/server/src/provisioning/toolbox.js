const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const readline = require('node:readline');

// Ejecuta un comando dentro del toolbox Docker, igual que scripts/iac.ps1:
// monta el repositorio en /workspace, ~/.aws en solo lectura y las claves SSH.
// Cada línea de stdout/stderr se entrega a onLine (para el log de la operación).
function runToolbox(config, command, options = {}) {
  const { env = {}, onLine = () => {}, capture = false, timeoutMs = 30 * 60_000, name } = options;
  const args = ['run', '--rm', '-v', `${config.repoRoot}:/workspace`, '-w', '/workspace'];
  if (name) args.push('--name', name);
  if (existsSync(config.awsDir)) args.push('-v', `${config.awsDir}:/root/.aws:ro`);
  if (existsSync(config.sshDir)) args.push('-v', `${config.sshDir}:/mnt/ssh:ro`);

  // Solo nombres y rutas: los secretos nunca viajan como variables de entorno
  const variables = { ...(config.awsProfile ? { AWS_PROFILE: config.awsProfile } : {}), ...env };
  for (const [key, value] of Object.entries(variables)) args.push('-e', `${key}=${value}`);
  args.push(config.toolboxImage, ...command);

  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (name) spawn('docker', ['kill', name], { windowsHide: true, stdio: 'ignore' });
      child.kill();
    }, timeoutMs);

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      if (capture) stdout.push(line);
      else onLine('stdout', line);
    });
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      stderr.push(line);
      onLine('stderr', line);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`spawn docker ${error.code ?? ''}`.trim()), { stderr: [String(error.message)] }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // readline entrega las últimas líneas en el mismo ciclo; se espera un tick
      setImmediate(() => resolve({ code: timedOut ? 124 : code, timedOut, stdout: stdout.join('\n'), stderr }));
    });
  });
}

module.exports = { runToolbox };
