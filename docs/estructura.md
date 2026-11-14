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
│   ├── packer/               (pendiente) Plantilla de las AMIs
│   ├── ansible/              (pendiente) Roles y playbooks
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

## `infra/packer/` (pendiente)
Plantilla para construir las 3 AMIs (`frontend`, `backend`, `database`). Se construyen
**una vez por versión**, no por tenant.

## `infra/ansible/` (pendiente)
- Roles: `common` (agentes de monitoreo), `frontend`, `backend` y `database`. Packer los usa para construir las AMIs.
- Playbooks de despliegue: la plataforma los ejecuta después del `terraform apply`.

## `infra/cloud-init/` (pendiente)
Plantillas de primer arranque por rol. Terraform las renderiza con los datos del tenant
y las entrega como `user_data`.

## `monitoring/` (pendiente)
Archivo `docker-compose.yml` con Prometheus y Grafana, más la configuración de cada
uno:
- `prometheus.yml`
- dashboards y alertas de Grafana
- `prometheus/targets/`, donde la plataforma escribe los targets de cada tenant
