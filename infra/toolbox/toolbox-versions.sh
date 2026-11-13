#!/usr/bin/env bash
# Imprime en JSON las versiones de las herramientas. La plataforma lo guarda
# en cada operación para registrar con qué se hizo el despliegue (RF-13).
set -euo pipefail

jq -n \
  --arg terraform "$(terraform version -json | jq -r .terraform_version)" \
  --arg packer "$(packer version | head -1 | sed 's/^Packer v//')" \
  --arg ansible "$(ansible --version | head -1 | sed -E 's/.*core ([0-9.]+).*/\1/')" \
  --arg tflint "$(tflint --version | head -1 | sed -E 's/.*version ([0-9.]+).*/\1/')" \
  --arg trivy "$(trivy --version | head -1 | sed 's/^Version: //')" \
  --arg checkov "$(checkov --version)" \
  '{terraform: $terraform, packer: $packer, ansible: $ansible, tflint: $tflint, trivy: $trivy, checkov: $checkov}'
