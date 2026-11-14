# Reexpone el contrato de outputs del módulo. `terraform output -json` es lo que
# leen la plataforma y el inventario de Ansible.

output "tenant_slug" {
  value = module.tenant.tenant_slug
}

output "environment" {
  value = module.tenant.environment
}

output "app_url" {
  value = module.tenant.app_url
}

output "frontend_public_ip" {
  value = module.tenant.frontend_public_ip
}

output "backend_private_ip" {
  value = module.tenant.backend_private_ip
}

output "database_private_ip" {
  value = module.tenant.database_private_ip
}

output "public_ips" {
  value = module.tenant.public_ips
}

output "private_ips" {
  value = module.tenant.private_ips
}

output "instance_ids" {
  value = module.tenant.instance_ids
}

output "ami_ids" {
  value = module.tenant.ami_ids
}

output "security_group_ids" {
  value = module.tenant.security_group_ids
}

output "availability_zone" {
  value = module.tenant.availability_zone
}

output "desired_state" {
  value = module.tenant.desired_state
}
