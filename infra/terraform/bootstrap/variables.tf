variable "region" {
  description = "Región AWS donde viven el estado y los tenants."
  type        = string
  default     = "us-east-1"
}

variable "project" {
  description = "Prefijo de nombres y valor de la etiqueta Project."
  type        = string
  default     = "asistencia"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,20}$", var.project))
    error_message = "project debe tener 3-21 caracteres: minúsculas, números o guiones."
  }
}

variable "ssh_public_key_path" {
  description = "Clave pública SSH del operador. Ansible la usa para entrar a las EC2 de los tenants."
  type        = string
  default     = "/root/.ssh/asistencia_ed25519.pub"
}

variable "noncurrent_state_retention_days" {
  description = "Días que se conservan las versiones antiguas del estado en S3."
  type        = number
  default     = 90
}
