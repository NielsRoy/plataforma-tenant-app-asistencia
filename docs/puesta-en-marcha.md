# Puesta en marcha (guía para el equipo)

Pasos para levantar la plataforma en tu PC, **en este orden**. No pases al siguiente
paso hasta que el anterior muestre el resultado esperado. Los pasos marcados como
*pendiente* se completarán a medida que avance el proyecto.

Todos los comandos se ejecutan en **PowerShell** desde la raíz del repositorio. La
explicación detallada de cada comando está en
[comandos-manuales.md](comandos-manuales.md).

---

## Paso 1. Instalar los requisitos

| Programa | Para qué | Comprobar |
| --- | --- | --- |
| Git | Clonar el repositorio | `git --version` |
| Docker Desktop (en ejecución) | Toolbox IaC, Prometheus y Grafana | `docker version` |
| AWS CLI v2 | Configurar credenciales | `aws --version` |
| Node.js 22.12 o posterior | Plataforma y compilación de la app | `node --version` |
| OpenSSH Client (viene con Windows 10 y 11) | Generar la clave SSH | `ssh-keygen -?` |

No hace falta instalar Terraform, Packer ni Ansible: vienen dentro del toolbox Docker.

## Paso 2. Clonar el repositorio

```powershell
git clone https://github.com/NielsRoy/plataforma-tenant-app-asistencia.git control-asistencia-academica
cd control-asistencia-academica
git checkout niels-terraform
```

> Las AMIs de frontend y backend clonan la app desde este mismo repositorio en GitHub
> (rama `niels-terraform`). Por eso **los cambios en `admin-docente-alumno/` deben
> estar subidos con `git push` antes del paso 7**: Packer usa lo que está en GitHub, no
> tu copia local.

## Paso 3. Configurar las credenciales de AWS

```powershell
aws configure
aws sts get-caller-identity
```

En `aws configure`, ingresa tu *Access key* y tu *Secret key*, la región `us-east-1`
y el formato `json`.

✅ **Esperado:** `get-caller-identity` muestra tu número de cuenta.

> Cada integrante usa **su propia cuenta AWS**. El bucket del estado incluye el número
> de cuenta en su nombre, así que no hay conflictos entre cuentas. Si dos personas
> comparten una misma cuenta, solo una ejecuta el paso 6 y le pasa a la otra el archivo
> `infra/terraform/tenant/backend.hcl`.

## Paso 4. Construir el toolbox IaC

```powershell
docker build -t asistencia-iac-toolbox:1 infra/toolbox
./scripts/iac.ps1 toolbox-versions
./scripts/iac.ps1 bash -c "ls /root/.aws"
```

✅ **Esperado:**
- `toolbox-versions` muestra un JSON con terraform 1.16.6, packer 1.16.2, ansible 2.21.6, tflint 0.65.0, trivy 0.76.0 y checkov 3.4.5.
- El último comando lista `config` y `credentials`.

Si PowerShell bloquea el script, ejecútalo así:
`powershell -ExecutionPolicy Bypass -File ./scripts/iac.ps1 <comando>`.

## Paso 5. Generar la clave SSH del operador

```powershell
New-Item -ItemType Directory -Force "$HOME\.ssh\asistencia" | Out-Null
ssh-keygen -t ed25519 -f "$HOME\.ssh\asistencia\asistencia_ed25519" -C "asistencia-operator" -N '""'
```

✅ **Esperado:** se crean `asistencia_ed25519` (clave privada) y
`asistencia_ed25519.pub` (clave pública) en `~/.ssh/asistencia/`.

## Paso 6. Aplicar el bootstrap de Terraform (una vez por cuenta)

```powershell
./scripts/iac.ps1 terraform -chdir=infra/terraform/bootstrap init
./scripts/iac.ps1 terraform -chdir=infra/terraform/bootstrap plan -out=tfplan
./scripts/iac.ps1 terraform -chdir=infra/terraform/bootstrap apply tfplan
Get-Content infra/terraform/tenant/backend.hcl
```

✅ **Esperado:**
- El `plan` muestra `Plan: 9 to add`.
- El `apply` termina con `Apply complete! Resources: 9 added`.
- `backend.hcl` muestra tu bucket `asistencia-tfstate-<tu-cuenta>-us-east-1`.

⚠️ No borres `infra/terraform/bootstrap/terraform.tfstate`: queda solo en tu PC.

## Paso 7. Construir las AMIs con Packer (una vez por versión)

```powershell
./scripts/iac.ps1 packer validate infra/packer
./scripts/iac.ps1 packer build infra/packer
aws ec2 describe-images --owners self --filters "Name=tag:Project,Values=asistencia" --query "Images[].[Name,ImageId,State]" --output table
```

✅ **Esperado:**
- `validate` muestra `The configuration is valid.`
- `build` tarda entre 15 y 25 minutos y termina con 3 AMIs creadas: frontend, backend y database. Frontend y backend tardan más porque clonan y compilan la app.
- La tabla final muestra las 3 AMIs `available`.

Detalle y solución de problemas: [comandos-manuales.md §4](comandos-manuales.md#4-amis-con-packer-una-vez-por-versión-de-las-imágenes).

> **Opcional:** con los pasos 1 a 7 ya puedes crear un tenant completo a mano, sin la
> plataforma, siguiendo [tenant-manual.md](tenant-manual.md).

## Paso 8. Levantar Prometheus y Grafana (*pendiente*)

## Paso 9. Levantar la plataforma (*pendiente*)

## Paso 10. Crear el primer tenant desde la plataforma (*pendiente*)

---

## Para apagar todo y no gastar

- **Tenants:** suspéndelos o elimínalos desde la plataforma (*pendiente*).
- **Bootstrap:** solo al terminar el proyecto. Consulta [comandos-manuales.md §3.4](comandos-manuales.md#34-eliminar-el-bootstrap-solo-al-terminar-el-proyecto).
