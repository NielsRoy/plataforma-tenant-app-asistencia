import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, BellRing, Building2, CircleAlert, CircleCheck, ExternalLink, Gauge, PauseCircle, Server } from 'lucide-react'
import { ApiError, api, errorMessage, formatDate, type Tenant } from './api'
import { environments, optionLabel, tenantStatusLabels } from './tenant-options'
import './platform-monitoring.css'

// Monitoreo real (RF-28, RF-29): estado de las instituciones y alertas que Grafana
// envía a la plataforma por webhook. Las métricas detalladas están en Grafana.

const grafanaUrl = 'http://127.0.0.1:3001'
const prometheusUrl = 'http://127.0.0.1:9090'

interface PlatformAlert {
  id: string
  name: string
  severity: string
  status: 'firing' | 'resolved'
  summary: string | null
  tenantSlug: string | null
  institutionName: string | null
  environment: string | null
  role: string | null
  instance: string | null
  exporter: string | null
  startsAt: string
  endsAt: string | null
}

function severityClass(alert: PlatformAlert) {
  if (alert.status === 'resolved') return 'pm-status'
  return alert.severity === 'critical' ? 'pm-status pm-status-critical' : 'pm-status pm-status-warning'
}

function SummaryCard({ label, value, Icon, tone }: { label: string; value: number; Icon: typeof Activity; tone?: 'warning' }) {
  return <article className={`pm-metric${tone ? ' pm-metric-warning' : ''}`}>
    <div className="pm-metric-label"><span><Icon size={16} aria-hidden="true" /></span><h3>{label}</h3></div>
    <div className="pm-metric-values"><strong>{value}</strong></div>
  </article>
}

export default function PlatformMonitoring({ revision, onSessionExpired }: { revision: number; onSessionExpired: () => void }) {
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [alerts, setAlerts] = useState<PlatformAlert[]>()
  const [tenantFilter, setTenantFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<'firing' | ''>('firing')
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const handleError = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 401) onSessionExpired()
    else setError(errorMessage(cause, 'No se pudo cargar el monitoreo.'))
  }, [onSessionExpired])

  useEffect(() => {
    const timer = window.setInterval(() => setTick(previous => previous + 1), 15000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    let active = true
    const params = new URLSearchParams({ limit: '200' })
    if (tenantFilter) params.set('tenant', tenantFilter)
    if (statusFilter) params.set('status', statusFilter)
    Promise.all([
      api<{ tenants: Tenant[] }>('/api/platform/tenants'),
      api<{ alerts: PlatformAlert[] }>(`/api/platform/alerts?${params}`),
    ]).then(([tenantResult, alertResult]) => {
      if (!active) return
      setTenants(tenantResult.tenants)
      setAlerts(alertResult.alerts)
      setError('')
    }).catch(cause => { if (active) handleError(cause) })
    return () => { active = false }
  }, [tenantFilter, statusFilter, tick, revision, handleError])

  const firingByTenant = useMemo(() => {
    const counts = new Map<string, number>()
    for (const alert of alerts ?? []) {
      if (alert.status === 'firing' && alert.tenantSlug) counts.set(alert.tenantSlug, (counts.get(alert.tenantSlug) ?? 0) + 1)
    }
    return counts
  }, [alerts])
  const count = (status: Tenant['status']) => tenants.filter(tenant => tenant.status === status).length
  const firing = (alerts ?? []).filter(alert => alert.status === 'firing').length

  return <div className="pm-dashboard">
    <div className="pm-toolbar">
      <div className="pm-demo"><span className="pm-demo-icon"><Gauge size={19} aria-hidden="true" /></span><div>
        <strong>Prometheus y Grafana</strong>
        <p>Las alertas llegan desde Grafana cada vez que cambian. Esta vista se actualiza cada 15 segundos.</p>
      </div></div>
      <div className="pm-links">
        <a className="pa-secondary" href={`${grafanaUrl}/d/asistencia-tenants`} target="_blank" rel="noreferrer">Dashboard <ExternalLink size={13} /></a>
        <a className="pa-secondary" href={`${grafanaUrl}/alerting/list`} target="_blank" rel="noreferrer">Reglas de alerta <ExternalLink size={13} /></a>
        <a className="pa-secondary" href={`${prometheusUrl}/targets`} target="_blank" rel="noreferrer">Targets <ExternalLink size={13} /></a>
      </div>
    </div>

    {error && <div className="pa-error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}

    <section aria-labelledby="pm-summary-title">
      <header className="pm-usage-heading"><h2 id="pm-summary-title">Resumen</h2></header>
      <div className="pm-metrics">
        <SummaryCard label="Instituciones activas" value={count('active')} Icon={Building2} />
        <SummaryCard label="Suspendidas" value={count('suspended')} Icon={PauseCircle} />
        <SummaryCard label="Con error" value={count('failed')} Icon={CircleAlert} tone={count('failed') > 0 ? 'warning' : undefined} />
        <SummaryCard label="Alertas activas" value={firing} Icon={BellRing} tone={firing > 0 ? 'warning' : undefined} />
      </div>
    </section>

    <div className="pm-details">
      <section className="pm-panel" aria-labelledby="pm-tenants-title">
        <div className="pm-panel-heading"><span className="pm-section-icon"><Server size={19} aria-hidden="true" /></span><h2 id="pm-tenants-title">Estado de las instituciones</h2></div>
        {tenants.length === 0 ? <p className="to-muted">Todavía no hay instituciones.</p> : <ul className="pm-service-list">
          {tenants.map(tenant => {
            const active = firingByTenant.get(tenant.slug) ?? 0
            return <li key={tenant.id}>
              <span className="pm-service-icon"><Building2 size={18} aria-hidden="true" /></span>
              <div>
                <strong>{tenant.institutionName}</strong>
                <p>{tenant.slug} · {optionLabel(environments, tenant.environment)} · {tenantStatusLabels[tenant.status]}
                  {tenant.status === 'active' && <> · <a href={`${grafanaUrl}/d/asistencia-tenants?var-environment=${tenant.environment}&var-tenant=${tenant.slug}`} target="_blank" rel="noreferrer">Grafana</a></>}</p>
              </div>
              <span className={active > 0 ? 'pm-status pm-status-critical' : tenant.status === 'active' ? 'pm-status' : 'pm-status pm-status-warning'}>
                {active > 0 ? <CircleAlert size={13} aria-hidden="true" /> : <CircleCheck size={13} aria-hidden="true" />}
                {active > 0 ? `${active} ${active === 1 ? 'alerta' : 'alertas'}` : tenant.status === 'active' ? 'Sin alertas' : tenantStatusLabels[tenant.status]}
              </span>
            </li>
          })}
        </ul>}
      </section>

      <section className="pm-panel" aria-labelledby="pm-alerts-title">
        <div className="pm-panel-heading"><span className="pm-section-icon"><Activity size={19} aria-hidden="true" /></span><h2 id="pm-alerts-title">Alertas</h2></div>
        <div className="pm-filters">
          <label><span id="pm-tenant-label">Institución</span><select aria-labelledby="pm-tenant-label" value={tenantFilter} onChange={event => setTenantFilter(event.target.value)}>
            <option value="">Todas</option>
            {tenants.map(tenant => <option key={tenant.id} value={tenant.slug}>{tenant.institutionName}</option>)}
          </select></label>
          <label><span id="pm-alert-status-label">Mostrar</span><select aria-labelledby="pm-alert-status-label" value={statusFilter} onChange={event => setStatusFilter(event.target.value as 'firing' | '')}>
            <option value="firing">Activas</option>
            <option value="">Activas e historial</option>
          </select></label>
        </div>
        {!alerts ? <p className="to-muted" role="status"><span className="pa-spinner" /> Cargando alertas…</p>
          : alerts.length === 0 ? <ul className="pm-event-list"><li><CircleCheck size={17} aria-hidden="true" /><div>
            <div className="pm-event-title"><strong>Sin alertas {statusFilter === 'firing' ? 'activas' : ''}</strong></div>
            <p>Todas las reglas de Grafana están dentro de sus umbrales.</p>
          </div></li></ul>
            : <ul className="pm-event-list">
              {alerts.map(alert => <li key={alert.id} className={alert.status === 'firing' ? 'pm-event-warning' : undefined}>
                {alert.status === 'firing' ? <CircleAlert size={17} aria-hidden="true" /> : <CircleCheck size={17} aria-hidden="true" />}
                <div>
                  <div className="pm-event-title">
                    <strong>{alert.name}</strong>
                    <span className={severityClass(alert)}>{alert.status === 'resolved' ? 'Resuelta' : alert.severity === 'critical' ? 'Crítica' : 'Advertencia'}</span>
                  </div>
                  <p>{alert.summary ?? 'Sin detalle.'}</p>
                  <p>{alert.institutionName ?? alert.tenantSlug ?? 'Sin tenant'}{alert.instance ? ` · ${alert.instance}` : ''} · desde {formatDate(alert.startsAt)}{alert.endsAt ? ` · resuelta ${formatDate(alert.endsAt)}` : ''}</p>
                </div>
              </li>)}
            </ul>}
      </section>
    </div>
  </div>
}
