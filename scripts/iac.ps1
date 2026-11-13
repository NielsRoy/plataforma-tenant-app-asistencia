<#
.SYNOPSIS
  Ejecuta un comando dentro del toolbox IaC (terraform, packer, ansible, tflint, trivy, checkov).

.EXAMPLE
  ./scripts/iac.ps1 toolbox-versions
  ./scripts/iac.ps1 terraform -chdir=infra/terraform/bootstrap plan
  cd infra/terraform/bootstrap; ../../../scripts/iac.ps1 terraform init

.NOTES
  - Monta la raíz del repositorio en /workspace y conserva el directorio actual
    si estás dentro del repositorio.
  - Monta ~/.aws en solo lectura (credenciales del perfil local).
  - Monta la carpeta de claves SSH del proyecto (por defecto ~/.ssh/asistencia).
  - Pasa al contenedor AWS_PROFILE, AWS_REGION, AWS_DEFAULT_REGION y toda variable TF_VAR_* o PKR_VAR_*.
  - No declara parametros: usa $args para que opciones como -c o -chdir lleguen
    intactas al contenedor (PowerShell abreviaria -c como un parametro propio).
#>

$ErrorActionPreference = 'Stop'

$Command = @($args)
if ($Command.Count -eq 0) {
    Write-Error 'Uso: ./scripts/iac.ps1 <comando> [argumentos...]'
    exit 2
}

$image = if ($env:IAC_TOOLBOX_IMAGE) { $env:IAC_TOOLBOX_IMAGE } else { 'asistencia-iac-toolbox:1' }
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sshDir = if ($env:ASISTENCIA_SSH_DIR) { $env:ASISTENCIA_SSH_DIR } else { Join-Path $HOME '.ssh\asistencia' }
$awsDir = Join-Path $HOME '.aws'

# Directorio de trabajo dentro del contenedor
$current = (Get-Location).Path
$workdir = '/workspace'
if ($current.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    $relative = $current.Substring($repoRoot.Length).TrimStart('\', '/') -replace '\\', '/'
    if ($relative) { $workdir = "/workspace/$relative" }
}

$dockerArgs = @('run', '--rm', '-v', "${repoRoot}:/workspace", '-w', $workdir)

if (-not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected) {
    $dockerArgs += '-it'
}
if (Test-Path $awsDir) {
    $dockerArgs += @('-v', "${awsDir}:/root/.aws:ro")
}
if (Test-Path $sshDir) {
    $dockerArgs += @('-v', "${sshDir}:/mnt/ssh:ro")
}

foreach ($name in @('AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION')) {
    if (Test-Path "env:$name") { $dockerArgs += @('-e', $name) }
}
Get-ChildItem env: | Where-Object { $_.Name -like 'TF_VAR_*' -or $_.Name -like 'PKR_VAR_*' } | ForEach-Object {
    $dockerArgs += @('-e', $_.Name)
}

$dockerArgs += $image
$dockerArgs += $Command

& docker @dockerArgs
exit $LASTEXITCODE
