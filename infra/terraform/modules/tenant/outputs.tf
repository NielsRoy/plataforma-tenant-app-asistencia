# Contrato de outputs: cualquier motor (Terraform, y en el futuro Pulumi o
# CloudFormation) debe devolver estos mismos nombres. Ansible, Prometheus y la
# plataforma solo dependen de este contrato.

output "tenant_slug" {
  value = var.tenant_slug
}

output "environment" {
  value = var.environment
}

output "app_url" {
  description = "URL pública de la app del tenant."
  value       = "http://${aws_eip.frontend.public_ip}"
}

output "frontend_public_ip" {
  value = aws_eip.frontend.public_ip
}

output "backend_private_ip" {
  value = aws_instance.role["backend"].private_ip
}

output "database_private_ip" {
  value = aws_instance.role["database"].private_ip
}

output "public_ips" {
  description = "IP pública de cada EC2 (SSH de Ansible y scraping de Prometheus). Backend y database cambian al reanudar."
  value = {
    frontend = aws_eip.frontend.public_ip
    backend  = aws_instance.role["backend"].public_ip
    database = aws_instance.role["database"].public_ip
  }
}

output "private_ips" {
  value = { for role, instance in aws_instance.role : role => instance.private_ip }
}

output "instance_ids" {
  value = { for role, instance in aws_instance.role : role => instance.id }
}

output "ami_ids" {
  description = "AMI con la que se creó cada EC2 (registro de versiones, RF-13)."
  value       = { for role, instance in aws_instance.role : role => instance.ami }
}

output "security_group_ids" {
  value = { for role, sg in aws_security_group.role : role => sg.id }
}

output "availability_zone" {
  value = local.availability_zone
}

output "desired_state" {
  value = var.desired_state
}
