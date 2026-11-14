export interface PlanInstance {
  role: 'frontend' | 'backend' | 'database'
  vcpu: number
  ramGib: number
  systemDiskGb: number
  awsType: string
  azureType: string
}

export interface Plan {
  id: string
  name: string
  description: string
  limitStudents: number
  databaseGb: number
  backup: string
  instances: PlanInstance[]
}

export type InvitationStatus = 'pending' | 'sent' | 'failed' | 'activated' | 'preview'

export type TenantStatus = 'pending' | 'provisioning' | 'active' | 'suspending' | 'suspended'
  | 'resuming' | 'deleting' | 'deleted' | 'failed'

export interface InstallationStatus {
  status?: TenantStatus
  appUrl?: string
  invitationStatus?: InvitationStatus
  invitationUpdatedAt?: string
}

export interface TenantConfiguration extends InstallationStatus {
  id: string
  slug: string
  region: string
  environment: string
  engine: string
  createdAt: string
}

export interface TrackedRequest {
  id: string
  institutionName: string
  planId: string
  status: 'pending' | 'registered'
  createdAt: string
  updatedAt: string
  tenant?: InstallationStatus
}

export interface TenantRequest extends TrackedRequest {
  adminName: string
  adminEmail: string
  tenant?: TenantConfiguration
}

export type OperationKind = 'create' | 'suspend' | 'resume' | 'redeploy' | 'delete'
export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface OperationStep {
  name: string
  status: 'running' | 'succeeded' | 'failed'
  startedAt: string
  finishedAt?: string
}

export interface OperationSummary {
  id: string
  kind: OperationKind
  status: OperationStatus
  currentStep: string | null
  errorMessage: string | null
  queuedAt: string
  finishedAt: string | null
}

export interface Operation extends OperationSummary {
  steps: OperationStep[]
  versions: Record<string, unknown>
  attempt: number
  requestedBy: string | null
  startedAt: string | null
}

export interface TenantInfrastructure {
  appUrl?: string
  availabilityZone?: string
  publicIps?: Record<string, string>
  privateIps?: Record<string, string>
  instanceIds?: Record<string, string>
  amiIds?: Record<string, string>
  securityGroupIds?: Record<string, string>
}

export interface Tenant {
  id: string
  slug: string
  status: TenantStatus
  statusUpdatedAt: string
  institutionName: string
  adminName: string
  adminEmail: string
  requestId: string
  planId: string
  planName: string
  region: string
  environment: string
  engine: string
  createdAt: string
  appUrl: string | null
  invitationStatus: InvitationStatus
  invitationUpdatedAt: string | null
  infrastructure: TenantInfrastructure | null
  allowedOperations: OperationKind[]
  lastOperation: OperationSummary | null
}

export interface LogLine {
  id: number
  step: string
  stream: 'stdout' | 'stderr' | 'system'
  line: string
}

export interface DeletionPreview {
  slug: string
  institutionName: string
  appUrl: string | null
  resources: string[]
  summary: { instances: number; securityGroups: number; securityGroupRules: number; elasticIps: number; total: number }
  dataLoss: string[]
  confirmWith: string
}

export interface PlatformUser {
  name: string
  email: string
}

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  if (response.status === 204) return undefined as T

  const isJson = response.headers.get('content-type')?.includes('application/json')
  if (!isJson) {
    throw new ApiError('El servicio de plataforma no está disponible. Inténtalo nuevamente.', response.status)
  }

  const data = await response.json()
  if (!response.ok) {
    throw new ApiError(typeof data.message === 'string' ? data.message : 'No se pudo completar la operación.', response.status)
  }
  return data as T
}

export const formatDate = (value: string) => new Intl.DateTimeFormat('es-BO', {
  dateStyle: 'medium',
  timeStyle: 'short',
}).format(new Date(value))

export const formatNumber = (value: number) => new Intl.NumberFormat('es-BO').format(value)

export function webLink(value?: string) {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url.href
  } catch {
    return undefined
  }
  return undefined
}

export function attendanceLoginLink(origin?: string) {
  const href = webLink(origin)
  return href ? new URL('/login', href).href : undefined
}

export const errorMessage = (error: unknown, fallback: string) => (
  error instanceof ApiError && error.status < 500 ? error.message : fallback
)
