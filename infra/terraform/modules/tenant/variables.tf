variable "project" {
  description = "Prefijo de nombres y valor del tag Project (debe coincidir con el de las AMIs)."
  type        = string
  default     = "asistencia"
}

variable "tenant_slug" {
  description = "Identificador del tenant: minúsculas, números y guiones."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$", var.tenant_slug))
    error_message = "tenant_slug debe tener entre 1 y 42 caracteres: minúsculas, números y guiones, sin guion al inicio ni al final."
  }
}

variable "environment" {
  description = "Entorno del tenant."
  type        = string
  default     = "production"

  validation {
    condition     = contains(["production", "staging"], var.environment)
    error_message = "environment debe ser production o staging."
  }
}

variable "instance_types" {
  description = "Tipo de EC2 por rol (lo define el plan del tenant)."
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
  description = "Disco raíz en GB por rol. Mínimo 8 (tamaño de las AMIs). El Free Tier incluye 30 GB de EBS en total."
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

  validation {
    condition     = alltrue([for size in values(var.volume_sizes) : size >= 8])
    error_message = "Cada disco debe tener al menos 8 GB."
  }
}

variable "image_version" {
  description = "Versión de las AMIs (tag ImageVersion). null = la más reciente de cada rol."
  type        = string
  default     = null
}

variable "key_name" {
  description = "Key pair SSH del operador (lo crea el bootstrap)."
  type        = string
  default     = "asistencia-operator"
}

variable "operator_cidrs" {
  description = "IPs (CIDR) que pueden entrar por SSH y leer las métricas: la PC donde corren Ansible y Prometheus."
  type        = list(string)

  validation {
    condition     = length(var.operator_cidrs) > 0 && alltrue([for cidr in var.operator_cidrs : can(cidrhost(cidr, 0)) && cidr != "0.0.0.0/0"])
    error_message = "operator_cidrs debe tener al menos un CIDR válido y no puede ser 0.0.0.0/0."
  }
}

variable "metrics_ports" {
  description = "Puertos de los agentes de monitoreo que lee Prometheus."
  type        = map(number)
  default = {
    node_exporter    = 9100
    process_exporter = 9256
    otelcol          = 8889
    netdata          = 19999
  }
}

variable "availability_zone" {
  description = "Zona donde se crean las 3 EC2. null = la primera zona que ofrece los tipos de instancia elegidos."
  type        = string
  default     = null
}

variable "desired_state" {
  description = "running o stopped. stopped suspende el tenant sin borrar sus discos."
  type        = string
  default     = "running"

  validation {
    condition     = contains(["running", "stopped"], var.desired_state)
    error_message = "desired_state debe ser running o stopped."
  }
}

variable "timezone" {
  description = "Zona horaria de las EC2."
  type        = string
  default     = "America/La_Paz"
}
