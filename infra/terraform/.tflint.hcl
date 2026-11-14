# Configuración de tflint para todo infra/terraform.
# La usa scripts/scan-terraform.sh (y la plataforma antes de cada terraform apply).

config {
  # Revisa también el módulo local ../modules/tenant al analizar el stack
  call_module_type = "local"
}

# Reglas del lenguaje: variables sin tipo, sin usar, nombres, versiones de providers...
plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

# Reglas de AWS: tipos de instancia inválidos, AMIs, argumentos obsoletos...
plugin "aws" {
  enabled = true
  version = "0.50.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}
