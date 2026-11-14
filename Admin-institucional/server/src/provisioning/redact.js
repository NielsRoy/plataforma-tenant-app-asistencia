// Saneado de cada línea de log antes de guardarla: quita colores ANSI, los
// secretos conocidos del tenant y patrones típicos de credenciales.

const ansi = /\x1b\[[0-9;?]*[A-Za-z]/g;
const patterns = [
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[CLAVE_AWS]'],
  [/(aws_secret_access_key|aws_session_token)(\s*[=:]\s*)\S+/gi, '$1$2[SECRETO]'],
  [/((?:password|passwd|secret|bootstrap_key)["']?\s*[=:]\s*["']?)[^\s"',}]+/gi, '$1[SECRETO]'],
  [/(Authorization:\s*Bearer\s+)\S+/gi, '$1[SECRETO]'],
];

class Redactor {
  constructor(secretValues = []) {
    this.values = [];
    this.add(secretValues);
  }

  add(values) {
    for (const value of values) {
      if (typeof value === 'string' && value.length >= 8 && !this.values.includes(value)) this.values.push(value);
    }
  }

  redact(text) {
    let line = String(text).replace(ansi, '').replace(/\r/g, '');
    for (const value of this.values) line = line.split(value).join('[SECRETO]');
    for (const [pattern, replacement] of patterns) line = line.replace(pattern, replacement);
    return line;
  }
}

module.exports = { Redactor };
