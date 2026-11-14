# Escáneres de código Terraform

Antes de cada `terraform apply`, la plataforma ejecuta tres escáneres sobre el stack del
tenant (`infra/terraform/tenant`, que incluye el módulo `modules/tenant`). El log de la
operación muestra cada comando y su salida completa, y después el `apply`.

| Escáner | Versión | Qué revisa | Configuración |
| --- | --- | --- | --- |
| **tflint** | 0.65.0 + ruleset AWS 0.50.0 | Errores y buenas prácticas: variables sin tipo o sin usar, versiones de providers, tipos de instancia inexistentes, argumentos obsoletos | `infra/terraform/.tflint.hcl` (preset `recommended`) |
| **trivy** | 0.76.0 | Seguridad de la configuración: Security Groups abiertos, cifrado, IMDSv2… | Flags en `scripts/scan-terraform.sh` |
| **checkov** | 3.4.5 | Políticas de seguridad (más de 50 checks aplicables), con excepciones justificadas en el código | Comentarios `#checkov:skip` en `modules/tenant/main.tf` |

## Ejecutarlos a mano

```powershell
./scripts/iac.ps1 bash scripts/scan-terraform.sh
```

El script ejecuta, en orden, `tflint --init`, `tflint`, `trivy config` y `checkov`.
Termina con un resumen `OK` o `ADVERTENCIAS` por escáner.

- **No bloquea:** los hallazgos son advertencias y el script siempre termina con código 0.
- Con `SCAN_STRICT=1` termina con 1 si algún escáner encontró algo.
- El plugin AWS de tflint queda en caché en `.workspaces/.tflint-plugins`, ignorado por git.

## Correcciones aplicadas

| Hallazgo | Escáner | Corrección |
| --- | --- | --- |
| Salida sin restricción a `0.0.0.0/0` (`AWS-0104`, CRITICAL) | trivy | La salida quedó limitada a la cadena del tenant: frontend → backend `:3000` y backend → database `:5432`. La database no tiene salida. Las imágenes ya traen todo instalado, así que no necesitan internet. La hora se sincroniza con Amazon Time Sync (`169.254.169.123`, link-local), que no pasa por los Security Groups. |
| IMDSv2 obligatorio | trivy, checkov | Ya estaba en el diseño: `http_tokens = "required"`. |
| Discos cifrados | trivy, checkov | Ya estaba en el diseño: `encrypted = true` en gp3. |
| Descripción en cada SG y regla | checkov | Ya estaba en el diseño. |
| SSH y métricas no abiertos a internet | trivy, checkov | Ya estaba en el diseño: solo desde `operator_cidrs`, y la variable rechaza `0.0.0.0/0`. |

## Excepciones documentadas

Son reglas que no se pueden cumplir en el Free Tier o que no aplican. Cada una tiene su
justificación en el código, que checkov muestra como `Suppress comment` en el log.

| Check | Recurso | Por qué se omite |
| --- | --- | --- |
| `CKV_AWS_260` (puerto 80 abierto a internet) | `frontend_http` | Es el sitio web público del tenant. HTTPS requiere dominio y certificado, fuera del alcance. |
| `CKV_AWS_88` (EC2 con IP pública) | `aws_instance.role` | Sin NAT Gateway (no es Free Tier), la IP pública es la vía de SSH para Ansible y del scraping de Prometheus. Su SG solo admite la IP del operador. |
| `CKV_AWS_126` (monitoreo detallado) | `aws_instance.role` | El detallado de CloudWatch tiene costo. Las métricas las recoge Prometheus. |
| `CKV_AWS_135` (EBS optimized) | `aws_instance.role` | Los t3 ya son EBS-optimized por defecto; el flag no cambia nada. |
| `CKV2_AWS_41` (rol IAM en la EC2) | `aws_instance.role` | Las EC2 no llaman a APIs de AWS. No tener rol es el mínimo privilegio. |
| `CKV2_AWS_5` (SG sin asignar) | `aws_security_group.role` | Falso positivo: checkov no sigue el `for_each`. Cada SG se asigna a su EC2. |

## Resultado actual

```
  OK           tflint (init)
  OK           tflint
  OK           trivy        (0 hallazgos)
  OK           checkov      (53 pasan, 0 fallan, 16 omitidos con justificación)
```

Los 16 omitidos son las 6 excepciones de la tabla aplicadas a cada recurso: 4 checks por
cada una de las 3 EC2, 3 SGs y la regla del puerto 80.
