# Mismas variables que el módulo; la plataforma las escribe en un .tfvars por tenant.

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "project" {
  type    = string
  default = "asistencia"
}

variable "tenant_slug" {
  type = string
}

variable "environment" {
  type    = string
  default = "production"
}

variable "instance_types" {
  type = object({
    frontend = string
    backend  = string
    database = string
  })
  default = {
    frontend = "t3.micro"
    backend  = "t3.micro"
    database = "t3.micro"
  }
}

variable "volume_sizes" {
  type = object({
    frontend = number
    backend  = number
    database = number
  })
  default = {
    frontend = 8
    backend  = 8
    database = 8
  }
}

variable "image_version" {
  type    = string
  default = null
}

variable "key_name" {
  type    = string
  default = "asistencia-operator"
}

variable "operator_cidrs" {
  type = list(string)
}

variable "availability_zone" {
  type    = string
  default = null
}

variable "desired_state" {
  type    = string
  default = "running"
}
