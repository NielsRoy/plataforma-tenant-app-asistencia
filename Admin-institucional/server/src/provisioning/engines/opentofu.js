// Motor OpenTofu: punto de extensión, todavía sin implementar.
// Para agregarlo hay que implementar los mismos métodos que engines/terraform.js
// y devolver el mismo contrato de outputs (app_url, frontend_public_ip,
// backend_private_ip, database_private_ip, public_ips, instance_ids, ami_ids...).
// Ansible, el monitoreo y la plataforma no cambian.
module.exports = {
  name: 'opentofu',
  label: 'OpenTofu',
  implemented: false,
};
