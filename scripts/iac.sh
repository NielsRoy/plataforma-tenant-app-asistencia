#!/usr/bin/env bash
# Ejecuta un comando dentro del toolbox IaC. Equivalente a scripts/iac.ps1
# para Linux, macOS, WSL o Git Bash.
#   ./scripts/iac.sh toolbox-versions
#   ./scripts/iac.sh terraform -chdir=infra/terraform/bootstrap plan
set -euo pipefail

export MSYS_NO_PATHCONV=1   # Git Bash: no convertir rutas /workspace a C:/...

image="${IAC_TOOLBOX_IMAGE:-asistencia-iac-toolbox:1}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ssh_dir="${ASISTENCIA_SSH_DIR:-$HOME/.ssh/asistencia}"

workdir=/workspace
case "$PWD/" in
  "$repo_root"/*) rel="${PWD#"$repo_root"}"; workdir="/workspace${rel}" ;;
esac

args=(run --rm -v "$repo_root:/workspace" -w "$workdir")
[ -t 0 ] && [ -t 1 ] && args+=(-it)
[ -d "$HOME/.aws" ] && args+=(-v "$HOME/.aws:/root/.aws:ro")
[ -d "$ssh_dir" ] && args+=(-v "$ssh_dir:/mnt/ssh:ro")

for name in AWS_PROFILE AWS_REGION AWS_DEFAULT_REGION PACKER_LOG TF_LOG; do
  [ -n "${!name:-}" ] && args+=(-e "$name")
done
while IFS='=' read -r name _; do
  case "$name" in TF_VAR_*|PKR_VAR_*) args+=(-e "$name") ;; esac
done < <(env)

exec docker "${args[@]}" "$image" "$@"
