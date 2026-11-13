# Monitoreo

Prometheus y Grafana corren en la PC del operador con `docker compose`.

- **Prometheus** lee (modelo *pull*) las métricas de las EC2 de cada tenant.
- **Grafana** consulta a Prometheus, muestra paneles y envía alertas a la plataforma por webhook.

La plataforma escribe un archivo `prometheus/targets/<slug>.json` por tenant (file_sd)
cuando termina de aprovisionarlo. Prometheus lo recarga sin reiniciarse. Esos
archivos no se versionan.

Detalle en [`docs/arquitectura.md`](../docs/arquitectura.md#4-rol-de-cada-herramienta).
