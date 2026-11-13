#!/usr/bin/env bash
# Prepara el contenedor antes de ejecutar el comando pedido.
set -euo pipefail

# En Windows los volúmenes montados aparecen con permisos 777 y ssh rechaza
# claves privadas así. Copiamos las claves a ~/.ssh con permisos 600.
if [ -d /mnt/ssh ]; then
  mkdir -p /root/.ssh
  chmod 700 /root/.ssh
  for key in /mnt/ssh/*; do
    [ -f "$key" ] || continue
    cp "$key" "/root/.ssh/$(basename "$key")"
    chmod 600 "/root/.ssh/$(basename "$key")"
  done
fi

mkdir -p "${TF_PLUGIN_CACHE_DIR}"

exec "$@"
