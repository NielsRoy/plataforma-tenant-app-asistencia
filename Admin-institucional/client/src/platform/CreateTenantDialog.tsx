import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowRight, Building2, ChevronRight, CircleAlert, Rocket, X } from 'lucide-react'
import { ApiError, api, errorMessage, formatNumber, type Operation, type Plan, type Tenant } from './api'
import {
  engines, environments, optionLabel, providers, regions, slugFromName, slugMaxLength, type Provider,
} from './tenant-options'
import './create-plan.css'

// Alta de una institución (RF-07): registra la institución y encola la creación de su
// infraestructura (Terraform + Ansible). El progreso se sigue en la vista Instituciones.

interface TenantDraft {
  institutionName: string
  adminName: string
  adminEmail: string
  planId: string
  slug: string
  provider: Provider
  region: string
  environment: string
  engine: string
}

type Props = {
  plans: Plan[]
  usedSlugs: string[]
  onClose: () => void
  onCreated: (tenant: Tenant, operation: Operation) => void
  onSessionExpired: () => void
}

const available = <T extends { available: boolean }>(options: T[]) => options.filter(option => option.available)

export default function CreateTenantDialog({ plans, usedSlugs, onClose, onCreated, onSessionExpired }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const reviewHeading = useRef<HTMLHeadingElement>(null)
  const [institutionName, setInstitutionName] = useState('')
  const [customSlug, setCustomSlug] = useState<string>()
  const [provider, setProvider] = useState<Provider>(available(providers)[0].value)
  const [region, setRegion] = useState(available(regions)[0].value)
  const [engine, setEngine] = useState(available(engines)[0].value)
  const [planId, setPlanId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [review, setReview] = useState<TenantDraft>()
  const plan = plans.find(item => item.id === planId)
  const regionChoices = regions.filter(option => option.provider === provider)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    nameRef.current?.focus({ preventScroll: true })
    return () => { if (dialog.open) dialog.close() }
  }, [])

  useEffect(() => {
    if (review) {
      bodyRef.current?.scrollTo(0, 0)
      reviewHeading.current?.focus({ preventScroll: true })
    }
  }, [review])

  function dismiss() {
    dialogRef.current?.close()
    onClose()
  }

  async function create(draft: TenantDraft) {
    setBusy(true)
    setError('')
    try {
      const result = await api<{ tenant: Tenant; operation: Operation }>('/api/platform/tenants', {
        method: 'POST',
        body: JSON.stringify({
          institutionName: draft.institutionName, adminName: draft.adminName, adminEmail: draft.adminEmail,
          planId: draft.planId, slug: draft.slug, region: draft.region, environment: draft.environment, engine: draft.engine,
        }),
      })
      dialogRef.current?.close()
      onCreated(result.tenant, result.operation)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        onSessionExpired()
        return
      }
      setError(errorMessage(cause, 'No se pudo crear la institución. Intenta de nuevo.'))
      setBusy(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (review) {
      void create(review)
      return
    }
    const data = new FormData(event.currentTarget)
    const read = (field: string) => String(data.get(field) ?? '').trim()
    const draft = {
      institutionName: institutionName.trim(),
      adminName: read('adminName'),
      adminEmail: read('adminEmail'),
      planId,
      slug: read('slug'),
      provider,
      region,
      environment: read('environment'),
      engine,
    }
    if (draft.institutionName.length < 2 || draft.adminName.length < 2 || draft.slug.length < 3 || !plan) {
      setError('Completa los nombres, selecciona un plan y usa un identificador de al menos 3 caracteres.')
      return
    }
    if (usedSlugs.includes(draft.slug)) {
      setError('Ese identificador ya está en uso. Elige uno diferente.')
      return
    }
    setError('')
    setReview(draft)
  }

  function backToDetails() {
    setReview(undefined)
    requestAnimationFrame(() => {
      bodyRef.current?.scrollTo(0, 0)
      nameRef.current?.focus({ preventScroll: true })
    })
  }

  return <dialog className="pcd-dialog pct-dialog" ref={dialogRef} aria-labelledby="pct-title" aria-describedby="pct-description" onCancel={event => {
    event.preventDefault()
    if (!busy) dismiss()
  }}>
    <form className="pcd-form" onSubmit={submit}>
      <header className="pcd-header">
        <span className="pcd-header-icon"><Building2 size={23} aria-hidden="true" /></span>
        <div><h2 id="pct-title">Crear institución</h2><p id="pct-description">Registra la institución y despliega su infraestructura en AWS.</p></div>
        <button type="button" className="pcd-close" onClick={dismiss} disabled={busy} aria-label="Cerrar formulario"><X size={20} /></button>
      </header>
      <ol className="pct-steps" aria-label="Pasos para crear la institución">
        <li aria-current={review ? undefined : 'step'}>Datos y configuración</li>
        <li aria-current={review ? 'step' : undefined}><ChevronRight size={14} aria-hidden="true" /> Revisión</li>
      </ol>
      <div className="pcd-body" ref={bodyRef}>
        <div hidden={Boolean(review)}>
          <fieldset>
            <legend>Datos de la institución</legend>
            <div className="pct-fields">
              <label className="pcd-field"><span>Nombre de la institución</span>
                <input ref={nameRef} name="institutionName" autoComplete="organization" minLength={2} maxLength={160}
                  value={institutionName} onChange={event => setInstitutionName(event.target.value)} required />
              </label>
              <label className="pcd-field"><span>Identificador único</span>
                <input name="slug" value={customSlug ?? slugFromName(institutionName)}
                  onChange={event => setCustomSlug(event.target.value.toLowerCase())}
                  aria-describedby="pct-slug-help" pattern="[a-z0-9]+(?:\x2d[a-z0-9]+)*" minLength={3} maxLength={slugMaxLength} autoComplete="off" required />
              </label>
              <p className="pct-help pcd-full" id="pct-slug-help">De 3 a {slugMaxLength} caracteres: minúsculas, números y guiones entre palabras. Aparece en los nombres de los recursos de AWS.</p>
              <label className="pcd-field"><span>Nombre del administrador</span>
                <input name="adminName" autoComplete="name" minLength={2} maxLength={120} required />
              </label>
              <label className="pcd-field"><span>Correo del administrador</span>
                <input name="adminEmail" type="email" autoComplete="email" maxLength={254} required />
              </label>
            </div>
          </fieldset>
          <fieldset className="pcd-resources">
            <legend>Plan y despliegue</legend>
            <fieldset className="pct-plan-list">
              <legend>Selecciona un plan</legend>
              {plans.length > 0 ? <div className="pct-plan-grid">
                {plans.map(item => <label className="pct-plan-choice" key={item.id}>
                  <span className="pct-plan-title">
                    <input type="radio" name="planId" value={item.id} aria-label={item.name}
                      checked={item.id === planId} onChange={() => setPlanId(item.id)} required />
                    <strong>{item.name}</strong>
                  </span>
                  <span>{formatNumber(item.limitStudents)} estudiantes</span>
                  <span>{formatNumber(item.databaseGb)} GB de datos</span>
                  <span>Respaldo {item.backup.toLocaleLowerCase('es')}</span>
                  {item.instances.map(instance => <span key={instance.role} className="pct-plan-machine">
                    {instance.role}: <code>{instance.awsType}</code> · {formatNumber(instance.ramGib)} GiB · {formatNumber(instance.systemDiskGb)} GB
                  </span>)}
                </label>)}
              </div> : <p className="pct-help">Crea un plan en el catálogo para continuar.</p>}
            </fieldset>
            <div className="pct-fields">
              <label className="pcd-field"><span>Proveedor</span>
                <select value={provider} onChange={event => setProvider(event.target.value as Provider)}>
                  {providers.map(option => <option key={option.value} value={option.value} disabled={!option.available}>{option.label}{option.available ? '' : ' (próximamente)'}</option>)}
                </select>
              </label>
              <label className="pcd-field"><span>Región</span>
                <select value={region} onChange={event => setRegion(event.target.value)}>
                  {regionChoices.map(option => <option key={option.value} value={option.value} disabled={!option.available}>{option.label}{option.available ? '' : ' (sin imágenes)'}</option>)}
                </select>
              </label>
              <label className="pcd-field"><span>Entorno</span>
                <select name="environment">
                  {environments.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="pcd-field"><span>Motor de infraestructura</span>
                <select value={engine} onChange={event => setEngine(event.target.value)}>
                  {engines.map(option => <option key={option.value} value={option.value} disabled={!option.available}>{option.label}{option.available ? '' : ' (próximamente)'}</option>)}
                </select>
              </label>
            </div>
          </fieldset>
        </div>
        {review && <section className="pct-review" aria-labelledby="pct-review-title">
          <h3 id="pct-review-title" ref={reviewHeading} tabIndex={-1}>Revisa la configuración</h3>
          <dl>
            <div><dt>Institución</dt><dd>{review.institutionName}</dd></div>
            <div><dt>Identificador</dt><dd>{review.slug}</dd></div>
            <div><dt>Administrador</dt><dd>{review.adminName}</dd></div>
            <div><dt>Correo del administrador</dt><dd>{review.adminEmail}</dd></div>
            <div><dt>Proveedor</dt><dd>{optionLabel(providers, review.provider)}</dd></div>
            <div><dt>Región</dt><dd>{optionLabel(regions, review.region)}</dd></div>
            <div><dt>Entorno</dt><dd>{optionLabel(environments, review.environment)}</dd></div>
            <div><dt>Motor de infraestructura</dt><dd>{optionLabel(engines, review.engine)}</dd></div>
          </dl>
          {plan && <div className="pct-review-plan">
            <h4>Plan {plan.name}</h4>
            <p>{formatNumber(plan.limitStudents)} estudiantes · {formatNumber(plan.databaseGb)} GB de datos · Respaldo {plan.backup.toLocaleLowerCase('es')}</p>
            <p>{plan.instances.map(instance => `${instance.role} ${instance.awsType}`).join(' · ')}</p>
          </div>}
          <p className="pct-help">Se crearán 3 EC2, sus Security Groups y una IP elástica. El despliegue tarda entre 5 y 10 minutos y puedes seguirlo en vivo.</p>
        </section>}
      </div>
      <footer className="pcd-footer">
        {error && <div className="pcd-error" role="alert"><CircleAlert size={17} aria-hidden="true" /><span>{error}</span></div>}
        <div className="pcd-footer-row">
          <p>El despliegue continúa aunque cierres el panel.</p>
          <div className="pcd-actions">
            {review ? <>
              <button type="button" className="pcd-secondary" onClick={backToDetails} disabled={busy}>Volver a los datos</button>
              <button type="submit" className="pcd-primary" disabled={busy}><Rocket size={17} aria-hidden="true" /> {busy ? 'Creando…' : 'Crear y desplegar'}</button>
            </> : <>
              <button type="button" className="pcd-secondary" onClick={dismiss}>Cancelar</button>
              <button type="submit" className="pcd-primary" disabled={plans.length === 0}>Revisar institución <ArrowRight size={17} aria-hidden="true" /></button>
            </>}
          </div>
        </div>
      </footer>
    </form>
  </dialog>
}
