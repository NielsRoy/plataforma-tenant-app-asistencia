#!/usr/bin/env bash
# Genera los secretos de un tenant UNA sola vez, dentro del toolbox:
#   ./scripts/iac.ps1 bash scripts/tenant-secrets.sh <slug>
# Quedan en .workspaces/<slug>/secrets.yml (ignorado por git, permisos 600).
# No se imprimen. Si el archivo ya existe no se toca: cambiar la contraseña de la
# base de un tenant ya desplegado lo dejaría sin acceso a sus datos.
# La plataforma no usa este archivo: guarda los secretos cifrados en su BD.
set -euo pipefail

slug="${1:?Uso: tenant-secrets.sh <slug>}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dir="$repo_root/.workspaces/$slug"
file="$dir/secrets.yml"

if [ -f "$file" ]; then
  echo "Ya existen los secretos de '$slug' en ${file#"$repo_root"/} (no se cambian)."
  exit 0
fi

mkdir -p "$dir"
umask 077
python3 - "$file" <<'PY'
import secrets, sys
values = {
    "tenant_db_password": secrets.token_urlsafe(32),
    "tenant_jwt_secret": secrets.token_urlsafe(48),
    "tenant_bootstrap_key": secrets.token_urlsafe(48),
}
with open(sys.argv[1], "w") as f:
    f.write("# Secretos del tenant. NO versionar ni compartir.\n")
    for key, value in values.items():
        f.write(f'{key}: "{value}"\n')
PY
echo "Secretos de '$slug' generados en ${file#"$repo_root"/}."
