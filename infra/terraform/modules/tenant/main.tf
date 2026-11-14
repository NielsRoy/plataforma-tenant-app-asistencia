locals {
  name_prefix = "${var.project}-${var.tenant_slug}"
  roles       = toset(["frontend", "backend", "database"])

  tags = {
    Tenant      = var.tenant_slug
    Environment = var.environment
  }

  # Zona: la indicada o la primera que ofrece todos los tipos de instancia del plan
  instance_types = distinct(values(var.instance_types))
  candidate_azs = sort([
    for az in distinct(data.aws_ec2_instance_type_offerings.selected.locations) : az
    if length([for location in data.aws_ec2_instance_type_offerings.selected.locations : location if location == az]) == length(local.instance_types)
  ])
  availability_zone = coalesce(var.availability_zone, try(local.candidate_azs[0], null))

  # Reglas "puerto de métricas x IP del operador" y "SSH x IP del operador"
  operator_rules = merge([
    for role in local.roles : merge(
      { for cidr in var.operator_cidrs : "${role}-ssh-${cidr}" => { role = role, name = "ssh", port = 22, cidr = cidr } },
      merge([
        for name, port in var.metrics_ports : {
          for cidr in var.operator_cidrs : "${role}-${name}-${cidr}" => { role = role, name = name, port = port, cidr = cidr }
        }
      ]...)
    )
  ]...)
}

# ---------------------------------------------------------------------------
# Red: VPC por defecto. El aislamiento entre tenants lo dan los Security Groups.
# ---------------------------------------------------------------------------

data "aws_vpc" "default" {
  default = true
}

data "aws_ec2_instance_type_offerings" "selected" {
  location_type = "availability-zone"

  filter {
    name   = "instance-type"
    values = local.instance_types
  }
}

data "aws_subnet" "selected" {
  vpc_id            = data.aws_vpc.default.id
  availability_zone = local.availability_zone
  default_for_az    = true
}

# ---------------------------------------------------------------------------
# AMIs construidas con Packer (infra/packer), buscadas por tags
# ---------------------------------------------------------------------------

data "aws_ami" "role" {
  for_each = local.roles

  owners      = ["self"]
  most_recent = true

  filter {
    name   = "tag:Project"
    values = [var.project]
  }

  filter {
    name   = "tag:Role"
    values = [each.key]
  }

  dynamic "filter" {
    for_each = var.image_version == null ? [] : [var.image_version]
    content {
      name   = "tag:ImageVersion"
      values = [filter.value]
    }
  }

  filter {
    name   = "state"
    values = ["available"]
  }
}

# ---------------------------------------------------------------------------
# Security Groups: uno por rol y por tenant
#   frontend :80   <- internet
#   backend  :3000 <- solo SG frontend de este tenant
#   database :5432 <- solo SG backend de este tenant
#   todos    :22 y métricas <- solo la IP del operador
# ---------------------------------------------------------------------------

resource "aws_security_group" "role" {
  #checkov:skip=CKV2_AWS_5:Falso positivo; cada SG se asigna a su EC2 en aws_instance.role (for_each)
  for_each = local.roles

  name        = "${local.name_prefix}-${each.key}"
  description = "Tenant ${var.tenant_slug}: ${each.key}"
  vpc_id      = data.aws_vpc.default.id

  tags = merge(local.tags, { Name = "${local.name_prefix}-${each.key}", Role = each.key })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "frontend_http" {
  # Excepción: es la puerta pública de la app. HTTPS requiere un dominio y un
  # certificado, que quedan fuera del alcance (Free Tier, sin dominio).
  #checkov:skip=CKV_AWS_260:El frontend es el sitio web publico del tenant
  security_group_id = aws_security_group.role["frontend"].id
  description       = "HTTP publico de la app"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
  tags              = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "backend_from_frontend" {
  security_group_id            = aws_security_group.role["backend"].id
  description                  = "API solo desde el frontend del tenant"
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = aws_security_group.role["frontend"].id
  tags                         = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "database_from_backend" {
  security_group_id            = aws_security_group.role["database"].id
  description                  = "PostgreSQL solo desde el backend del tenant"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.role["backend"].id
  tags                         = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "operator" {
  for_each = local.operator_rules

  security_group_id = aws_security_group.role[each.value.role].id
  description       = "Operador: ${each.value.name}"
  ip_protocol       = "tcp"
  from_port         = each.value.port
  to_port           = each.value.port
  cidr_ipv4         = each.value.cidr
  tags              = local.tags
}

# Salida: SOLO la cadena frontend -> backend -> database del mismo tenant.
# Corrección de trivy AWS-0104 (salida sin restricción). Las imágenes ya traen todo
# instalado, así que las EC2 no necesitan internet. Las respuestas a SSH, a
# Prometheus y a los visitantes salen igual, porque los Security Groups tienen
# estado. La hora se sincroniza con Amazon Time Sync (169.254.169.123), que es
# link-local y no pasa por los Security Groups. Sin reglas de salida, Terraform
# quita la regla "allow all" que AWS crea por defecto; la database no tiene ninguna.
resource "aws_vpc_security_group_egress_rule" "frontend_to_backend" {
  security_group_id            = aws_security_group.role["frontend"].id
  description                  = "Proxy de nginx hacia la API del tenant"
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = aws_security_group.role["backend"].id
  tags                         = local.tags
}

resource "aws_vpc_security_group_egress_rule" "backend_to_database" {
  security_group_id            = aws_security_group.role["backend"].id
  description                  = "API hacia PostgreSQL del tenant"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.role["database"].id
  tags                         = local.tags
}

# ---------------------------------------------------------------------------
# EC2: frontend, backend y database
# ---------------------------------------------------------------------------

resource "aws_instance" "role" {
  # Excepciones documentadas (docs/escaneres.md):
  #checkov:skip=CKV_AWS_88:Sin NAT Gateway (no es Free Tier) la IP publica es la via de SSH y del scraping; el SG solo admite la IP del operador
  #checkov:skip=CKV_AWS_126:El monitoreo detallado de CloudWatch tiene costo; las metricas las recoge Prometheus
  #checkov:skip=CKV_AWS_135:Los t3 son EBS-optimized por defecto y sin costo; el flag no cambia nada
  #checkov:skip=CKV2_AWS_41:Las EC2 no llaman a APIs de AWS; sin rol IAM es el minimo privilegio
  for_each = local.roles

  ami                         = data.aws_ami.role[each.key].id
  instance_type               = var.instance_types[each.key]
  subnet_id                   = data.aws_subnet.selected.id
  vpc_security_group_ids      = [aws_security_group.role[each.key].id]
  key_name                    = var.key_name
  associate_public_ip_address = true
  monitoring                  = false # el detallado de CloudWatch tiene costo; se usa Prometheus

  user_data = templatefile("${path.module}/../../../cloud-init/node.yaml.tftpl", {
    hostname    = substr("${var.tenant_slug}-${each.key}", 0, 63)
    timezone    = var.timezone
    project     = var.project
    tenant      = var.tenant_slug
    role        = each.key
    environment = var.environment
  })

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required" # IMDSv2
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.volume_sizes[each.key]
    encrypted             = true
    delete_on_termination = true
    tags                  = merge(local.tags, { Name = "${local.name_prefix}-${each.key}", Role = each.key })
  }

  tags = merge(local.tags, { Name = "${local.name_prefix}-${each.key}", Role = each.key })

  lifecycle {
    # Una AMI nueva o un cambio en cloud-init NO reemplaza las EC2 existentes
    # (la de database tiene los datos). Para actualizar se usa -replace a propósito.
    #
    # associate_public_ip_address: con la EC2 detenida, AWS le quita la IP pública
    # y el provider lee este atributo como false. Como cambiarlo obliga a recrear la
    # instancia, el siguiente apply (reanudar) reemplazaba backend y database y se
    # perdían los datos. El frontend no lo sufría porque su IP elástica sigue
    # asociada. Se ignora: el valor real lo fija la creación.
    ignore_changes = [ami, user_data, associate_public_ip_address]
  }
}

# IP elástica: la URL del tenant no cambia al suspender y reanudar
resource "aws_eip" "frontend" {
  domain = "vpc"
  tags   = merge(local.tags, { Name = "${local.name_prefix}-frontend" })
}

resource "aws_eip_association" "frontend" {
  allocation_id = aws_eip.frontend.id
  instance_id   = aws_instance.role["frontend"].id
}

# Suspender (stopped) o reanudar (running) sin borrar discos ni datos
resource "aws_ec2_instance_state" "role" {
  for_each = local.roles

  instance_id = aws_instance.role[each.key].id
  state       = var.desired_state

  depends_on = [aws_eip_association.frontend]
}
