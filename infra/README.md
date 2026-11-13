# Infraestructura como código

Arquitectura completa: [`docs/arquitectura.md`](../docs/arquitectura.md).

```
infra/
  toolbox/            Imagen Docker con terraform, packer, ansible, tflint, trivy, checkov y aws-cli
  terraform/
    bootstrap/        Una sola vez: bucket S3 de estado y key pair
    modules/tenant/   Módulo reutilizable: SGs + 3 EC2 (frontend, backend, database)
    tenant/           Stack raíz por tenant (estado en S3: tenants/<slug>/terraform.tfstate)
  packer/             Plantilla de las AMIs por rol (usa los roles de Ansible)
  ansible/            Roles (common, frontend, backend, database) y playbooks de despliegue
  cloud-init/         Plantillas de primer arranque por rol (las renderiza Terraform)
```

Por ahora solo hay un motor (Terraform). Pulumi o CloudFormation irían en carpetas
hermanas (`infra/pulumi`, `infra/cloudformation`). Deben devolver el mismo contrato de
outputs para poder reutilizar `ansible/`, `cloud-init/` y `packer/`.
