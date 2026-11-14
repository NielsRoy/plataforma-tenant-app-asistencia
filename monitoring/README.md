# Monitoreo

Prometheus y Grafana corren en la PC del operador con `docker compose`.

- **Prometheus** lee (modelo *pull*) las métricas de las EC2 de cada tenant.
- **Grafana** consulta a Prometheus y muestra el dashboard **Tenants de asistencia**. Las alertas hacia la plataforma se agregan en el siguiente paso.

```powershell
cd monitoring
Copy-Item .env.example .env        # define GRAFANA_ADMIN_PASSWORD
docker compose up -d
```

| Servicio | URL | Acceso |
| --- | --- | --- |
| Prometheus | http://127.0.0.1:9090 | Status → Targets muestra cada agente de cada tenant |
| Grafana | http://127.0.0.1:3001 | Lectura sin usuario; `admin` y `GRAFANA_ADMIN_PASSWORD` para editar |

Los dos puertos escuchan solo en `127.0.0.1`.

**Descubrimiento de targets.** La plataforma escribe `prometheus/targets/<slug>.json`
(file_sd) al crear, reanudar o volver a desplegar un tenant, y lo borra al suspenderlo
o eliminarlo. Prometheus relee la carpeta cada 30 segundos, sin reiniciarse. Esos
archivos no se versionan.
