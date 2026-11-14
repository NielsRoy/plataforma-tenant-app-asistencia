# Estructura del repositorio

Este documento explica para qué sirve cada carpeta que se agregó para la
infraestructura y qué contiene o contendrá. Las carpetas marcadas como *pendiente*
se crean en pasos posteriores.

```
control-asistencia-academica/
├── Admin-institucional/      Plataforma de tenants (API Express + React): ya existía
├── admin-docente-alumno/     Aplicación de asistencia que se despliega por tenant: ya existía
├── docs/                     Documentación de arquitectura, estructura y comandos
├── scripts/                  Scripts de ayuda para el operador
├── infra/                    Todo el código de infraestructura
│   ├── toolbox/              Imagen Docker con las herramientas IaC
│   ├── terraform/            Código Terraform
│   │   ├── bootstrap/        Recursos que se crean una sola vez
│   │   ├── modules/tenant/   Módulo reutilizable de un tenant
│   │   └── tenant/           Stack raíz que se aplica por cada tenant
│   ├── packer/               Plantilla de las AMIs
│   ├── ansible/              Roles y playbooks
│   └── cloud-init/           Plantilla de primer arranque
├── monitoring/               Prometheus y Grafana con docker compose
├── .workspaces/              Archivos de trabajo por tenant (secretos, inventario). No se versiona
├── .gitattributes            Fuerza finales de línea LF en scripts y plantillas
└── .gitignore                Excluye estado de Terraform, *.tfvars, claves, artefactos
```

## Cambios en `admin-docente-alumno/` para la infraestructura

| Archivo | Para qué sirve |
| --- | --- |
| `server/src/telemetry.ts` | Métricas OpenTelemetry del backend: latencia y código de respuesta HTTP (`http.server.request.duration`) y consultas a PostgreSQL. Se activa con `OTEL_ENABLED=true` y envía por OTLP al collector de la misma EC2 (`localhost:4318`). Con la variable desactivada, que es lo normal en desarrollo local, no hace nada. |
| `server/src/main.ts` | Importa `./telemetry` como primer módulo, para que la instrumentación intercepte `http`, `express` y `pg` antes de que se carguen. |
| `server/.env.example` | Documenta `OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` y `APP_VERSION`. |

## Cambios en `Admin-institucional/` para el aprovisionamiento

| Archivo | Para qué sirve |
| --- | --- |
| `server/src/migrations/005_provisioning.sql` | Modelo de datos del aprovisionamiento. Se aplica solo al iniciar la API o con `npm run db:migrate`. Ver la tabla de abajo. |
| `server/src/runtime/server.js` | Inicia el worker de aprovisionamiento junto con la API y lo detiene al cerrar. Monta la API del ciclo de vida. Al registrar un tenant copia el `plan_id` de la solicitud y limita el slug a 42 caracteres. Muestra errores claros si un plan usa un tipo o un disco fuera del Free Tier. |
| `server/.env.example` | Agrega `PLATFORM_SECRETS_KEY` (clave AES-256 de los secretos de los tenants) y las opciones del worker: `PLATFORM_WORKER`, `PLATFORM_OPERATOR_CIDRS`, `AWS_PROFILE` y `PLATFORM_REPO_ROOT`. |
| `client/src/platform/CreatePlanDialog.tsx` | El tipo de AWS pasa a ser una lista con los 4 tipos permitidos, y el disco admite de 8 a 30 GB. |
| `client/src/platform/TenantOps.tsx` | Vista **Instituciones**: lista con filtros por nombre, estado, plan y entorno (RF-14). El detalle muestra la configuración, la infraestructura (EC2, IPs y AMIs) y las acciones permitidas: crear o reintentar, suspender, reanudar, volver a desplegar y eliminar (RF-16/17/18). Cada operación se sigue **en vivo**, con sus pasos y su log consultados cada 2 s (RF-11). El diálogo de eliminación muestra la vista previa del estado real y pide escribir el slug. |
| `client/src/platform/tenant-ops.css` | Estilos de esa vista: estados, pasos, log y diálogo de eliminación. |
| `client/src/platform/CreateTenantDialog.tsx` | **Crear institución** ya no es una vista previa: llama a `POST /api/platform/tenants` y abre el detalle con el despliegue en curso. Muestra los tipos de instancia de cada plan (RF-03). Azure, otras regiones, OpenTofu, Pulumi y CloudFormation aparecen deshabilitados (RF-08). |
| `client/src/platform/PlatformAdmin.tsx` | En **Solicitudes**, el botón **Registrar y desplegar** registra la institución y encola su creación. Se quitaron las vistas previas locales. La vinculación manual de una instalación externa se mantiene solo para tenants sin desplegar. |
| `client/src/platform/api.ts`, `tenant-options.ts` | Tipos de tenants, operaciones y logs. Las opciones disponibles de proveedor, región y motor. Las etiquetas en español de estados, operaciones y pasos. Un slug de 42 caracteres como máximo. |
| `server/src/provisioning/` | Worker y motor de aprovisionamiento. Ver la tabla siguiente. |
| `server/package.json` | Script `npm run op` (CLI de la cola) y `npm run check` con los archivos nuevos. |
| `server/src/runtime/tenants.js` | API del ciclo de vida de los tenants. Ver la tabla siguiente. |
| `server/src/runtime/alerts.js` | `POST /api/platform/alerts/webhook` recibe las alertas de Grafana. Lo valida con `PLATFORM_ALERTS_TOKEN` (no con la sesión del operador) y admite hasta 1 MB por lote. Las guarda en `platform_alerts` sin duplicar: usa la clave `fingerprint` más `startsAt`, y al resolverse actualiza la misma fila. `GET /api/platform/alerts?status=&tenant=` las lista para la interfaz (RF-28, RF-29). |
| `client/src/platform/PlatformMonitoring.tsx` | La vista **Monitoreo** ya no usa datos de demostración. Muestra un resumen (activas, suspendidas, con error, alertas activas), el estado de cada institución con su número de alertas y la lista de alertas activas o el historial, filtrable por institución. Tiene enlaces al dashboard, a las reglas de Grafana y a los targets de Prometheus. Se actualiza cada 15 s. |
| `server/src/runtime/invitations.js` | `tenantIsActivated(url, { trusted })`: acepta la URL `http://<IP>` de un tenant creado por la plataforma, que no está en `PLATFORM_TENANT_ORIGINS`. |

**Qué agrega `005_provisioning.sql`:**

| Objeto | Contenido |
| --- | --- |
| `platform_tenants` (columnas nuevas) | `status` (`pending`, `provisioning`, `active`, `suspending`, `suspended`, `resuming`, `deleting`, `deleted`, `failed`), `plan_id`, `outputs` (contrato de outputs del motor IaC, sin secretos), `secrets_enc` (secretos cifrados con AES-256-GCM), `status_updated_at` y `deleted_at`. El slug y la URL solo son únicos entre los tenants no eliminados, así que un tenant eliminado libera los suyos. |
| `platform_operations` | Una fila por operación (`create`, `suspend`, `resume`, `delete`, `redeploy`), con su estado (`queued`, `running`, `succeeded`, `failed`, `cancelled`), parámetros, pasos, error legible y versiones usadas (RF-13). Admite una sola operación activa por tenant. Tiene columnas reservadas para reintentos (`retry_of`, `attempt`) y auditoría (`requested_by`). |
| `platform_operation_logs` | Log saneado línea por línea, por paso: `scan`, `init`, `plan`, `apply`, `ansible`… La interfaz lo lee mientras la operación avanza. |
| `platform_alerts` | Alertas que Grafana envía por webhook, asociadas al tenant, al entorno y al rol. |
| Planes | Pasan a tipos del Free Tier, todos x86_64 como las AMIs. Una restricción impide otros tipos y discos fuera de 8 a 30 GB. |

**Planes con los tipos del Free Tier:**

| Plan | Frontend | Backend | Base de datos | Disco total |
| --- | --- | --- | --- | --- |
| Básico | t3.micro (1 GiB) | t3.micro (1 GiB) | t3.micro (1 GiB) | 24 GB |
| Estándar | t3.micro (1 GiB) | t3.small (2 GiB) | t3.small (2 GiB) | 26 GB |
| Avanzado | t3.small (2 GiB) | c7i-flex.large (4 GiB) | m7i-flex.large (8 GiB) | 28 GB |

**API del ciclo de vida** (`server/src/runtime/tenants.js`, bajo `/api/platform`, con sesión de operador):

| Método y ruta | Qué hace | Requisito |
| --- | --- | --- |
| `GET /engines` | Motores IaC y cuáles están implementados (solo Terraform). | RF-08 |
| `GET /tenants?name=&status=&plan=&environment=` | Lista con filtros. Por defecto oculta los eliminados. Cada tenant trae su estado, su plan, la infraestructura (outputs), la última operación y las operaciones que admite. | RF-14 |
| `POST /tenants` | `{ requestId, slug, region, environment, engine }` registra esa solicitud y encola su creación. Sin `requestId`, recibe también `institutionName`, `adminName`, `adminEmail` y `planId` y da de alta la institución directamente. Responde `202` con la operación. Rechaza motores no implementados y regiones sin AMIs. | RF-07 |
| `GET /tenants/:id` | Detalle con las últimas 20 operaciones. Comprueba si el administrador ya activó su cuenta. | RF-14 |
| `POST /tenants/:id/operations` | `{ kind: create \| suspend \| resume \| redeploy }`. Solo admite lo que permite el estado del tenant, y nunca dos operaciones a la vez. Repetir `create` sobre un tenant `failed` es seguro, porque todos los pasos son idempotentes. | RF-12, RF-16, RF-17 |
| `GET /tenants/:id/deletion-preview` | Lee el estado real (`terraform state list`) y devuelve los recursos (sin las consultas `data.*`), un resumen, qué datos se pierden y el slug que hay que escribir para confirmar. | RF-18 |
| `DELETE /tenants/:id` | `{ confirmSlug }`: si coincide con el slug, encola la eliminación. | RF-18 |
| `POST /tenants/:id/invitation` | Reenvía la invitación del administrador con la clave guardada cifrada. En modo preview devuelve el enlace. | — |
| `GET /operations/:id` | Estado, pasos con sus tiempos, error legible y versiones usadas. | RF-11, RF-13 |
| `GET /operations/:id/logs?after=N` | Log saneado por partes. La interfaz lo consulta cada pocos segundos con el último `id` visto. | RF-11 |

Todas las operaciones son asíncronas: la API responde enseguida con la operación en cola y el
worker la ejecuta. El slug admite de 3 a 42 caracteres, el mismo límite del módulo de Terraform.

**`server/src/provisioning/`: worker y motores**

El worker corre dentro de la API (`npm start`). Toma las operaciones de la cola y ejecuta
en el toolbox Docker los mismos comandos de [tenant-manual.md](tenant-manual.md).

| Archivo | Para qué sirve |
| --- | --- |
| `config.js` | Rutas (repositorio, `.workspaces/`, targets de Prometheus), imagen del toolbox, `~/.aws`, `~/.ssh/asistencia` y opciones del worker. |
| `worker.js` | Toma una operación a la vez con `FOR UPDATE SKIP LOCKED`, marca un latido cada 15 s y, al iniciar, marca como fallidas las operaciones que quedaron a medias. Al cerrar la API espera a que termine la operación en curso. |
| `queue.js` | `enqueueOperation()`: valida qué operación admite cada estado del tenant (por ejemplo, `resume` solo si está `suspended`) y rechaza una segunda operación activa. |
| `pipeline.js` | Los pasos de cada operación (`create`, `suspend`, `resume`, `redeploy`, `delete`), el cambio de estado del tenant y la protección del plan: aborta si crear, suspender o reanudar quiere destruir o reemplazar una EC2, un disco o la IP elástica. |
| `engines/` | Interfaz común de motores. `terraform.js` usa `infra/terraform/tenant` con un `TF_DATA_DIR` propio por tenant (`.workspaces/<slug>/.terraform`). `pulumi.js`, `cloudformation.js` y `opentofu.js` son puntos de extensión: el worker responde "no implementado". |
| `toolbox.js` | Ejecuta `docker run` del toolbox con los mismos montajes que `scripts/iac.ps1`. Los secretos nunca viajan como variables de entorno. |
| `crypto.js` | Genera los secretos del tenant y los cifra con AES-256-GCM (`PLATFORM_SECRETS_KEY`). Para Ansible se escriben en un archivo temporal que se borra al terminar el paso. |
| `redact.js` | Sanea cada línea del log: valores de los secretos del tenant, claves de AWS, `password=`, `Authorization: Bearer` y colores ANSI. |
| `oplog.js` | Guarda los pasos y el log por lotes en `platform_operations` y `platform_operation_logs`. |
| `errors.js` | Traduce fallos conocidos a mensajes para el operador: Docker apagado, credenciales de AWS, límite de vCPU, sin AMIs, estado bloqueado, SSH… |
| `targets.js` | Escribe `monitoring/prometheus/targets/<slug>.json` (file_sd) con los 4 agentes de cada EC2 y las etiquetas `tenant`, `environment`, `role`, `exporter`, `instance` y `public_ip`. Lo retira al suspender o eliminar. |
| `cli.js` | `npm run op -- enqueue <slug> <operación>`, `list` y `logs <id> --follow`, para usar la cola antes de que exista la interfaz. |

| Operación | Pasos |
| --- | --- |
| `create` | preparar → escanear → init → plan → apply → outputs → ansible → salud → invitacion → monitoreo |
| `suspend` | preparar → init → plan → apply → monitoreo |
| `resume` | preparar → init → plan → apply → refrescar → outputs → salud → monitoreo |
| `redeploy` | preparar → init → outputs → ansible → salud → monitoreo |
| `delete` | preparar → init → plan (vista previa) → apply (destroy) → monitoreo → limpieza |

En "preparar" se registran las versiones usadas (RF-13): las del toolbox, los providers del lock file, el commit del repositorio y los tipos de instancia. En "outputs" se agregan las AMIs.

## `docs/`
Documentación del proyecto. Incluye los entregables de diagrama de arquitectura, flujo
de creación y, más adelante, el catálogo de planes y las instrucciones de operación.
El índice está en [README.md](README.md).

## `scripts/`
Scripts que el operador ejecuta desde su PC. No contienen lógica de infraestructura,
solo facilitan el uso de las herramientas.

| Archivo | Para qué sirve |
| --- | --- |
| `iac.ps1` | Ejecuta cualquier comando dentro del toolbox Docker desde PowerShell. Monta el repositorio, `~/.aws` (solo lectura) y las claves SSH del proyecto. |
| `iac.sh` | Lo mismo para Linux, WSL o Git Bash. |
| `scan-terraform.sh` | Se ejecuta dentro del toolbox. Corre tflint, trivy y checkov sobre el stack del tenant, muestra cada comando con su salida y termina con un resumen. No bloquea. Ver [escaneres.md](escaneres.md). |
| `tenant-secrets.sh` | Dentro del toolbox. Genera **una sola vez** los secretos de un tenant (contraseña de la BD, `JWT_SECRET` y clave de invitación) en `.workspaces/<slug>/secrets.yml`, con permisos `600`. No los imprime. La plataforma, en cambio, los guardará cifrados en su BD. |
| `tenant-inventory.sh` | Dentro del toolbox. Crea `.workspaces/<slug>/inventory.json` (inventario de Ansible) a partir de `terraform output -json`. Se niega si el estado es de otro tenant o si el tenant está suspendido. |
| `deploy-tenant.sh` | Dentro del toolbox. Genera el inventario y ejecuta `deploy-tenant.yml` con los secretos. |
| `tenant-invite.sh` | Dentro del toolbox. Pide a la app del tenant la invitación del primer administrador y muestra el enlace `/activar#token=...`. Es lo mismo que hará la plataforma. |

Ejemplo: `./scripts/iac.ps1 terraform -chdir=infra/terraform/bootstrap plan`.

## `infra/toolbox/`
Imagen Docker `asistencia-iac-toolbox:1` con versiones fijas de Terraform, Packer,
ansible-core, tflint, trivy y checkov. Existe por dos razones:
- Ansible no corre nativo en Windows.
- Todos los integrantes, y la propia plataforma, deben usar las mismas versiones.

| Archivo | Para qué sirve |
| --- | --- |
| `Dockerfile` | Define la imagen y las versiones de cada herramienta. |
| `requirements.yml` | Colecciones de Ansible que se instalan en la imagen. |
| `entrypoint.sh` | Copia las claves SSH con permisos `600` antes de ejecutar el comando. |
| `toolbox-versions.sh` | Imprime las versiones en JSON. La plataforma lo guarda en cada despliegue (RF-13). |

## `infra/terraform/`

El archivo `.tflint.hcl` de esta carpeta configura tflint para todos los stacks: preset
`recommended` y ruleset de AWS 0.50.0.

### `bootstrap/`
Se aplica **una sola vez** por cuenta AWS. Su propio estado queda en local
(`terraform.tfstate`, ignorado por git), porque es quien crea el bucket remoto.

| Archivo | Para qué sirve |
| --- | --- |
| `versions.tf` | Versión mínima de Terraform, providers (`aws ~> 6.0`, `local`) y etiquetas por defecto (`Project`, `Component`, `ManagedBy`). |
| `variables.tf` | Región, prefijo del proyecto, ruta de la clave pública SSH y días que se retienen las versiones antiguas del estado. |
| `main.tf` | Bucket S3 del estado (versionado, cifrado SSE-S3, bloqueo de acceso público, política solo-HTTPS y ciclo de vida), key pair `asistencia-operator`, comprobación de que existe la VPC por defecto y generación de `../tenant/backend.hcl`. |
| `outputs.tf` | Cuenta, región, bucket, key pair, VPC por defecto y ruta de `backend.hcl`. |
| `terraform.tfvars.example` | Ejemplo para cambiar los valores por defecto. El `terraform.tfvars` real no se versiona. |
| `.terraform.lock.hcl` | Lo genera `terraform init`. Fija las versiones exactas de los providers y **sí se versiona**. |

### `modules/tenant/`
Módulo reutilizable con todo lo de **un** tenant. No sabe nada del estado remoto ni
de la plataforma: recibe variables y devuelve el contrato de outputs.

| Archivo | Para qué sirve |
| --- | --- |
| `versions.tf` | Versión mínima de Terraform y provider `aws ~> 6.0`. |
| `variables.tf` | `tenant_slug` (validado: minúsculas, números y guiones, de 3 a 42 caracteres, igual que exige la app para la invitación), `environment` (`production` o `staging`), `instance_types` y `volume_sizes` por rol (los define el plan), `image_version` (`null` = AMI más reciente), `operator_cidrs` (tu IP; rechaza `0.0.0.0/0`), puertos de métricas, zona y `desired_state` (`running` o `stopped`). |
| `main.tf` | Lee la VPC por defecto y elige una zona que ofrezca los tipos de instancia del plan. Busca las AMIs por los tags `Project` y `Role`. Crea un Security Group por rol con las reglas de la tabla de abajo, las 3 EC2 (IMDSv2, disco gp3 cifrado, cloud-init en `user_data`), la IP elástica del frontend y un `aws_ec2_instance_state` por EC2 para suspender y reanudar. |
| `outputs.tf` | Contrato de outputs: `app_url`, `frontend_public_ip`, `backend_private_ip`, `database_private_ip`, `public_ips`, `private_ips`, `instance_ids`, `ami_ids`, `security_group_ids`… Un motor futuro (Pulumi, CloudFormation) debe devolver los mismos nombres. |

| Security Group | Entrada permitida |
| --- | --- |
| `asistencia-<slug>-frontend` | `:80` desde internet |
| `asistencia-<slug>-backend` | `:3000` solo desde el SG frontend **del mismo tenant** |
| `asistencia-<slug>-database` | `:5432` solo desde el SG backend **del mismo tenant** |
| Los 3 | `:22`, `:9100`, `:9256`, `:8889` y `:19999` solo desde `operator_cidrs` |

Las EC2 ignoran cambios de `ami`, `user_data` y `associate_public_ip_address` (`ignore_changes`). El último evita que reanudar un tenant suspendido recree backend y database, porque con la EC2 detenida AWS le quita la IP pública. Así, una AMI nueva
**no reemplaza** la EC2 de base de datos ni borra sus datos. Para actualizar una EC2 a
propósito se usa `terraform apply -replace=...`.

### `tenant/`
Stack raíz que se aplica **una vez por tenant**. Cada tenant tiene su propio estado
en S3 (`tenants/<slug>/terraform.tfstate`), así que un error en uno no afecta a los
demás.

| Archivo | Para qué sirve |
| --- | --- |
| `versions.tf` | Backend `s3` parcial (los datos vienen de `backend.hcl` y la key de `-backend-config`), provider y etiquetas por defecto (`Project`, `Component=tenant`, `ManagedBy`). |
| `variables.tf`, `main.tf` | Pasan las variables al módulo `../modules/tenant`. |
| `outputs.tf` | Reexpone el contrato de outputs. Lo leen `terraform output -json`, la plataforma y el inventario de Ansible. |
| `demo.tfvars.example` | Ejemplo de variables de un tenant. Los `.tfvars` reales no se versionan. |
| `backend.hcl` | Lo genera el bootstrap. No se versiona. |
| `.terraform.lock.hcl` | Versiones exactas de los providers. **Sí se versiona**. |

## `infra/packer/`
Plantilla para construir las 3 AMIs (`frontend`, `backend`, `database`). Se construyen
**una vez por versión**, no por tenant.

| Archivo | Para qué sirve |
| --- | --- |
| `asistencia.pkr.hcl` | Plantilla de las imágenes. Parte de la AMI oficial de Ubuntu 24.04 y construye las 3 imágenes en paralelo como 3 `source` con nombre. Usa el SG temporal solo para tu IP, IMDSv2 y disco cifrado. Ejecuta el playbook `image.yml` de Ansible, limpia la máquina y etiqueta cada AMI y su snapshot con `Project`, `Role` e `ImageVersion`. Las variables `app_repo_url` y `app_repo_ref` indican de qué repositorio y rama se clona la app; frontend y backend llevan además los tags `AppRepo` y `AppRef`. |
| `manifest.json` | Lo genera cada build con los IDs de las AMIs. No se versiona. |

## `infra/ansible/`
Configuración de las máquinas. Packer usa los roles `common`, `nodejs`, `app_build`,
`frontend`, `backend` y `database` al construir las imágenes. El playbook de despliegue
y los roles `tenant_*` aplican la configuración de cada tenant después del
`terraform apply`; la plataforma los ejecuta igual que `scripts/deploy-tenant.sh`.

| Ruta | Para qué sirve |
| --- | --- |
| `ansible.cfg` | Rutas de roles y colecciones, sin comprobación de host key, `pipelining` para que sea más rápido. |
| `playbooks/image.yml` | Playbook de Packer. Aplica `common` y el rol de la imagen (`image_role`) y registra en `/etc/asistencia/image-release` la versión de la imagen y, en frontend y backend, el repositorio, la rama y el commit exacto de la app (`APP_COMMIT`). |
| `roles/common/` | Lo que llevan las 3 imágenes. Desactiva las actualizaciones automáticas de apt, que bloquearían el despliegue. Instala, con versión fija y checksum: **node_exporter** `:9100`, **process-exporter** `:9256` (procesos nginx, node, postgres, otelcol, netdata), **OpenTelemetry Collector** `:8889` con config según el rol y **Netdata** `:19999` (datos solo en RAM, alertas desactivadas porque las gestiona Grafana). |
| `roles/nodejs/` | Node.js 22 desde el tarball oficial, con checksum. `tasks/remove.yml` lo desinstala en las imágenes que solo lo usan para compilar. |
| `roles/app_build/` | Clona desde GitHub **solo** `admin-docente-alumno/<server o client>` (`--depth 1 --filter=blob:none --sparse`), ejecuta `npm ci` y `npm run build`, y guarda el commit en `app_commit`. Activa un swap temporal de 2 GB, porque la t3.micro tiene 1 GB de RAM. `tasks/cleanup.yml` borra el código fuente, la caché de npm y el swap. |
| `roles/frontend/` | nginx con el build de React ya incluido en `/var/www/asistencia`. Node.js y el código fuente se borran al terminar. `stub_status` en `127.0.0.1:8080` para el collector. El proxy de `/api` al backend del tenant lo agrega el despliegue. |
| `roles/backend/` | Node.js 22, el usuario `asistencia` y la API compilada en `/opt/asistencia/api/releases/<commit>`, con el enlace `current`. Solo quedan `dist/`, las dependencias de producción (`npm prune --omit=dev`) y `package.json`; el código es de root y la API solo puede leerlo. El servicio `asistencia-api` no arranca hasta que el despliegue escriba `/etc/asistencia/api.env` con los secretos. |
| `roles/database/` | PostgreSQL 16 con contraseñas `scram-sha-256` y acceso solo desde la red de la VPC. Crea el rol `otel_monitor` (`pg_monitor`, solo desde `127.0.0.1`), que el collector usa para leer estadísticas. |
| `playbooks/deploy-tenant.yml` | Despliegue de un tenant sobre sus 3 EC2, en orden database → backend → frontend. Primero valida que vengan los secretos y que el inventario tenga los 3 hosts. Es idempotente. |
| `roles/tenant_database/` | Crea el usuario y la base `asistencia` del tenant con su contraseña, quita los permisos públicos y reescribe `pg_hba.conf` para aceptar solo la IP privada **de su backend**. Es una segunda barrera además del Security Group. |
| `roles/tenant_backend/` | Escribe `/etc/asistencia/api.env` (`0640`, `no_log`) con la conexión a la BD, `JWT_SECRET`, `PLATFORM_TENANT_SLUG`, `PLATFORM_BOOTSTRAP_KEY`, `OTEL_ENABLED=true` y `APP_VERSION` (el commit de la imagen). Arranca la API, que ejecuta las migraciones, y espera a que `/api/health` responda 200. |
| `roles/tenant_frontend/` | Escribe el sitio de nginx con el proxy de `/api` y `/api/socket.io` (WebSocket) hacia la IP privada del backend. Valida con `nginx -t`, recarga y comprueba la cadena completa nginx → API → PostgreSQL. |

**Qué mide el OpenTelemetry Collector en cada rol:**

| Rol | Receptores | Métricas que entrega |
| --- | --- | --- |
| backend | `otlp` (recibe lo que envía `telemetry.ts`) + `httpcheck` de `/api/health` | Latencia, errores 5xx y disponibilidad de la API con su BD |
| frontend | `nginx` (`stub_status`) + `httpcheck` de `/` | Conexiones, peticiones y disponibilidad del sitio |
| database | `postgresql` | Conexiones, tamaño de las bases, commits y rollbacks |

## `infra/cloud-init/`
Primer arranque de cada EC2. Terraform renderiza la plantilla con `templatefile()` y la
entrega como `user_data`.

| Archivo | Para qué sirve |
| --- | --- |
| `node.yaml.tftpl` | La usan los 3 roles. Pone el hostname `<slug>-<rol>` (lo muestran netdata y los logs), la zona horaria y `/etc/asistencia/identity.env` con proyecto, tenant, rol y entorno, y reinicia netdata y el collector para que tomen el nombre nuevo. **No lleva secretos**: `user_data` queda en el estado de Terraform y se puede leer desde la API de EC2. Los secretos los escribe Ansible. |

## `monitoring/`
Prometheus y Grafana en la PC del operador, con `docker compose`.

| Archivo | Para qué sirve |
| --- | --- |
| `docker-compose.yml` | `prom/prometheus:v3.15.1` en `127.0.0.1:9090` (retención de 7 días) y `grafana/grafana:13.2.5` en `127.0.0.1:3001`, con acceso anónimo de solo lectura. Grafana llega a la API de la plataforma por `host.docker.internal`. Los datos quedan en volúmenes de Docker. |
| `.env.example` | `GRAFANA_ADMIN_PASSWORD` y `PLATFORM_ALERTS_TOKEN`, que debe ser el mismo de la plataforma. El `.env` real no se versiona. |
| `prometheus/prometheus.yml` | Job `tenants` con `file_sd_configs` sobre `targets/*.json`, releídos cada 30 s. |
| `prometheus/targets/` | Un archivo por tenant, escrito por la plataforma (`provisioning/targets.js`). Cada EC2 tiene 4 targets (node_exporter, process-exporter, otelcol y netdata) con las etiquetas `tenant`, `environment`, `role`, `exporter`, `instance` y `public_ip`. Netdata usa `__metrics_path__=/api/v1/allmetrics` y `format=prometheus`. |
| `grafana/provisioning/` | Fuente de datos Prometheus (uid `prometheus`) y el proveedor que carga los dashboards de la carpeta `grafana/dashboards/`. |
| `grafana/dashboards/tenants.json` | Dashboard **Tenants de asistencia** (uid `asistencia-tenants`). Lo describe la tabla de abajo. |
| `grafana/provisioning/alerting/rules.yml` | 7 reglas de alerta que Grafana evalúa cada minuto (ver la tabla de abajo). |
| `grafana/provisioning/alerting/contact-points.yml` | Contact point **plataforma**: webhook a `PLATFORM_ALERTS_URL` con `Authorization: Bearer PLATFORM_ALERTS_TOKEN`. |
| `grafana/provisioning/alerting/policies.yml` | Todas las alertas van a la plataforma, agrupadas por regla, tenant y rol. Las que siguen activas se reenvían cada 15 min: así una entrega perdida, o la plataforma apagada un rato, se corrige sola, y la plataforma no las duplica. |

**Paneles del dashboard** (variables **Entorno** y **Tenant**, de selección múltiple):

| Fila | Paneles | Origen |
| --- | --- | --- |
| Disponibilidad | % de agentes respondiendo; app respondiendo (`/api/health`); tabla de agentes por máquina con enlace a Netdata | `up`, `httpcheck_status` |
| Recursos de cada EC2 | CPU, memoria, disco raíz, red y carga | node_exporter |
| Aplicación | Peticiones por segundo por código HTTP, latencia p95, % de errores 5xx, peticiones a nginx y duración del chequeo de salud | OpenTelemetry (`telemetry.ts` y collector) |
| Base de datos | Conexiones, tamaño de la base `asistencia` y transacciones (commits y rollbacks) | Receptor `postgresql` del collector |
| Procesos | CPU y memoria de nginx, node, postgres, otelcol, netdata y node_exporter | process-exporter |

La plataforma enlaza al dashboard ya filtrado desde el detalle de cada institución
(**Ver en Grafana**).

**Reglas de alerta** (`grafana/provisioning/alerting/rules.yml`):

| Regla | Condición | Durante | Severidad |
| --- | --- | --- | --- |
| Agente caído | Un agente no responde a Prometheus (`up == 0`) | 2 min | critical |
| App sin responder | Falla el chequeo HTTP del backend (`/api/health`, incluye PostgreSQL) o del frontend | 2 min | critical |
| Aumento de errores 5xx | Más del 5 % de las respuestas de la API son 5xx | 5 min | warning |
| Latencia alta de la API | p95 mayor a 1 s | 10 min | warning |
| CPU alta | Más del 90 % | 10 min | warning |
| Memoria alta | Más del 90 % | 10 min | warning |
| Disco casi lleno | Disco raíz por encima del 85 % | 10 min | critical |

Sin datos no hay alerta (`noDataState: OK`): un tenant suspendido o eliminado no tiene
targets y no genera falsas alarmas. Cada alerta lleva las etiquetas `tenant`,
`environment`, `role` e `instance` de la serie que la disparó, más un resumen legible.
