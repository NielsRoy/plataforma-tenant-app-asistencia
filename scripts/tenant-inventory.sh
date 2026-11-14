#!/usr/bin/env bash
# Genera el inventario de Ansible de un tenant a partir de `terraform output -json`.
# Se ejecuta dentro del toolbox:
#   ./scripts/iac.ps1 bash scripts/tenant-inventory.sh <slug>
# Variable opcional TF_DIR: carpeta del stack (por defecto infra/terraform/tenant).
# Escribe .workspaces/<slug>/inventory.json (ignorado por git).
set -euo pipefail

slug="${1:?Uso: tenant-inventory.sh <slug>}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tf_dir="${TF_DIR:-$repo_root/infra/terraform/tenant}"
dir="$repo_root/.workspaces/$slug"
mkdir -p "$dir"

outputs="$(terraform -chdir="$tf_dir" output -json)"

actual="$(jq -r '.tenant_slug.value // empty' <<<"$outputs")"
if [ "$actual" != "$slug" ]; then
  echo "El estado de $tf_dir es del tenant '${actual:-ninguno}', no de '$slug'." >&2
  echo "Ejecuta terraform init -reconfigure con la key tenants/$slug/terraform.tfstate." >&2
  exit 1
fi
if [ "$(jq -r '.desired_state.value' <<<"$outputs")" != "running" ]; then
  echo "El tenant '$slug' está suspendido: reanúdalo antes de desplegar." >&2
  exit 1
fi

jq --arg key /root/.ssh/asistencia_ed25519 '
  def host(role): {
    ("\(.tenant_slug.value)-\(role)"): {
      ansible_host: .public_ips.value[role],
      private_ip: .private_ips.value[role]
    }
  };
  {
    all: {
      vars: {
        ansible_user: "ubuntu",
        ansible_ssh_private_key_file: $key,
        ansible_ssh_common_args: "-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null",
        tenant_slug: .tenant_slug.value,
        tenant_environment: .environment.value,
        app_url: .app_url.value,
        backend_private_ip: .backend_private_ip.value,
        database_private_ip: .database_private_ip.value
      },
      children: {
        database: { hosts: host("database") },
        backend:  { hosts: host("backend") },
        frontend: { hosts: host("frontend") }
      }
    }
  }' <<<"$outputs" > "$dir/inventory.json"

echo "Inventario de '$slug' en ${dir#"$repo_root"/}/inventory.json:"
jq -r '.all.children | to_entries[] | "  \(.key): \(.value.hosts | to_entries[0] | "\(.key) \(.value.ansible_host)")"' "$dir/inventory.json"
