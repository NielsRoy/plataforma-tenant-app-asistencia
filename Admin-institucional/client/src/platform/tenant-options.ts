export type Provider = 'aws' | 'azure'

// available: lo que la infraestructura actual puede desplegar (AMIs solo en
// us-east-1 y motor Terraform). El resto se muestra deshabilitado: son puntos de
// extensión (RF-08).
export const providers = [
  { value: 'aws', label: 'AWS', available: true },
  { value: 'azure', label: 'Azure', available: false },
] satisfies { value: Provider; label: string; available: boolean }[]

export const regions = [
  { value: 'us-east-1', label: 'Virginia del Norte · AWS', provider: 'aws', available: true },
  { value: 'us-west-2', label: 'Oregón · AWS', provider: 'aws', available: false },
  { value: 'eastus', label: 'Este de EE. UU. · Azure', provider: 'azure', available: false },
] satisfies { value: string; label: string; provider: Provider; available: boolean }[]

export const environments = [
  { value: 'production', label: 'Producción' },
  { value: 'staging', label: 'Pruebas' },
]

export const engines = [
  { value: 'terraform', label: 'Terraform', available: true },
  { value: 'opentofu', label: 'OpenTofu', available: false },
  { value: 'pulumi', label: 'Pulumi', available: false },
  { value: 'cloudformation', label: 'CloudFormation', available: false },
]

// Mismo límite que el módulo de Terraform y la API
export const slugMaxLength = 42

export function slugFromName(name: string) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, slugMaxLength).replace(/-+$/g, '')
}

export function optionLabel(options: { value: string; label: string }[], value: string) {
  return options.find(option => option.value === value)?.label ?? value
}

export const tenantStatusLabels = {
  pending: 'Sin desplegar',
  provisioning: 'Desplegando',
  active: 'Activa',
  suspending: 'Suspendiendo',
  suspended: 'Suspendida',
  resuming: 'Reanudando',
  deleting: 'Eliminando',
  deleted: 'Eliminada',
  failed: 'Con error',
} as const

export const operationLabels = {
  create: 'Crear',
  suspend: 'Suspender',
  resume: 'Reanudar',
  redeploy: 'Volver a desplegar',
  delete: 'Eliminar',
} as const

export const operationStatusLabels = {
  queued: 'En cola',
  running: 'En curso',
  succeeded: 'Completada',
  failed: 'Fallida',
  cancelled: 'Cancelada',
} as const

export const stepLabels: Record<string, string> = {
  preparar: 'Preparar',
  escanear: 'Escanear código',
  init: 'Terraform init',
  plan: 'Terraform plan',
  apply: 'Terraform apply',
  refrescar: 'Refrescar estado',
  outputs: 'Leer outputs',
  ansible: 'Ansible',
  salud: 'Salud de la app',
  invitacion: 'Invitación',
  monitoreo: 'Monitoreo',
  limpieza: 'Limpieza',
}
