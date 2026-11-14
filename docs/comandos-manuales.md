# Comandos manuales del operador

Aquí están los comandos que **no** automatiza la plataforma: preparar el entorno,
crear los recursos únicos y construir las imágenes. Se ejecutan en orden y desde la
raíz del repositorio, en PowerShell.

La plataforma automatiza la creación, suspensión, reanudación y eliminación de los
tenants. La versión manual de esos pasos está en [tenant-manual.md](tenant-manual.md).

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

> **Cuidado con PowerShell 5.1.** Si un argumento empieza con `-` y tiene un punto
> después del `=`, PowerShell lo parte en dos: `-out=plan.tfplan` llega como
> `-out=plan` y `.tfplan`. Para evitarlo, usa valores sin punto (`-out=tfplan`) o pon
> el argumento entre comillas (`"-out=plan.tfplan"`).

## 3. Bootstrap de Terraform (una vez por cuenta AWS)

El bootstrap crea los recursos que comparten todos los tenants. Su código está en
`infra/terraform/bootstrap`:
- el bucket S3 del estado remoto
- el key pair SSH del operador
- el archivo `infra/terraform/tenant/backend.hcl`

### 3.1 Clave SSH del operador

Ansible usa esta clave para entrar a las EC2. Queda fuera del repositorio, en
`~/.ssh/asistencia/`, y el toolbox la monta automáticamente.

```powershell
New-Item -ItemType Directory -Force "$HOME\.ssh\asistencia" | Out-Null
ssh-keygen -t ed25519 -f "$HOME\.ssh\asistencia\asistencia_ed25519" -C "asistencia-operator" -N '""'
```

`-N '""'` deja la clave sin passphrase para que la plataforma pueda usarla sin
intervención. El `'""'` es necesario en PowerShell 5.1 para pasar una cadena vacía.

### 3.2 Aplicar el bootstrap

```powershell
./scripts/iac.ps1 terraform -chdir=infra/terraform/bootstrap init
./scripts/iac.ps1 terraform -chdir=infra/terraform/bootstrap plan -out=tfplan
./scripts/iac.ps1 terraform -chdir=infra/terraform/bootstrap apply tfplan
./scripts/iac.ps1 terraform -chdir=infra/terraform/bootstrap output
```

| Comando | Qué hace |
| --- | --- |
| `init` | Descarga los providers `aws` y `local` y crea `.terraform.lock.hcl`. Ese archivo **sí se versiona** para fijar las versiones exactas de los providers. |
| `plan` | Debe proponer 9 recursos: bucket, ownership, bloqueo público, versionado, cifrado, ciclo de vida, política TLS, key pair y `backend.hcl`. |
| `apply` | Crea los recursos. El estado del bootstrap queda en `infra/terraform/bootstrap/terraform.tfstate`, que es local y está ignorado por git. **No lo borres**: sin él, Terraform no sabe que el bucket ya existe. |
| `output` | Muestra `state_bucket`, `key_pair_name`, `default_vpc_id` y la ruta de `backend.hcl`. |

### 3.3 Verificar

```powershell
Get-Content infra/terraform/tenant/backend.hcl
aws s3api get-bucket-versioning --bucket <state_bucket>
aws s3api get-bucket-encryption --bucket <state_bucket>
aws ec2 describe-key-pairs --key-names asistencia-operator
```

`<state_bucket>` es el valor del output `state_bucket`. El primer comando debe mostrar
el bucket, `encrypt = true` y `use_lockfile = true`.

### 3.4 Eliminar el bootstrap (solo al terminar el proyecto)

Primero elimina todos los tenants. Después vacía el bucket, que tiene versionado
activado, y ejecuta:

```powershell
./scripts/iac.ps1 terraform -chdir=infra/terraform/bootstrap destroy
```

## 4. AMIs con Packer (una vez por versión de las imágenes)

Packer construye las 3 imágenes que usan todos los tenants: `frontend`, `backend` y
`database`. **No se construyen por tenant.** Solo se reconstruyen cuando cambian los
roles de Ansible o la versión de algún agente.

Cómo funciona `packer build`:
1. Lanza 3 EC2 `t3.micro` temporales en paralelo, a partir de la AMI oficial más reciente de Ubuntu 24.04.
2. Crea un Security Group temporal que solo admite SSH desde tu IP.
3. Ejecuta `infra/ansible/playbooks/image.yml` en cada máquina: el rol `common` instala los agentes de monitoreo y el rol de cada imagen instala lo suyo (nginx, Node.js 22 o PostgreSQL 16).
4. En frontend y backend, clona desde GitHub solo `admin-docente-alumno/client` o `/server`, compila y borra el código fuente. La imagen queda con la app lista; cada tenant solo le agrega su configuración y sus secretos.
5. Limpia la máquina (machine-id, claves SSH), crea la AMI y termina la EC2 temporal.

> **Antes del build, haz `git push`.** Packer clona la app desde GitHub
> (`app_repo_url`, por defecto tu repo, y `app_repo_ref`, por defecto `niels-terraform`),
> no desde tu copia local. Para otra rama o tag:
> `-var app_repo_ref=main`.
>
> **Cada cambio en el código de la app exige reconstruir frontend y backend** con un
> `image_version` nuevo. Los tenants nuevos usarán esa versión; los existentes siguen
> con la suya.

### 4.1 Validar y construir

```powershell
./scripts/iac.ps1 packer validate infra/packer
./scripts/iac.ps1 packer build infra/packer
```

El `build` tarda entre 15 y 25 minutos. Al final muestra algo como:

```
==> Builds finished. The artifacts of successful builds are:
--> asistencia.amazon-ebs.frontend: AMIs were created:
us-east-1: ami-0123...
--> asistencia.amazon-ebs.backend: ...
--> asistencia.amazon-ebs.database: ...
```

También genera `infra/packer/manifest.json` (ignorado por git) con los IDs de las AMIs.

**Construir una sola imagen**, por ejemplo tras cambiar solo el rol `backend`:

```powershell
./scripts/iac.ps1 packer build "-only=asistencia.amazon-ebs.backend" infra/packer   # comillas: PowerShell 5.1
```

**Nueva versión de imágenes**:

```powershell
./scripts/iac.ps1 packer build -var image_version=1.1.0 infra/packer
```

**Nueva versión de la app** (solo frontend y backend; la de database no cambia):

```powershell
./scripts/iac.ps1 packer build "-only=asistencia.amazon-ebs.frontend,asistencia.amazon-ebs.backend" -var image_version=1.1.0 infra/packer
```

Cada AMI aparece dos veces en el resumen final porque el post-processor `manifest`
también cuenta como artefacto. Solo se crea una AMI por imagen.

Terraform usa siempre la AMI más reciente de cada rol (tags `Project=asistencia` y
`Role=<rol>`).

### 4.2 Verificar

```powershell
aws ec2 describe-images --owners self --filters "Name=tag:Project,Values=asistencia" --query "Images[].[Name,ImageId,State]" --output table
aws ec2 describe-images --owners self --filters "Name=tag:Role,Values=backend" --query "Images[].Tags[?Key=='AppRef'].Value" --output text
```

Deben aparecer las AMIs en estado `available`. El segundo comando muestra la rama de
la app incluida en el backend. El commit exacto queda dentro de cada EC2, en
`/etc/asistencia/image-release`.

### 4.3 Si algo falla

- **El build se interrumpe:** Packer termina la EC2 temporal y borra el SG y el key pair temporales. Revisa en la consola de EC2 que no haya quedado ninguna instancia `packer-build-asistencia` en ejecución.
- **Ver más detalle:** ejecuta `$env:PACKER_LOG=1` y vuelve a lanzar el build; `scripts/iac.ps1` pasa la variable al contenedor. Para desactivarlo: `Remove-Item env:PACKER_LOG`.

### 4.4 Costos y limpieza

- Cada build usa hasta 3 `t3.micro` durante unos 20 minutos, dentro del Free Tier.
- Cada AMI guarda un snapshot EBS de 8 GB, cifrado. Se cobra solo el espacio usado, unos 2 a 3 GB por imagen.

Al borrar una AMI antigua hay que borrar **también su snapshot**: si no, AWS sigue
cobrando el almacenamiento.

**Desde la CLI.** Primero se obtiene el snapshot a partir de la AMI. Las AMIs de la
versión 1.0.0 no tienen tags en el snapshot; desde la 1.1.0 sí.

```powershell
aws ec2 describe-images --image-ids <ami-id> --query "Images[0].BlockDeviceMappings[].Ebs.SnapshotId" --output text
aws ec2 deregister-image --image-id <ami-id>
aws ec2 delete-snapshot --snapshot-id <snap-id>
```

**Desde la consola web** (región `us-east-1`, N. Virginia):
1. Entra a **EC2** → menú izquierdo **Images → AMIs** (`https://us-east-1.console.aws.amazon.com/ec2/home?region=us-east-1#Images:visibility=owned-by-me`).
2. Selecciona la AMI y anota el **Snapshot ID** que aparece en la pestaña **Storage** (*Block devices*).
3. **Actions → Deregister AMI → Deregister**. En consolas recientes, marca **Delete associated snapshots** y omite el paso 4.
4. Menú izquierdo **Elastic Block Store → Snapshots**, selecciona el snapshot anotado → **Actions → Delete snapshot → Delete**.

## 5. Tenants a mano

Crear, desplegar, suspender, reanudar y eliminar un tenant sin la plataforma, comando
por comando: [tenant-manual.md](tenant-manual.md).
