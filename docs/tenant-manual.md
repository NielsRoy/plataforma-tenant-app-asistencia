# Crear un tenant a mano

Esta guía hace, comando por comando, lo mismo que hará la plataforma al crear,
suspender, reanudar y eliminar un tenant. Sirve para entender cada paso, para depurar
y para demostrar las herramientas sin la interfaz.

Todos los comandos se ejecutan en **PowerShell**, desde la raíz del repositorio.
Terraform, Ansible y los escáneres corren dentro del toolbox con `./scripts/iac.ps1`.

## Qué automatiza la plataforma

| # | Paso de la plataforma | Comando manual | Herramienta |
| --- | --- | --- | --- |
| 1 | Generar las variables del tenant según su plan | crear `<slug>.tfvars` | — |
| 2 | Escanear el código | `scan-terraform.sh` | tflint, trivy, checkov |
| 3 | Preparar el estado del tenant | `terraform init` | Terraform + S3 |
| 4 | Calcular los cambios | `terraform plan` | Terraform |
| 5 | Crear la infraestructura | `terraform apply` | Terraform + cloud-init |
| 6 | Leer los resultados | `terraform output` | Terraform |
| 7 | Generar los secretos | `tenant-secrets.sh` | — |
| 8 | Configurar y arrancar la app | `deploy-tenant.sh` | Ansible |
| 9 | Comprobar la salud | `curl /api/health` | — |
| 10 | Invitar al primer administrador | `tenant-invite.sh` | — |
| 11 | Registrar el tenant en el monitoreo | escribir `monitoring/prometheus/targets/<slug>.json` | Prometheus (pendiente) |

## Requisitos

Los pasos 1 a 7 de [puesta-en-marcha.md](puesta-en-marcha.md) deben estar hechos:
- credenciales de AWS configuradas
- toolbox construido
- clave SSH creada
- bootstrap aplicado
- las 3 AMIs construidas

## 1. Elegir el tenant

```powershell
$slug = "demo"
(Invoke-RestMethod https://checkip.amazonaws.com).Trim()
Copy-Item infra/terraform/tenant/demo.tfvars.example "infra/terraform/tenant/$slug.tfvars"
```

- **`$slug`** es el identificador del tenant: de 3 a 42 caracteres, minúsculas, números y guiones. Aparece en los nombres de los recursos de AWS, en el estado y en la app. Los comandos de esta guía usan la variable `$slug`, así que sirven para cualquier tenant.
- **El segundo comando** muestra tu IP pública.

Edita `infra/terraform/tenant/<slug>.tfvars`:

```hcl
tenant_slug    = "demo"                 # el mismo valor que $slug
environment    = "staging"              # o production
operator_cidrs = ["<tu-ip>/32"]         # solo esta IP entra por SSH y lee métricas
instance_types = { frontend = "t3.micro", backend = "t3.micro", database = "t3.micro" }
```

Los `.tfvars` están ignorados por git.

## 2. Escanear el código

```powershell
./scripts/iac.ps1 bash scripts/scan-terraform.sh
```

Corre tflint, trivy y checkov, y termina con un resumen. Los hallazgos son
advertencias y no bloquean. Lo esperado es 4 `OK` y 16 checks de checkov omitidos con
justificación. El detalle está en [escaneres.md](escaneres.md).

## 3. Preparar el estado del tenant

```powershell
./scripts/iac.ps1 terraform -chdir=infra/terraform/tenant init -reconfigure "-backend-config=backend.hcl" "-backend-config=key=tenants/$slug/terraform.tfstate"
```

- Cada tenant tiene **su propio estado** en S3: `tenants/<slug>/terraform.tfstate`, cifrado, versionado y con bloqueo. Un error en un tenant no afecta a los demás.
- `-reconfigure` es necesario porque la carpeta `infra/terraform/tenant` es la misma para todos los tenants: cada `init` la apunta a otro estado. **Ejecútalo siempre que cambies de tenant.** La plataforma, en cambio, usa una carpeta de trabajo propia por tenant.
- Las comillas son necesarias en PowerShell 5.1, que parte los argumentos que llevan un punto.

## 4 y 5. Plan y apply

```powershell
./scripts/iac.ps1 terraform -chdir=infra/terraform/tenant plan "-var-file=$slug.tfvars" -out=tfplan
./scripts/iac.ps1 terraform -chdir=infra/terraform/tenant apply tfplan
```

El `plan` de un tenant nuevo propone **31 recursos**:

| Recursos | Qué son |
| --- | --- |
| 3 `aws_instance` | frontend, backend y database. Salen de las AMIs más recientes, con IMDSv2 y disco cifrado. |
| 3 `aws_security_group` y 20 reglas | Ver la tabla de abajo. |
| `aws_eip` y `aws_eip_association` | La IP fija del frontend. |
| 3 `aws_ec2_instance_state` | Encendido y apagado de cada EC2. |

Las reglas de los Security Groups son:

| Hacia | Entrada permitida |
| --- | --- |
| frontend | `:80` desde internet |
| backend | `:3000` solo desde el frontend |
| database | `:5432` solo desde el backend |
| los 3 | SSH y métricas solo desde tu IP |

La salida también está limitada: frontend → backend y backend → database.

El `apply` tarda 1 o 2 minutos. Al arrancar, **cloud-init** configura cada EC2: hostname
`<slug>-<rol>`, zona horaria y `/etc/asistencia/identity.env`.

## 6. Leer los resultados

```powershell
./scripts/iac.ps1 terraform -chdir=infra/terraform/tenant output
```

Los outputs forman el contrato que usan Ansible, Prometheus y la plataforma:

| Output | Qué contiene |
| --- | --- |
| `app_url` | La URL pública de la app. |
| `frontend_public_ip` | La IP elástica del frontend. |
| `backend_private_ip`, `database_private_ip` | Las IP privadas dentro de la VPC. |
| `public_ips` | La IP pública de cada EC2. |
| `instance_ids`, `ami_ids` | Las EC2 y las AMIs con que se crearon. |

## 7. Generar los secretos

```powershell
./scripts/iac.ps1 bash scripts/tenant-secrets.sh $slug
```

Crea `.workspaces/<slug>/secrets.yml`, ignorado por git y con permisos `600`. Contiene:
- la contraseña de la BD
- `JWT_SECRET`
- la clave de invitación

No se imprimen y **nunca pasan por Terraform**: van de este archivo a Ansible, y de
Ansible a la EC2 por SSH. Si el archivo ya existe, el script no lo toca. **No lo
borres mientras el tenant exista**, porque la base de datos ya usa esa contraseña.

## 8. Configurar y arrancar la app

```powershell
./scripts/iac.ps1 bash scripts/deploy-tenant.sh $slug
```

1. Genera `.workspaces/<slug>/inventory.json` desde `terraform output -json`. Se niega si el estado pertenece a otro tenant o si el tenant está suspendido.
2. Ejecuta `infra/ansible/playbooks/deploy-tenant.yml`. Las AMIs ya traen la app compilada; Ansible solo aplica la configuración:

| Orden | EC2 | Qué hace Ansible |
| --- | --- | --- |
| 1 | database | Crea el usuario y la base `asistencia`. Limita `pg_hba.conf` a la IP privada del backend. |
| 2 | backend | Escribe `/etc/asistencia/api.env` con los secretos (la tarea se muestra con la salida ocultada). Arranca la API, que ejecuta las migraciones, y espera `/api/health`. |
| 3 | frontend | Configura el proxy de nginx (`/api` y `/api/socket.io`) hacia el backend y comprueba la cadena completa. |

Termina con `Tenant <slug> listo en http://<ip>` y `failed=0`. Es idempotente: si lo
repites, casi todo sale `ok`.

## 9. Comprobar la salud

```powershell
$app = "http://<frontend_public_ip>"
curl.exe -s "$app/api/health"                       # {"status":"ok"}
```

`/api/health` solo responde `ok` si la petición llega por nginx → API → PostgreSQL.

## 10. Activar el primer administrador

```powershell
./scripts/iac.ps1 bash scripts/tenant-invite.sh $slug admin@$slug.edu "Administrador $slug"
```

El script muestra un enlace `http://<ip>/activar#token=...`, válido 24 horas y de un
solo uso.
1. Abre el enlace en el navegador.
2. Define la contraseña: mínimo 8 caracteres, con letras y números.
3. Inicia sesión con ese correo y esa contraseña.

La contraseña solo existe como hash bcrypt en la base del tenant. Si el enlace vence,
repite el comando **con el mismo correo**. La plataforma hará este paso y le entregará
el enlace al contacto de la institución.

## Verificaciones

### Monitoreo (agentes en cada EC2)

```powershell
$backend = "<public_ips.backend>"
curl.exe -s "http://${backend}:9100/metrics" | Select-Object -First 3     # node_exporter
curl.exe -s "http://${backend}:9256/metrics" | Select-String namedprocess | Select-Object -First 3
curl.exe -s "http://${backend}:8889/metrics" | Select-String http_server_request_duration | Select-Object -First 3
```

Para ver el panel de Netdata, abre `http://<public_ips.backend>:19999` en el navegador.
Las métricas de la API (`http_server_request_duration`) aparecen cuando la app recibe
peticiones.

### Aislamiento desde internet

```powershell
Test-NetConnection <public_ips.backend> -Port 3000     # TcpTestSucceeded : False
Test-NetConnection <public_ips.database> -Port 5432    # TcpTestSucceeded : False
```

### Aislamiento entre tenants

Crea un segundo tenant: repite los pasos 1 a 10 con `$slug = "demo-b"`. Recuerda el
`init -reconfigure` del paso 3. Después prueba las dos barreras.

**a) Red: el backend de B no alcanza la base de A.**

```powershell
ssh -i "$HOME\.ssh\asistencia\asistencia_ed25519" ubuntu@<public_ips.backend de demo-b> "nc -zv -w 5 <database_private_ip de demo> 5432"
ssh -i "$HOME\.ssh\asistencia\asistencia_ed25519" ubuntu@<public_ips.backend de demo-b> "nc -zv -w 5 <database_private_ip de demo-b> 5432"
```

- El primero termina en **timeout**: dos Security Groups lo bloquean, la salida del backend de B y la entrada de la base de A.
- El segundo dice **`succeeded`**: es su propia base.

**b) Aplicación: un token de A no sirve en B.**

```powershell
$body = @{ email = "admin@demo.edu"; password = "<tu-contraseña>" } | ConvertTo-Json
$token = (Invoke-RestMethod -Method Post -Uri "http://<ip de demo>/api/auth/admin/login" -ContentType "application/json" -Body $body).accessToken
Invoke-RestMethod -Uri "http://<ip de demo>/api/auth/me" -Headers @{ Authorization = "Bearer $token" }
curl.exe -s -o NUL -w "%{http_code}`n" -H "Authorization: Bearer $token" "http://<ip de demo-b>/api/auth/me"
```

- El tercer comando devuelve tu usuario en A.
- El último devuelve **`401`**: cada tenant firma sus sesiones con su propio `JWT_SECRET`.

Al terminar, **elimina `demo-b`** (ver Eliminar, más abajo). Dos tenants son 6 EC2, y
el Free Tier de 750 horas al mes es para el total.

## Suspender y reanudar

Siempre con **plan primero**. El plan debe decir `0 to add, 3 to change, 0 to destroy`
y cambiar solo los `aws_ec2_instance_state`. Si propone reemplazar (`must be
replaced`) o destruir una EC2, **no lo apliques**: se perderían los datos.

```powershell
# Suspender
./scripts/iac.ps1 terraform -chdir=infra/terraform/tenant plan "-var-file=$slug.tfvars" -var desired_state=stopped -out=tfplan
./scripts/iac.ps1 terraform -chdir=infra/terraform/tenant apply tfplan

# Reanudar
./scripts/iac.ps1 terraform -chdir=infra/terraform/tenant plan "-var-file=$slug.tfvars" -var desired_state=running -out=tfplan
./scripts/iac.ps1 terraform -chdir=infra/terraform/tenant apply tfplan
./scripts/iac.ps1 terraform -chdir=infra/terraform/tenant apply -refresh-only -auto-approve "-var-file=$slug.tfvars" -var desired_state=running
```

**Suspendido:**
- Las 3 EC2 quedan detenidas.
- No se cobran horas de cómputo, pero sí los discos y la IP elástica.
- Los datos se conservan.

**Reanudado:**
- En 1 o 2 minutos la app responde en la misma URL y con sus datos, sin volver a desplegar.
- La API arranca sola, y las IP privadas y la IP elástica no cambian.
- `-refresh-only` no toca AWS. Solo actualiza en el estado las **IP públicas nuevas** de backend y database, que son las que necesitan Ansible y Prometheus.
- Si te olvidas de `-refresh-only`, `deploy-tenant.sh` falla con `UNREACHABLE`.

> Ojo: `desired_state=stopped` hay que repetirlo en cada `plan` mientras el tenant
> esté suspendido. Si no, Terraform lo vuelve a encender. La plataforma lo guarda en
> el estado del tenant.

## Eliminar

```powershell
./scripts/iac.ps1 terraform -chdir=infra/terraform/tenant plan -destroy "-var-file=$slug.tfvars"
./scripts/iac.ps1 terraform -chdir=infra/terraform/tenant destroy "-var-file=$slug.tfvars"
Remove-Item -Recurse -Force ".workspaces/$slug", "infra/terraform/tenant/$slug.tfvars"
```

1. **`plan -destroy`** es la vista previa: muestra los 31 recursos que se borrarán. La plataforma la mostrará antes de pedir confirmación.
2. **`destroy`** pide escribir `yes`. Borra las EC2 **con sus discos y la base de datos**, la IP elástica y los Security Groups. No se puede deshacer.
3. **El último comando** borra los secretos y el inventario locales.

En S3 queda `tenants/<slug>/terraform.tfstate` vacío, con su historial de versiones. El
ciclo de vida del bucket borra las versiones antiguas a los 90 días.

## Costos

Cada tenant usa 3 `t3.micro`, 3 discos gp3 de 8 GB (24 GB) y una IP elástica. El Free
Tier incluye:
- 750 horas al mes de t3.micro **en total**: 3 EC2 encendidas consumen 3 horas por cada hora.
- 30 GB de EBS.
- 750 horas de IPv4 pública.

Con 2 tenants se superan los 30 GB de EBS. **Suspende o elimina los tenants de prueba al
terminar cada sesión.**

## Problemas frecuentes

| Síntoma | Causa y solución |
| --- | --- |
| `502 Bad Gateway` al iniciar sesión | nginx no llega a la API. Si las EC2 se recrearon, despliega de nuevo con `deploy-tenant.sh`. Si la API está caída, revisa con `ssh ... "sudo journalctl -u asistencia-api -n 50"` en el backend. |
| `UNREACHABLE` en Ansible | Las IP públicas del estado están viejas, tras reanudar. Ejecuta `apply -refresh-only`. |
| `El estado ... es del tenant 'X', no de 'Y'` | La carpeta apunta al estado de otro tenant. Ejecuta el `init -reconfigure` del paso 3 con el slug correcto. |
| SSH o métricas dejan de responder | Cambió tu IP pública. Actualiza `operator_cidrs` en el `.tfvars` y vuelve a hacer `plan` y `apply`: solo cambian las reglas del operador. |
| `Faltan secretos` | No se ejecutó `tenant-secrets.sh`. Si el tenant ya estaba desplegado y perdiste `secrets.yml`, la API ya no puede entrar a su base. |
| `tenant_slug debe tener entre 3 y 42 caracteres` | Revisa el slug en el `.tfvars`. |
