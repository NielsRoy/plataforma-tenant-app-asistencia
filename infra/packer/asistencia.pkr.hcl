# Construye las 3 AMIs de los tenants (frontend, backend, database) sobre Ubuntu 24.04.
# Las 3 se construyen en paralelo desde la misma fuente; Ansible aplica el rol común
# (agentes de monitoreo) y el rol específico de cada imagen.
#
#   packer build infra/packer                                   -> las 3 imágenes
#   packer build "-only=asistencia.amazon-ebs.backend" infra/packer -> solo una (comillas en PowerShell)
#
# frontend y backend incluyen la app: Ansible clona desde GitHub solo su carpeta
# (admin-docente-alumno/client o /server), la compila y borra el código fuente.

packer {
  required_version = ">= 1.11.0"

  required_plugins {
    amazon = {
      source  = "github.com/hashicorp/amazon"
      version = ">= 1.3.0"
    }
    ansible = {
      source  = "github.com/hashicorp/ansible"
      version = ">= 1.1.0"
    }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "project" {
  type    = string
  default = "asistencia"
}

variable "image_version" {
  description = "Versión de las imágenes. Terraform usa la más reciente con este tag si se le indica."
  type        = string
  default     = "1.0.0"
}

variable "app_repo_url" {
  description = "Repositorio público de donde frontend y backend clonan la app."
  type        = string
  default     = "https://github.com/NielsRoy/plataforma-tenant-app-asistencia.git"
}

variable "app_repo_ref" {
  description = "Rama o tag de la app que se incluye en las imágenes."
  type        = string
  default     = "niels-terraform"
}

variable "instance_type" {
  description = "Instancia temporal de construcción (Free Tier)."
  type        = string
  default     = "t3.micro"
}

variable "volume_size" {
  description = "Tamaño del disco raíz en GB. Las EC2 pueden usar un disco mayor, nunca menor."
  type        = number
  default     = 8
}

locals {
  build_time = formatdate("YYYYMMDDhhmmss", timestamp())

  common_tags = {
    Project      = var.project
    ManagedBy    = "packer"
    ImageVersion = var.image_version
    BaseOS       = "ubuntu-24.04"
    BuildTime    = local.build_time
  }

  # Solo en frontend y backend, que llevan la app
  app_tags = {
    AppRepo = var.app_repo_url
    AppRef  = var.app_repo_ref
  }
}

source "amazon-ebs" "ubuntu" {
  region        = var.region
  instance_type = var.instance_type
  ssh_username  = "ubuntu"

  # Ubuntu 24.04 LTS oficial de Canonical (la más reciente)
  source_ami_filter {
    filters = {
      name                = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
    owners      = ["099720109477"]
    most_recent = true
  }

  # Instancia temporal en la VPC por defecto; el SG temporal solo admite SSH desde tu IP
  associate_public_ip_address               = true
  temporary_security_group_source_public_ip = true

  # IMDSv2 obligatorio en la imagen
  imds_support = "v2.0"
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  launch_block_device_mappings {
    device_name           = "/dev/sda1"
    volume_size           = var.volume_size
    volume_type           = "gp3"
    delete_on_termination = true
    encrypted             = true
  }

  run_tags = {
    Name      = "packer-build-${var.project}"
    Project   = var.project
    ManagedBy = "packer"
  }
}

build {
  name = "asistencia"

  source "source.amazon-ebs.ubuntu" {
    name          = "frontend"
    ami_name      = "${var.project}-frontend-${var.image_version}-${local.build_time}"
    tags          = merge(local.common_tags, local.app_tags, { Name = "${var.project}-frontend-${var.image_version}", Role = "frontend" })
    snapshot_tags = merge(local.common_tags, { Name = "${var.project}-frontend-${var.image_version}", Role = "frontend" })
  }

  source "source.amazon-ebs.ubuntu" {
    name          = "backend"
    ami_name      = "${var.project}-backend-${var.image_version}-${local.build_time}"
    tags          = merge(local.common_tags, local.app_tags, { Name = "${var.project}-backend-${var.image_version}", Role = "backend" })
    snapshot_tags = merge(local.common_tags, { Name = "${var.project}-backend-${var.image_version}", Role = "backend" })
  }

  source "source.amazon-ebs.ubuntu" {
    name          = "database"
    ami_name      = "${var.project}-database-${var.image_version}-${local.build_time}"
    tags          = merge(local.common_tags, { Name = "${var.project}-database-${var.image_version}", Role = "database" })
    snapshot_tags = merge(local.common_tags, { Name = "${var.project}-database-${var.image_version}", Role = "database" })
  }

  # Esperar a que cloud-init termine (usa apt en el primer arranque)
  provisioner "shell" {
    inline = ["cloud-init status --wait > /dev/null || true"]
  }

  provisioner "ansible" {
    playbook_file = "${path.root}/../ansible/playbooks/image.yml"
    user          = "ubuntu"
    use_proxy     = false
    extra_arguments = [
      "--extra-vars", "image_role=${source.name} image_version=${var.image_version} app_repo_url=${var.app_repo_url} app_repo_ref=${var.app_repo_ref}",
    ]
    ansible_env_vars = [
      "ANSIBLE_CONFIG=${path.root}/../ansible/ansible.cfg",
      "ANSIBLE_HOST_KEY_CHECKING=False",
    ]
  }

  # Limpieza: cada EC2 creada desde la AMI tendrá su propio machine-id, sus claves
  # de host y solo la clave SSH del key pair del tenant.
  provisioner "shell" {
    inline = [
      "sudo cloud-init clean --logs --machine-id",
      "sudo rm -f /home/ubuntu/.ssh/authorized_keys /root/.ssh/authorized_keys",
    ]
  }

  post-processor "manifest" {
    output     = "${path.root}/manifest.json"
    strip_path = true
    custom_data = {
      image_version = var.image_version
      app_repo_url  = var.app_repo_url
      app_repo_ref  = var.app_repo_ref
    }
  }
}
