terraform {
  # use_lockfile (bloqueo nativo en S3, usado por los stacks de tenant) requiere >= 1.10
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }

  # El bootstrap crea el bucket del estado remoto, así que su propio estado
  # queda en local (terraform.tfstate, ignorado por git).
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = var.project
      Component = "bootstrap"
      ManagedBy = "terraform"
    }
  }
}
