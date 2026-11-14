#!/usr/bin/env bash
# Despliega (o vuelve a desplegar) un tenant con Ansible. Dentro del toolbox:
#   ./scripts/iac.ps1 bash scripts/deploy-tenant.sh <slug>
# Requiere el terraform apply hecho y los secretos generados (tenant-secrets.sh).
# Es idempotente: se puede repetir sin efectos secundarios.
set -euo pipefail

slug="${1:?Uso: deploy-tenant.sh <slug>}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dir="$repo_root/.workspaces/$slug"
secrets="${TENANT_SECRETS_FILE:-$dir/secrets.yml}"

if [ ! -f "$secrets" ]; then
  echo "No existen los secretos de '$slug'. Ejecuta primero scripts/tenant-secrets.sh $slug" >&2
  exit 1
fi

bash "$repo_root/scripts/tenant-inventory.sh" "$slug"

# ansible.cfg explícito: en una carpeta montada desde Windows Ansible lo ignora
# por estar en un directorio con permisos de escritura para todos.
export ANSIBLE_CONFIG="$repo_root/infra/ansible/ansible.cfg"

echo
echo "\$ ansible-playbook -i .workspaces/$slug/inventory.json -e @<secretos> infra/ansible/playbooks/deploy-tenant.yml"
exec ansible-playbook \
  -i "$dir/inventory.json" \
  -e "@$secrets" \
  "$repo_root/infra/ansible/playbooks/deploy-tenant.yml"
