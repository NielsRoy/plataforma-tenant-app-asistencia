const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');

// Secretos de cada tenant cifrados con AES-256-GCM.
// Formato de secrets_enc: iv (12 bytes) | tag (16 bytes) | datos cifrados.

function secretsKey(env = process.env) {
  const raw = env.PLATFORM_SECRETS_KEY?.trim();
  if (!raw) throw new Error('Configura PLATFORM_SECRETS_KEY (32 bytes en base64) para crear tenants.');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('PLATFORM_SECRETS_KEY debe tener 32 bytes codificados en base64.');
  return key;
}

function generateTenantSecrets() {
  return {
    tenant_db_password: randomBytes(32).toString('base64url'),
    tenant_jwt_secret: randomBytes(48).toString('base64url'),
    tenant_bootstrap_key: randomBytes(48).toString('base64url'),
  };
}

function encryptSecrets(key, secrets) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

function decryptSecrets(key, payload) {
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(12, 28));
  const text = Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8');
  return JSON.parse(text);
}

// Archivo de variables para Ansible (-e @archivo). Los valores son base64url,
// así que no necesitan escape en YAML.
function secretsYaml(secrets) {
  return `${Object.entries(secrets).map(([name, value]) => `${name}: "${value}"`).join('\n')}\n`;
}

module.exports = { secretsKey, generateTenantSecrets, encryptSecrets, decryptSecrets, secretsYaml };
