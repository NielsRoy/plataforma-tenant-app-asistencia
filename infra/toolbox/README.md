# Toolbox IaC

Imagen Docker con las versiones fijas de las herramientas de infraestructura. Se usa
de la misma forma desde la terminal y desde la plataforma.

| Herramienta | Versión | Para qué |
| --- | --- | --- |
| Terraform | 1.16.6 | Aprovisionar AWS |
| Packer | 1.16.2 (+ plugins `amazon` y `ansible`) | Construir las AMIs |
| ansible-core | 2.21.6 (+ `ansible.posix`, `community.general`, `community.postgresql`) | Configurar las EC2 y desplegar la app |
| tflint | 0.65.0 | Linter de Terraform |
| trivy | 0.76.0 | Escáner de seguridad de configuración IaC |
| checkov | 3.4.5 | Escáner de políticas de seguridad IaC |

Ansible no corre nativo en Windows. Con el contenedor, todos los integrantes del equipo
usan exactamente las mismas versiones. La plataforma guarda la salida de
`toolbox-versions` en cada operación (RF-13).

## Construir la imagen

```powershell
docker build -t asistencia-iac-toolbox:1 infra/toolbox
```

## Uso

```powershell
./scripts/iac.ps1 toolbox-versions
./scripts/iac.ps1 terraform -chdir=infra/terraform/bootstrap init
./scripts/iac.ps1 bash          # shell interactiva dentro del contenedor
```

`scripts/iac.ps1` (o `scripts/iac.sh` en Linux, WSL o Git Bash) hace lo siguiente:

| Qué monta o pasa | Dónde queda en el contenedor |
| --- | --- |
| Raíz del repositorio | `/workspace`. Se conserva tu directorio actual. |
| `~/.aws` | Montado solo lectura. Lo usa el perfil de credenciales de AWS. |
| `~/.ssh/asistencia` (cambia con `ASISTENCIA_SSH_DIR`) | Las claves se copian a `/root/.ssh` con permisos `600`. Es necesario porque Windows monta los archivos con `777` y `ssh` los rechaza. |
| Variables `AWS_PROFILE`, `AWS_REGION`, `AWS_DEFAULT_REGION`, `PACKER_LOG` y `TF_LOG` | Se pasan tal cual. |
| Toda variable `TF_VAR_*` y `PKR_VAR_*` | Se pasan tal cual. |

Para usar otra etiqueta de imagen, define `IAC_TOOLBOX_IMAGE`.
