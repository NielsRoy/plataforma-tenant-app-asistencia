# Stack raíz de un tenant: 3 EC2 (frontend, backend, database) con sus Security
# Groups. Se aplica una vez por tenant, cada uno con su propio estado en S3.

module "tenant" {
  source = "../modules/tenant"

  project           = var.project
  tenant_slug       = var.tenant_slug
  environment       = var.environment
  instance_types    = var.instance_types
  volume_sizes      = var.volume_sizes
  image_version     = var.image_version
  key_name          = var.key_name
  operator_cidrs    = var.operator_cidrs
  availability_zone = var.availability_zone
  desired_state     = var.desired_state
}
