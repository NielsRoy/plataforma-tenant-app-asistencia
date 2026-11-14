#!/usr/bin/env bash
# Pide a la app del tenant la invitación de su primer administrador y muestra el
# enlace de activación. Es lo mismo que hace la plataforma al terminar un despliegue.
# Dentro del toolbox:
#   ./scripts/iac.ps1 bash scripts/tenant-invite.sh <slug> <correo> "<nombre>"
set -euo pipefail

slug="${1:?Uso: tenant-invite.sh <slug> <correo> <nombre>}"
email="${2:?Falta el correo del administrador}"
name="${3:?Falta el nombre del administrador}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dir="$repo_root/.workspaces/$slug"

app_url="$(jq -r '.all.vars.app_url' "$dir/inventory.json")"
key="$(sed -n 's/^tenant_bootstrap_key: "\(.*\)"$/\1/p' "$dir/secrets.yml")"

body="$(jq -n --arg slug "$slug" --arg email "$email" --arg name "$name" '{slug: $slug, email: $email, name: $name}')"
response="$(curl -sS --fail-with-body -X POST "$app_url/api/auth/invitations/bootstrap" \
  -H "Authorization: Bearer $key" -H 'Content-Type: application/json' -d "$body")" || {
  echo "La app respondió con error: $response" >&2
  exit 1
}

if [ "$(jq -r '.activated // false' <<<"$response")" = "true" ]; then
  echo "El tenant '$slug' ya tiene administrador activado. Inicia sesión en $app_url"
  exit 0
fi
token="$(jq -r '.token' <<<"$response")"
echo "Enlace de activación (válido 24 horas, de un solo uso):"
echo "  $app_url/activar#token=$token"
