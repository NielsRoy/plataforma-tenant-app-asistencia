// Traduce la salida de las herramientas a un mensaje comprensible para el
// operador. El detalle técnico queda en el log de la operación.

class OperationError extends Error {
  constructor(message) {
    super(message);
    this.userMessage = message;
  }
}

const known = [
  [/Cannot connect to the Docker daemon|error during connect|docker: command not found|spawn docker ENOENT|The system cannot find the file specified.*docker/i,
    'Docker Desktop no está en ejecución en la PC de la plataforma.'],
  [/Unable to find image .*iac-toolbox|pull access denied for asistencia-iac-toolbox/i,
    'Falta la imagen del toolbox. Constrúyela con: docker build -t asistencia-iac-toolbox:1 infra/toolbox'],
  [/InvalidClientTokenId|AuthFailure|ExpiredToken|UnrecognizedClientException|no valid credential sources|NoCredentialProviders/i,
    'AWS rechazó las credenciales. Revisa aws configure en la PC de la plataforma.'],
  [/UnauthorizedOperation|AccessDenied/i,
    'Las credenciales de AWS no tienen permiso para esta operación.'],
  [/VcpuLimitExceeded|InstanceLimitExceeded/i,
    'La cuenta de AWS alcanzó su límite de instancias o de vCPU. Suspende o elimina otro tenant.'],
  [/InsufficientInstanceCapacity/i,
    'AWS no tiene capacidad para ese tipo de instancia en la zona. Reintenta más tarde.'],
  [/not eligible for Free Tier|FreeTier/i,
    'El tipo de instancia no es elegible para el Free Tier de la cuenta.'],
  [/Your query returned no results|no matching EC2 AMI found/i,
    'No hay AMIs del proyecto en la cuenta. Constrúyelas con Packer (docs/comandos-manuales.md §4).'],
  [/Error acquiring the state lock|PreconditionFailed/i,
    'El estado del tenant está bloqueado por otro proceso de Terraform. Espera a que termine y reintenta.'],
  [/UNREACHABLE!|Connection timed out during banner exchange|Permission denied \(publickey\)/i,
    'Ansible no pudo conectarse por SSH a las EC2. Revisa que tu IP no haya cambiado y que la clave esté en ~/.ssh/asistencia.'],
];

function explainFailure(step, recentLines) {
  const text = recentLines.join('\n');
  for (const [pattern, message] of known) {
    if (pattern.test(text)) return message;
  }
  return `Falló el paso "${step}". Revisa el log de la operación.`;
}

module.exports = { OperationError, explainFailure };
