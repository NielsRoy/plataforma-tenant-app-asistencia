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
│   │   ├── modules/tenant/   (pendiente) Módulo reutilizable de un tenant
│   │   └── tenant/           (pendiente) Stack raíz que se aplica por cada tenant
│   ├── packer/               Plantilla de las AMIs
│   ├── ansible/              Roles y playbooks
│   └── cloud-init/           (pendiente) Plantillas de primer arranque
├── monitoring/               (pendiente) Prometheus y Grafana con docker compose
├── .gitattributes            Fuerza finales de línea LF en scripts y plantillas
└── .gitignore                Excluye estado de Terraform, *.tfvars, claves, artefactos
```

## Cambios en `admin-docente-alumno/` para la infraestructura

| Archivo | Para qué sirve |
| --- | --- |
| `server/src/telemetry.ts` | Métricas OpenTelemetry del backend: latencia y código de respuesta HTTP (`http.server.request.duration`) y consultas a PostgreSQL. Se activa con `OTEL_ENABLED=true` y envía por OTLP al collector de la misma EC2 (`localhost:4318`). Con la variable desactivada, que es lo normal en desarrollo local, no hace nada. |
| `server/src/main.ts` | Importa `./telemetry` como primer módulo, para que la instrumentación intercepte `http`, `express` y `pg` antes de que se carguen. |
| `server/.env.example` | Documenta `OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` y `APP_VERSION`. |

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

### Pendiente
- `modules/tenant/`: módulo con los Security Groups, las 3 EC2 (frontend, backend, base de datos) y la IP elástica.
- `tenant/`: stack raíz que usa el módulo. Se aplica una vez por tenant con un estado separado en S3 (`tenants/<slug>/terraform.tfstate`).

## `infra/packer/`
Plantilla para construir las 3 AMIs (`frontend`, `backend`, `database`). Se construyen
**una vez por versión**, no por tenant.

| Archivo | Para qué sirve |
| --- | --- |
| `asistencia.pkr.hcl` | Plantilla de las imágenes. Parte de la AMI oficial de Ubuntu 24.04 y construye las 3 imágenes en paralelo como 3 `source` con nombre. Usa el SG temporal solo para tu IP, IMDSv2 y disco cifrado. Ejecuta el playbook `image.yml` de Ansible, limpia la máquina y etiqueta cada AMI y su snapshot con `Project`, `Role` e `ImageVersion`. Las variables `app_repo_url` y `app_repo_ref` indican de qué repositorio y rama se clona la app; frontend y backend llevan además los tags `AppRepo` y `AppRef`. |
| `manifest.json` | Lo genera cada build con los IDs de las AMIs. No se versiona. |

## `infra/ansible/`
Configuración de las máquinas. Packer usa los roles al construir las imágenes. Los
playbooks de despliegue (*pendiente*) los ejecutará la plataforma después del
`terraform apply`.

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

**Qué mide el OpenTelemetry Collector en cada rol:**

| Rol | Receptores | Métricas que entrega |
| --- | --- | --- |
| backend | `otlp` (recibe lo que envía `telemetry.ts`) + `httpcheck` de `/api/health` | Latencia, errores 5xx y disponibilidad de la API con su BD |
| frontend | `nginx` (`stub_status`) + `httpcheck` de `/` | Conexiones, peticiones y disponibilidad del sitio |
| database | `postgresql` | Conexiones, tamaño de las bases, commits y rollbacks |

## `infra/cloud-init/` (pendiente)
Plantillas de primer arranque por rol. Terraform las renderiza con los datos del tenant
y las entrega como `user_data`.

## `monitoring/` (pendiente)
Archivo `docker-compose.yml` con Prometheus y Grafana, más la configuración de cada
uno:
- `prometheus.yml`
- dashboards y alertas de Grafana
- `prometheus/targets/`, donde la plataforma escribe los targets de cada tenant
