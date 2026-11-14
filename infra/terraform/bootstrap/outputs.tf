output "account_id" {
  description = "Cuenta AWS donde se aplicó el bootstrap."
  value       = data.aws_caller_identity.current.account_id
}

output "region" {
  description = "Región de la infraestructura."
  value       = var.region
}

output "state_bucket" {
  description = "Bucket S3 con el estado de los tenants."
  value       = aws_s3_bucket.state.id
}

output "key_pair_name" {
  description = "Nombre del key pair que usan las EC2 de los tenants."
  value       = aws_key_pair.operator.key_name
}

output "default_vpc_id" {
  description = "VPC por defecto donde se despliegan los tenants."
  value       = data.aws_vpc.default.id
}

output "tenant_backend_config_path" {
  description = "Archivo de configuración del backend S3 para los stacks de tenant."
  value       = local_file.tenant_backend_config.filename
}
