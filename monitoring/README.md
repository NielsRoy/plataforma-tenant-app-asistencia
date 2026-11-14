# Monitoreo

Prometheus y Grafana corren en la PC del operador con `docker compose`.

- **Prometheus** lee (modelo *pull*) las métricas de las EC2 de cada tenant.
- **Grafana** consulta a Prometheus, muestra el dashboard **Tenants de asistencia** y evalúa 7 reglas de alerta: agente caído, app sin responder, errores 5xx, latencia, CPU, memoria y disco. Las alertas se envían por webhook a la plataforma (`POST /api/platform/alerts/webhook`, con `PLATFORM_ALERTS_TOKEN`), que las muestra en la vista **Monitoreo**.

```powershell
cd monitoring
Copy-Item .env.example .env        # define GRAFANA_ADMIN_PASSWORD y PLATFORM_ALERTS_TOKEN
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
