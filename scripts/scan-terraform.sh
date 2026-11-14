#!/usr/bin/env bash
# Escanea el código Terraform de un tenant con tflint, trivy y checkov.
# Se ejecuta DENTRO del toolbox:
#   ./scripts/iac.ps1 bash scripts/scan-terraform.sh            (stack infra/terraform/tenant)
#   ./scripts/iac.ps1 bash scripts/scan-terraform.sh <carpeta>
#
# Muestra cada comando antes de ejecutarlo y su salida completa: la plataforma
# guarda este texto en el log de la operación, antes del terraform apply.
# checkov lista también los checks omitidos con su justificación (#checkov:skip).
# NO bloquea: los hallazgos son advertencias y el script termina con 0.
# Con SCAN_STRICT=1 termina con 1 si algún escáner encontró problemas.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${1:-$repo_root/infra/terraform/tenant}"
target="$(cd "$target" && pwd)"
tf_root="$repo_root/infra/terraform"

# Caché de plugins de tflint fuera del contenedor (no se descarga en cada escaneo)
export TFLINT_PLUGIN_DIR="${TFLINT_PLUGIN_DIR:-$repo_root/.workspaces/.tflint-plugins}"
mkdir -p "$TFLINT_PLUGIN_DIR"

declare -A results
order=()

run() {
  local name="$1"; shift
  order+=("$name")
  echo
  echo "================================================================"
  echo "== $name"
  echo "================================================================"
  echo "\$ $*"
  "$@"
  local code=$?
  results[$name]=$code
  echo "-- $name terminó con código $code"
}

echo "Escaneo de seguridad y calidad de Terraform"
echo "Carpeta: ${target#"$repo_root"/}"
echo "Versiones: tflint $(tflint --version | head -1 | awk '{print $3}'), trivy $(trivy --version | awk '/^Version/{print $2}'), checkov $(checkov --version)"

run "tflint (init)" tflint --init --config="$tf_root/.tflint.hcl" --chdir="$target"
run "tflint" tflint --config="$tf_root/.tflint.hcl" --chdir="$target" --format=compact
# --misconfig-scanners terraform: analiza el código, no un tfplan viejo que haya en la carpeta
run "trivy" trivy config --quiet --misconfig-scanners terraform --exit-code 1 --severity LOW,MEDIUM,HIGH,CRITICAL "$target"
run "checkov" checkov --directory "$target" --framework terraform --compact

echo
echo "================================================================"
echo "== Resumen"
echo "================================================================"
failed=0
for name in "${order[@]}"; do
  if [ "${results[$name]}" -eq 0 ]; then
    echo "  OK           $name"
  else
    echo "  ADVERTENCIAS $name (código ${results[$name]})"
    failed=1
  fi
done

if [ "$failed" -eq 1 ]; then
  echo "Hay hallazgos. Son advertencias: el despliegue continúa (SCAN_STRICT=1 para bloquear)."
  [ "${SCAN_STRICT:-0}" = "1" ] && exit 1
else
  echo "Sin hallazgos."
fi
exit 0
