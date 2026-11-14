-- Aprovisionamiento de tenants: estado del ciclo de vida, operaciones con su log,
-- alertas del monitoreo y secretos cifrados.

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------
--   pending      registrado, todavía sin infraestructura (registros anteriores)
--   provisioning se está creando (terraform apply + ansible)
--   active       funcionando
--   suspending / suspended / resuming
--   deleting / deleted
--   failed       la última operación falló; ver platform_operations
ALTER TABLE platform_tenants
    ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'provisioning', 'active', 'suspending', 'suspended',
                          'resuming', 'deleting', 'deleted', 'failed')),
    -- Copia del plan de la solicitud. Punto de extensión para cambiar de plan.
    ADD COLUMN plan_id TEXT REFERENCES platform_plans(id),
    -- Contrato de outputs del motor IaC (app_url, IPs, ids, AMIs...). Sin secretos.
    ADD COLUMN outputs JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Secretos del tenant (contraseña de la BD, JWT_SECRET, clave de invitación),
    -- cifrados con AES-256-GCM y PLATFORM_SECRETS_KEY: iv (12) | tag (16) | datos.
    -- Nunca pasan por Terraform: solo se descifran para entregárselos a Ansible.
    ADD COLUMN secrets_enc BYTEA CHECK (secrets_enc IS NULL OR octet_length(secrets_enc) > 28),
    ADD COLUMN status_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN deleted_at TIMESTAMPTZ;

UPDATE platform_tenants t
SET plan_id = r.plan_id
FROM platform_requests r
WHERE r.id = t.request_id;

ALTER TABLE platform_tenants ALTER COLUMN plan_id SET NOT NULL;

-- Un tenant eliminado libera su slug y su URL (AWS puede reutilizar la IP elástica).
-- Los índices conservan el nombre de las restricciones anteriores, que la API usa
-- para mostrar errores claros.
ALTER TABLE platform_tenants DROP CONSTRAINT platform_tenants_slug_key;
CREATE UNIQUE INDEX platform_tenants_slug_key ON platform_tenants (slug) WHERE status <> 'deleted';
ALTER TABLE platform_tenants DROP CONSTRAINT platform_tenants_app_url_key;
CREATE UNIQUE INDEX platform_tenants_app_url_key ON platform_tenants (app_url) WHERE status <> 'deleted';

CREATE INDEX platform_tenants_status_idx ON platform_tenants (status);

-- ---------------------------------------------------------------------------
-- Operaciones: cada creación, suspensión, reanudación o eliminación es una fila.
-- El worker las toma en orden con SELECT ... FOR UPDATE SKIP LOCKED.
-- ---------------------------------------------------------------------------
CREATE TABLE platform_operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES platform_tenants(id),
    -- Punto de extensión: 'change_plan', 'backup' y 'restore' se agregarán aquí.
    kind TEXT NOT NULL CHECK (kind IN ('create', 'suspend', 'resume', 'delete', 'redeploy')),
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    engine TEXT NOT NULL CHECK (engine IN ('terraform', 'opentofu', 'pulumi', 'cloudformation')),
    -- Parámetros de la operación (p. ej. tipos de instancia del plan, IP del operador)
    params JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Pasos con su estado: [{ "name": "scan", "status": "succeeded", "startedAt": ..., "finishedAt": ... }]
    steps JSONB NOT NULL DEFAULT '[]'::jsonb,
    current_step TEXT,
    -- Mensaje comprensible para el operador, sin secretos ni trazas internas
    error_message TEXT,
    -- RF-13: versiones usadas (toolbox, providers, AMIs, commit de la app y de la plataforma)
    versions JSONB NOT NULL DEFAULT '{}'::jsonb,
    attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
    -- Punto de extensión: reintento de una operación fallida
    retry_of UUID REFERENCES platform_operations(id),
    -- Punto de extensión (RF-20, auditoría): quién la pidió
    requested_by TEXT,
    worker_id TEXT,
    queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    heartbeat_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);

-- Una sola operación pendiente o en curso por tenant
CREATE UNIQUE INDEX platform_operations_one_active_idx
    ON platform_operations (tenant_id) WHERE status IN ('queued', 'running');
CREATE INDEX platform_operations_queue_idx ON platform_operations (queued_at) WHERE status = 'queued';
CREATE INDEX platform_operations_tenant_idx ON platform_operations (tenant_id, queued_at DESC);

-- Log línea por línea, ya saneado (sin secretos). La interfaz lo lee por partes con
-- "id > último visto" mientras la operación avanza.
CREATE TABLE platform_operation_logs (
    id BIGSERIAL PRIMARY KEY,
    operation_id UUID NOT NULL REFERENCES platform_operations(id) ON DELETE CASCADE,
    step TEXT NOT NULL,
    stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'system')),
    line TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX platform_operation_logs_operation_idx ON platform_operation_logs (operation_id, id);

-- ---------------------------------------------------------------------------
-- Alertas que envía Grafana por webhook
-- ---------------------------------------------------------------------------
CREATE TABLE platform_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fingerprint TEXT NOT NULL,
    tenant_id UUID REFERENCES platform_tenants(id),
    tenant_slug TEXT,
    environment TEXT,
    role TEXT,
    alert_name TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'warning',
    status TEXT NOT NULL CHECK (status IN ('firing', 'resolved')),
    summary TEXT,
    labels JSONB NOT NULL DEFAULT '{}'::jsonb,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (fingerprint, starts_at)
);

CREATE INDEX platform_alerts_tenant_idx ON platform_alerts (tenant_id, starts_at DESC);
CREATE INDEX platform_alerts_firing_idx ON platform_alerts (starts_at DESC) WHERE status = 'firing';

-- ---------------------------------------------------------------------------
-- Planes con tipos del Free Tier de AWS (todos x86_64, como las AMIs)
--   t3.micro 2 vCPU / 1 GiB, t3.small 2 vCPU / 2 GiB,
--   c7i-flex.large 2 vCPU / 4 GiB, m7i-flex.large 2 vCPU / 8 GiB
-- Discos pequeños: el Free Tier incluye 30 GB de EBS. El mínimo es 8 GB (tamaño de
-- las AMIs).
-- ---------------------------------------------------------------------------
UPDATE platform_plan_instances AS i
SET aws_type = v.aws_type, vcpu = v.vcpu, ram_gib = v.ram_gib, system_disk_gb = v.disk
FROM (VALUES
    ('basico',   'frontend', 't3.micro',       2, 1, 8),
    ('basico',   'backend',  't3.micro',       2, 1, 8),
    ('basico',   'database', 't3.micro',       2, 1, 8),
    ('estandar', 'frontend', 't3.micro',       2, 1, 8),
    ('estandar', 'backend',  't3.small',       2, 2, 8),
    ('estandar', 'database', 't3.small',       2, 2, 10),
    ('avanzado', 'frontend', 't3.small',       2, 2, 8),
    ('avanzado', 'backend',  'c7i-flex.large', 2, 4, 8),
    ('avanzado', 'database', 'm7i-flex.large', 2, 8, 12)
) AS v(plan_id, role, aws_type, vcpu, ram_gib, disk)
WHERE i.plan_id = v.plan_id AND i.role = v.role;

-- Planes creados por el operador con otros tipos o discos: se ajustan al Free Tier
-- para que la restricción de abajo se pueda crear.
UPDATE platform_plan_instances
SET aws_type = 't3.micro', vcpu = 2, ram_gib = 1
WHERE aws_type NOT IN ('t3.micro', 't3.small', 'c7i-flex.large', 'm7i-flex.large');

UPDATE platform_plan_instances
SET system_disk_gb = LEAST(GREATEST(system_disk_gb, 8), 30)
WHERE system_disk_gb NOT BETWEEN 8 AND 30;

-- Tipos admitidos por la infraestructura actual (AMIs x86_64). Si se agrega uno nuevo,
-- se amplía esta lista en una migración.
ALTER TABLE platform_plan_instances
    ADD CONSTRAINT platform_plan_instances_free_tier_type_check
        CHECK (aws_type IN ('t3.micro', 't3.small', 'c7i-flex.large', 'm7i-flex.large')),
    ADD CONSTRAINT platform_plan_instances_free_tier_disk_check CHECK (system_disk_gb BETWEEN 8 AND 30);
