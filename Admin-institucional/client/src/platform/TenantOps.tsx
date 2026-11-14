import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  AlertTriangle, Building2, Check, ChevronRight, CircleAlert, Clock3, ExternalLink, Loader2, Mail, Pause, Play,
  RefreshCw, Rocket, Search, Terminal, Trash2, X,
} from 'lucide-react'
import {
  ApiError, api, attendanceLoginLink, errorMessage, formatDate, webLink,
  type DeletionPreview, type LogLine, type Operation, type OperationKind, type Plan, type Tenant, type TenantStatus,
} from './api'
import {
  environments, operationLabels, operationStatusLabels, optionLabel, stepLabels, tenantStatusLabels,
} from './tenant-options'
import './tenant-ops.css'

// Vista "Instituciones": lista con filtros (RF-14), detalle con acciones de ciclo de
// vida (RF-16/17/18) y progreso en vivo de cada operación con su log (RF-11).

const transitional: TenantStatus[] = ['provisioning', 'suspending', 'resuming', 'deleting']
const isBusy = (tenant: Tenant) => transitional.includes(tenant.status)
  || tenant.lastOperation?.status === 'queued' || tenant.lastOperation?.status === 'running'

function TenantStatusBadge({ status }: { status: TenantStatus }) {
  const Icon = status === 'active' ? Check : status === 'failed' ? CircleAlert
    : transitional.includes(status) ? Loader2 : status === 'suspended' ? Pause : Clock3
  return <span className={`pa-status to-status-${status}`}>
    <Icon size={13} aria-hidden="true" className={transitional.includes(status) ? 'to-spin' : undefined} />
    {tenantStatusLabels[status]}
  </span>
}

function useSessionGuard(onSessionExpired: () => void) {
  return useCallback((cause: unknown, fallback: string) => {
    if (cause instanceof ApiError && cause.status === 401) {
      onSessionExpired()
      return ''
    }
    return errorMessage(cause, fallback)
  }, [onSessionExpired])
}

// ---------------------------------------------------------------------------
// Progreso de una operación: pasos y log (consulta cada 2 s mientras avanza)
// ---------------------------------------------------------------------------

function OperationProgress({ operationId, onFinished, onSessionExpired }: {
  operationId: string
  onFinished: () => void
  onSessionExpired: () => void
}) {
  const [operation, setOperation] = useState<Operation>()
  const [lines, setLines] = useState<LogLine[]>([])
  const [error, setError] = useState('')
  const [follow, setFollow] = useState(true)
  const logRef = useRef<HTMLPreElement>(null)
  const guard = useSessionGuard(onSessionExpired)

  useEffect(() => {
    let active = true
    let next = 0
    let timer: number | undefined
    let notified = false
    // Solo avisa al terminar si se vio en curso (abrir una operación vieja no recarga nada)
    let sawRunning = false
    async function poll() {
      try {
        const [detail, logs] = await Promise.all([
          api<{ operation: Operation }>(`/api/platform/operations/${operationId}`),
          api<{ lines: LogLine[]; next: number; finished: boolean }>(`/api/platform/operations/${operationId}/logs?after=${next}&limit=1000`),
        ])
        if (!active) return
        next = logs.next
        setOperation(detail.operation)
        if (logs.lines.length > 0) setLines(previous => [...previous, ...logs.lines])
        const finished = logs.finished && logs.lines.length < 1000
        if (!logs.finished) sawRunning = true
        if (finished && sawRunning && !notified) {
          notified = true
          onFinished()
        }
        if (!finished || logs.lines.length === 1000) timer = window.setTimeout(poll, logs.lines.length === 1000 ? 0 : 2000)
      } catch (cause) {
        if (active) setError(guard(cause, 'No se pudo leer el progreso de la operación.'))
      }
    }
    void poll()
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [operationId, onFinished, guard])

  useEffect(() => {
    if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [lines, follow])

  if (error) return <div className="pa-error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>
  if (!operation) return <p className="to-muted" role="status"><span className="pa-spinner" /> Cargando operación…</p>


  return <div className="to-progress">
    <div className="to-progress-head">
      <strong>{operationLabels[operation.kind]} · {operationStatusLabels[operation.status]}</strong>
      <small>Intento {operation.attempt}{operation.requestedBy ? ` · ${operation.requestedBy}` : ''} · {formatDate(operation.queuedAt)}</small>
    </div>
    {operation.steps.length > 0 && <ol className="to-steps" aria-label="Pasos de la operación">
      {operation.steps.map((step, index) => <li key={`${step.name}-${index}`} className={`to-step to-step-${step.status}`}>
        {step.status === 'running' ? <Loader2 size={13} className="to-spin" aria-hidden="true" />
          : step.status === 'failed' ? <X size={13} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
        {stepLabels[step.name] ?? step.name}
      </li>)}
    </ol>}
    {operation.errorMessage && <div className="pa-error" role="alert"><CircleAlert size={17} /><span>{operation.errorMessage}</span></div>}
    <div className="to-log-head">
      <span><Terminal size={15} aria-hidden="true" /> Log de la operación ({lines.length} líneas)</span>
      <label><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} /> Seguir el final</label>
    </div>
    <pre className="to-log" ref={logRef} tabIndex={0} aria-label="Log de la operación">
      {lines.map((line, index) => {
        const heading = index === 0 || line.step !== lines[index - 1].step
        return <span key={line.id}>
          {heading && <span className="to-log-step">── {stepLabels[line.step] ?? line.step} ──{'\n'}</span>}
          <span className={`to-log-${line.stream}`}>{line.line}{'\n'}</span>
        </span>
      })}
    </pre>
  </div>
}

// ---------------------------------------------------------------------------
// Eliminación: vista previa del estado real y confirmación escribiendo el slug
// ---------------------------------------------------------------------------

function DeleteTenantDialog({ tenant, onClose, onDeleted, onSessionExpired }: {
  tenant: Tenant
  onClose: () => void
  onDeleted: (operationId: string) => void
  onSessionExpired: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [preview, setPreview] = useState<DeletionPreview>()
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const guard = useSessionGuard(onSessionExpired)

  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    let active = true
    api<DeletionPreview>(`/api/platform/tenants/${tenant.id}/deletion-preview`)
      .then(result => { if (active) setPreview(result) })
      .catch(cause => { if (active) setError(guard(cause, 'No se pudo preparar la vista previa de la eliminación.')) })
    return () => {
      active = false
      if (dialog?.open) dialog.close()
    }
  }, [tenant.id, guard])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const result = await api<{ operation: Operation }>(`/api/platform/tenants/${tenant.id}`, {
        method: 'DELETE', body: JSON.stringify({ confirmSlug: confirmation.trim() }),
      })
      onDeleted(result.operation.id)
    } catch (cause) {
      setError(guard(cause, 'No se pudo iniciar la eliminación.'))
      setBusy(false)
    }
  }

  return <dialog className="pcd-dialog to-delete-dialog" ref={dialogRef} aria-labelledby="to-delete-title" onCancel={event => {
    event.preventDefault()
    onClose()
  }}>
    <form className="pcd-form" onSubmit={submit}>
      <header className="pcd-header">
        <span className="pcd-header-icon to-danger-icon"><Trash2 size={22} aria-hidden="true" /></span>
        <div><h2 id="to-delete-title">Eliminar {tenant.institutionName}</h2><p>Revisa lo que se eliminará. Esta acción no se puede deshacer.</p></div>
        <button type="button" className="pcd-close" onClick={onClose} aria-label="Cerrar"><X size={20} /></button>
      </header>
      <div className="pcd-body">
        {!preview && !error && <p className="to-muted" role="status"><span className="pa-spinner" /> Leyendo el estado de la infraestructura (puede tardar unos segundos)…</p>}
        {preview && <>
          <div className="to-delete-summary">
            <div><strong>{preview.summary.instances}</strong><span>EC2</span></div>
            <div><strong>{preview.summary.securityGroups}</strong><span>Security Groups</span></div>
            <div><strong>{preview.summary.securityGroupRules}</strong><span>Reglas</span></div>
            <div><strong>{preview.summary.elasticIps}</strong><span>IP elástica</span></div>
          </div>
          {preview.dataLoss.length > 0 ? <div className="to-warning" role="note">
            <AlertTriangle size={18} aria-hidden="true" />
            <div><strong>Se perderán definitivamente:</strong><ul>{preview.dataLoss.map(item => <li key={item}>{item}</li>)}</ul></div>
          </div> : <p className="to-muted">El tenant no tiene infraestructura creada: solo se marcará como eliminado.</p>}
          {preview.resources.length > 0 && <details className="to-resources">
            <summary>Ver los {preview.resources.length} recursos de AWS</summary>
            <ul>{preview.resources.map(address => <li key={address}><code>{address}</code></li>)}</ul>
          </details>}
          <label className="pcd-field to-confirm">
            <span>Para confirmar, escribe el identificador <code>{preview.confirmWith}</code></span>
            <input value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} autoFocus />
          </label>
        </>}
      </div>
      <footer className="pcd-footer">
        {error && <div className="pcd-error" role="alert"><CircleAlert size={17} aria-hidden="true" /><span>{error}</span></div>}
        <div className="pcd-footer-row">
          <p>La eliminación se ejecuta en segundo plano y queda registrada.</p>
          <div className="pcd-actions">
            <button type="button" className="pcd-secondary" onClick={onClose}>Cancelar</button>
            <button type="submit" className="pcd-primary to-danger" disabled={!preview || busy || confirmation.trim() !== preview.confirmWith}>
              <Trash2 size={16} aria-hidden="true" /> {busy ? 'Eliminando…' : 'Eliminar definitivamente'}
            </button>
          </div>
        </div>
      </footer>
    </form>
  </dialog>
}

// ---------------------------------------------------------------------------
// Detalle de un tenant
// ---------------------------------------------------------------------------

const actionButtons: { kind: Exclude<OperationKind, 'delete'>; label: (tenant: Tenant) => string; Icon: typeof Play }[] = [
  { kind: 'create', label: tenant => tenant.status === 'failed' ? 'Reintentar creación' : 'Crear infraestructura', Icon: Rocket },
  { kind: 'resume', label: () => 'Reanudar', Icon: Play },
  { kind: 'suspend', label: () => 'Suspender', Icon: Pause },
  { kind: 'redeploy', label: () => 'Volver a desplegar', Icon: RefreshCw },
]

function InfrastructureTable({ tenant }: { tenant: Tenant }) {
  const infra = tenant.infrastructure
  if (!infra) return <p className="to-muted">Todavía no hay infraestructura creada.</p>
  return <table className="to-infra">
    <thead><tr><th>Rol</th><th>EC2</th><th>IP pública</th><th>IP privada</th><th>AMI</th></tr></thead>
    <tbody>
      {(['frontend', 'backend', 'database'] as const).map(role => <tr key={role}>
        <th scope="row">{role}</th>
        <td><code>{infra.instanceIds?.[role] ?? '—'}</code></td>
        <td><code>{infra.publicIps?.[role] ?? '—'}</code></td>
        <td><code>{infra.privateIps?.[role] ?? '—'}</code></td>
        <td><code>{infra.amiIds?.[role] ?? '—'}</code></td>
      </tr>)}
    </tbody>
  </table>
}

function TenantDetail({ tenantId, onChanged, onSessionExpired }: {
  tenantId: string
  onChanged: () => void
  onSessionExpired: () => void
}) {
  const [tenant, setTenant] = useState<Tenant>()
  const [operations, setOperations] = useState<Operation[]>([])
  const [selectedOperation, setSelectedOperation] = useState<string>()
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string>()
  const guard = useSessionGuard(onSessionExpired)
  const reload = useCallback(() => setRevision(previous => previous + 1), [])

  useEffect(() => {
    let active = true
    api<{ tenant: Tenant; operations: Operation[] }>(`/api/platform/tenants/${tenantId}`)
      .then(result => {
        if (!active) return
        setTenant(result.tenant)
        setOperations(result.operations)
      })
      .catch(cause => { if (active) setError(guard(cause, 'No se pudo cargar la institución.')) })
    return () => { active = false }
  }, [tenantId, revision, guard])

  const operationFinished = useCallback(() => {
    reload()
    onChanged()
  }, [reload, onChanged])

  async function run(kind: Exclude<OperationKind, 'delete'>) {
    if (kind === 'suspend' && !window.confirm('¿Suspender la institución? Sus 3 EC2 se detendrán y la app dejará de responder hasta reanudarla. Los datos se conservan.')) return
    setBusy(true)
    setError('')
    try {
      const result = await api<{ operation: Operation }>(`/api/platform/tenants/${tenantId}/operations`, {
        method: 'POST', body: JSON.stringify({ kind }),
      })
      setSelectedOperation(result.operation.id)
      reload()
      onChanged()
    } catch (cause) {
      setError(guard(cause, 'No se pudo iniciar la operación.'))
    } finally {
      setBusy(false)
    }
  }

  async function resendInvitation() {
    setBusy(true)
    setError('')
    try {
      const result = await api<{ invitationStatus: string; previewUrl?: string }>(`/api/platform/tenants/${tenantId}/invitation`, { method: 'POST', body: '{}' })
      setPreviewUrl(webLink(result.previewUrl))
      reload()
    } catch (cause) {
      setError(guard(cause, 'No se pudo enviar la invitación.'))
    } finally {
      setBusy(false)
    }
  }

  if (!tenant) {
    return <section className="pa-card pa-empty pa-empty-detail" role="status">
      {error ? <div className="pa-error" role="alert"><CircleAlert size={17} /><span>{error}</span></div> : <><span className="pa-spinner" /> Cargando institución…</>}
    </section>
  }

  const running = isBusy(tenant)
  const shownOperation = selectedOperation ?? operations[0]?.id
  const appLink = tenant.status === 'active' ? attendanceLoginLink(tenant.appUrl ?? undefined) : undefined

  return <article className="pa-card pa-detail to-detail" aria-labelledby="to-detail-title">
    <header className="pa-detail-head">
      <span className="pa-icon-tile"><Building2 size={23} /></span>
      <div><p>{tenant.slug}</p><h2 id="to-detail-title">{tenant.institutionName}</h2></div>
      <TenantStatusBadge status={tenant.status} />
    </header>

    <div className="to-actions" role="group" aria-label="Acciones de la institución">
      {actionButtons.filter(action => tenant.allowedOperations.includes(action.kind)).map(action =>
        <button key={action.kind} type="button" className={action.kind === 'create' ? 'pa-primary' : 'pa-secondary'} disabled={busy || running} onClick={() => void run(action.kind)}>
          <action.Icon size={15} aria-hidden="true" /> {action.label(tenant)}
        </button>)}
      {tenant.allowedOperations.includes('delete') && <button type="button" className="pa-secondary to-danger-outline" disabled={busy || running} onClick={() => setDeleting(true)}>
        <Trash2 size={15} aria-hidden="true" /> Eliminar
      </button>}
      {appLink && <a className="pa-secondary to-link-button" href={appLink} target="_blank" rel="noreferrer">Abrir app <ExternalLink size={14} /></a>}
    </div>
    {running && <p className="to-muted" role="status"><Loader2 size={14} className="to-spin" aria-hidden="true" /> Hay una operación en curso; las acciones se habilitan al terminar.</p>}
    {error && <div className="pa-error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}

    <div className="to-grid">
      <section aria-labelledby="to-config-title">
        <h3 id="to-config-title">Configuración</h3>
        <dl className="to-dl">
          <div><dt>Plan</dt><dd>{tenant.planName}</dd></div>
          <div><dt>Entorno</dt><dd>{optionLabel(environments, tenant.environment)}</dd></div>
          <div><dt>Región</dt><dd>{tenant.region}</dd></div>
          <div><dt>Motor</dt><dd>{tenant.engine}</dd></div>
          <div><dt>Administrador</dt><dd>{tenant.adminName} · {tenant.adminEmail}</dd></div>
          <div><dt>URL</dt><dd>{tenant.appUrl ? <code>{tenant.appUrl}</code> : '—'}</dd></div>
        </dl>
      </section>
      <section aria-labelledby="to-invite-title">
        <h3 id="to-invite-title">Acceso del administrador</h3>
        <p className="to-muted">Invitación: <strong>{tenant.invitationStatus}</strong>{tenant.invitationUpdatedAt ? ` · ${formatDate(tenant.invitationUpdatedAt)}` : ''}</p>
        {tenant.status === 'active' && tenant.invitationStatus !== 'activated' && <button type="button" className="pa-secondary" disabled={busy} onClick={() => void resendInvitation()}>
          <Mail size={15} aria-hidden="true" /> Enviar invitación
        </button>}
        {previewUrl && <a className="pa-preview-link" href={previewUrl} target="_blank" rel="noreferrer">Abrir invitación de prueba <ExternalLink size={14} /><small>Vista previa de desarrollo</small></a>}
      </section>
    </div>

    <section aria-labelledby="to-infra-title">
      <h3 id="to-infra-title">Infraestructura{tenant.infrastructure?.availabilityZone ? ` · ${tenant.infrastructure.availabilityZone}` : ''}</h3>
      <InfrastructureTable tenant={tenant} />
    </section>

    <section aria-labelledby="to-ops-title">
      <h3 id="to-ops-title">Operaciones</h3>
      {operations.length === 0 ? <p className="to-muted">Todavía no hay operaciones.</p> : <ul className="to-op-list">
        {operations.map(operation => <li key={operation.id}>
          <button type="button" aria-pressed={operation.id === shownOperation} onClick={() => setSelectedOperation(operation.id)}>
            <span><strong>{operationLabels[operation.kind]}</strong><small>{formatDate(operation.queuedAt)}</small></span>
            <span className={`to-op-status to-op-${operation.status}`}>{operationStatusLabels[operation.status]}</span>
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        </li>)}
      </ul>}
      {shownOperation && <OperationProgress key={shownOperation} operationId={shownOperation} onFinished={operationFinished} onSessionExpired={onSessionExpired} />}
    </section>

    {deleting && <DeleteTenantDialog tenant={tenant} onSessionExpired={onSessionExpired} onClose={() => setDeleting(false)} onDeleted={operationId => {
      setDeleting(false)
      setSelectedOperation(operationId)
      reload()
      onChanged()
    }} />}
  </article>
}

// ---------------------------------------------------------------------------
// Lista con filtros
// ---------------------------------------------------------------------------

export default function TenantsView({ plans, initialTenantId, revision, onSessionExpired }: {
  plans: Plan[]
  initialTenantId?: string
  revision: number
  onSessionExpired: () => void
}) {
  const [tenants, setTenants] = useState<Tenant[]>()
  const [selectedId, setSelectedId] = useState(initialTenantId)
  const [name, setName] = useState('')
  const [status, setStatus] = useState('')
  const [plan, setPlan] = useState('')
  const [environment, setEnvironment] = useState('')
  const [listRevision, setListRevision] = useState(0)
  const [error, setError] = useState('')
  const guard = useSessionGuard(onSessionExpired)
  const changed = useCallback(() => setListRevision(previous => previous + 1), [])

  useEffect(() => {
    let active = true
    const params = new URLSearchParams()
    if (name.trim()) params.set('name', name.trim())
    if (status) params.set('status', status)
    if (plan) params.set('plan', plan)
    if (environment) params.set('environment', environment)
    const timer = window.setTimeout(() => {
      api<{ tenants: Tenant[] }>(`/api/platform/tenants?${params}`)
        .then(result => {
          if (!active) return
          setTenants(result.tenants)
          setError('')
        })
        .catch(cause => { if (active) setError(guard(cause, 'No se pudo cargar la lista de instituciones.')) })
    }, 250)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [name, status, plan, environment, listRevision, revision, guard])

  // Mientras alguna operación avanza, la lista se refresca sola
  const anyBusy = tenants?.some(isBusy) ?? false
  useEffect(() => {
    if (!anyBusy) return
    const timer = window.setInterval(changed, 5000)
    return () => window.clearInterval(timer)
  }, [anyBusy, changed])

  const selected = tenants?.find(tenant => tenant.id === selectedId) ?? tenants?.[0]

  return <div className="pa-console-grid">
    <section className="pa-card pa-list" aria-labelledby="to-list-title">
      <header><h2 id="to-list-title">Instituciones</h2><span>{tenants?.length ?? 0}</span></header>
      <div className="pa-list-controls to-filters">
        <div className="pa-search"><Search size={17} /><input type="search" aria-label="Buscar por nombre o identificador" placeholder="Nombre o identificador…" value={name} onChange={event => setName(event.target.value)} /></div>
        <select aria-label="Filtrar por estado" value={status} onChange={event => setStatus(event.target.value)}>
          <option value="">Todos los estados</option>
          {Object.entries(tenantStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select aria-label="Filtrar por plan" value={plan} onChange={event => setPlan(event.target.value)}>
          <option value="">Todos los planes</option>
          {plans.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <select aria-label="Filtrar por entorno" value={environment} onChange={event => setEnvironment(event.target.value)}>
          <option value="">Todos los entornos</option>
          {environments.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </div>
      {error && <div className="pa-error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}
      {!tenants ? <div className="pa-empty" role="status"><span className="pa-spinner" /> Cargando…</div>
        : tenants.length === 0 ? <div className="pa-empty"><Building2 size={24} /><p>No hay instituciones para estos filtros.</p></div>
          : <ul>
            {tenants.map(tenant => <li key={tenant.id}>
              <button type="button" aria-pressed={selected?.id === tenant.id} onClick={() => setSelectedId(tenant.id)}>
                <span className="pa-row-text"><strong>{tenant.institutionName}</strong><small>{tenant.planName} · {optionLabel(environments, tenant.environment)} · {tenant.slug}</small></span>
                <ChevronRight size={16} />
                <TenantStatusBadge status={tenant.status} />
              </button>
            </li>)}
          </ul>}
    </section>
    {selected ? <TenantDetail key={selected.id} tenantId={selected.id} onChanged={changed} onSessionExpired={onSessionExpired} />
      : <section className="pa-card pa-empty pa-empty-detail"><span className="pa-icon-tile"><Building2 size={24} /></span><h2>Detalles de la institución</h2><p>Selecciona una institución para ver su estado y sus operaciones.</p></section>}
  </div>
}
