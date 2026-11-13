# Comandos manuales del operador

Aquí están los comandos que **no** automatiza la plataforma: preparar el entorno,
crear los recursos únicos y construir las imágenes. Se ejecutan en orden y desde la
raíz del repositorio, en PowerShell.

La plataforma automatiza la creación, suspensión, reanudación y eliminación de los
tenants. La versión manual de esos pasos estará en la guía `tenant-manual.md`
(pendiente).

## 0. Requisitos en la PC

- Docker Desktop en ejecución
- AWS CLI v2. Solo se usa en Windows para `aws configure`; el toolbox lee `~/.aws`.
- Node.js 22.12 o posterior, para la plataforma y para compilar la app.

## 1. Credenciales de AWS (una vez)

```powershell
aws configure                    # Access key, secret key, region: us-east-1, output: json
aws sts get-caller-identity      # Debe mostrar tu cuenta
```

Las credenciales quedan en `~/.aws` y nunca se copian al repositorio.

## 2. Toolbox IaC (una vez, o cuando cambie `infra/toolbox/`)

```powershell
docker build -t asistencia-iac-toolbox:1 infra/toolbox
./scripts/iac.ps1 toolbox-versions
./scripts/iac.ps1 bash -c "ls /root/.aws"
```

- `toolbox-versions` muestra un JSON con las versiones de terraform, packer, ansible, tflint, trivy y checkov.
- `ls /root/.aws` debe listar `config` y `credentials`. Así se comprueba que el contenedor ve tus credenciales. La imagen no incluye aws-cli porque Terraform y Packer leen esas credenciales directamente.

Si PowerShell bloquea el script, ejecútalo con
`powershell -ExecutionPolicy Bypass -File ./scripts/iac.ps1 <comando>`.

Para abrir una terminal dentro del contenedor: `./scripts/iac.ps1 bash`.

## 3. Bootstrap de Terraform (una vez por cuenta AWS)

*Pendiente (commit 3).*

## 4. AMIs con Packer (una vez por versión de las imágenes)

*Pendiente.*
