data "aws_caller_identity" "current" {}

# Los tenants se despliegan en la VPC por defecto. Si la cuenta no la tiene,
# el bootstrap falla aquí y no más tarde, al crear el primer tenant.
data "aws_vpc" "default" {
  default = true
}

locals {
  # El nombre del bucket es global en AWS: se incluye el id de la cuenta y la región
  state_bucket_name = "${var.project}-tfstate-${data.aws_caller_identity.current.account_id}-${var.region}"
}

# ---------------------------------------------------------------------------
# Bucket del estado remoto de los tenants
# ---------------------------------------------------------------------------
resource "aws_s3_bucket" "state" {
  bucket = local.state_bucket_name
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Versionado: cada escritura del estado deja la versión anterior recuperable
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Cifrado en reposo con la clave administrada por S3 (SSE-S3, sin costo).
# Una CMK de KMS sería más estricta, pero cobra por clave y por uso.
resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "expirar-versiones-antiguas"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_state_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.state]
}

# Solo se aceptan conexiones cifradas (HTTPS) al bucket
data "aws_iam_policy_document" "state_tls_only" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.state.arn,
      "${aws_s3_bucket.state.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state_tls_only.json

  depends_on = [aws_s3_bucket_public_access_block.state]
}

# ---------------------------------------------------------------------------
# Key pair SSH del operador (Ansible entra con esta clave a todas las EC2)
# ---------------------------------------------------------------------------
resource "aws_key_pair" "operator" {
  key_name   = "${var.project}-operator"
  public_key = trimspace(file(var.ssh_public_key_path))
}

# ---------------------------------------------------------------------------
# Configuración del backend para los stacks de tenant
# terraform init -backend-config=backend.hcl -backend-config="key=tenants/<slug>/terraform.tfstate"
# ---------------------------------------------------------------------------
resource "local_file" "tenant_backend_config" {
  filename        = "${path.module}/../tenant/backend.hcl"
  file_permission = "0644"
  content         = <<-EOT
    # Generado por infra/terraform/bootstrap. No editar a mano.
    bucket       = "${aws_s3_bucket.state.id}"
    region       = "${var.region}"
    encrypt      = true
    use_lockfile = true
  EOT
}
