terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Backend parcial: bucket, región, cifrado y bloqueo vienen de backend.hcl (lo
  # genera el bootstrap); la key se pasa por tenant en el init:
  #   terraform init -backend-config=backend.hcl -backend-config=key=tenants/<slug>/terraform.tfstate
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = var.project
      Component = "tenant"
      ManagedBy = "terraform"
    }
  }
}
