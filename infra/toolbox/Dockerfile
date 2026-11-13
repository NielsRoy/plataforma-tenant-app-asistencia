# Toolbox IaC: todas las herramientas con versiones fijas.
# Se usa igual desde la terminal (scripts/iac.ps1) y desde la plataforma.
FROM python:3.13-slim-trixie

ARG TARGETARCH=amd64
ARG TERRAFORM_VERSION=1.16.6
ARG PACKER_VERSION=1.16.2
ARG TFLINT_VERSION=0.65.0
ARG TRIVY_VERSION=0.76.0
ARG ANSIBLE_CORE_VERSION=2.21.6
ARG CHECKOV_VERSION=3.4.5

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    ANSIBLE_HOST_KEY_CHECKING=False \
    ANSIBLE_FORCE_COLOR=False \
    TF_IN_AUTOMATION=1 \
    TF_PLUGIN_CACHE_DIR=/workspace/.workspaces/.terraform-plugin-cache \
    CHECKOV_RUN_SCA_PACKAGE_SCAN_V2=false

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip git jq openssh-client rsync netcat-openbsd \
 && rm -rf /var/lib/apt/lists/*

# Binarios de HashiCorp, tflint y trivy (descargas oficiales)
RUN set -eux; \
    cd /tmp; \
    curl -fsSLo tf.zip "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${TARGETARCH}.zip"; \
    unzip -o tf.zip terraform -d /usr/local/bin; \
    curl -fsSLo packer.zip "https://releases.hashicorp.com/packer/${PACKER_VERSION}/packer_${PACKER_VERSION}_linux_${TARGETARCH}.zip"; \
    unzip -o packer.zip packer -d /usr/local/bin; \
    curl -fsSLo tflint.zip "https://github.com/terraform-linters/tflint/releases/download/v${TFLINT_VERSION}/tflint_linux_${TARGETARCH}.zip"; \
    unzip -o tflint.zip tflint -d /usr/local/bin; \
    case "${TARGETARCH}" in amd64) TRIVY_ARCH=64bit ;; arm64) TRIVY_ARCH=ARM64 ;; esac; \
    curl -fsSLo trivy.tgz "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-${TRIVY_ARCH}.tar.gz"; \
    tar -xzf trivy.tgz -C /usr/local/bin trivy; \
    rm -f /tmp/*.zip /tmp/*.tgz; \
    terraform version; packer version; tflint --version; trivy --version

# Ansible y checkov en entornos virtuales separados (evita conflictos de dependencias)
RUN python -m venv /opt/ansible \
 && /opt/ansible/bin/pip install "ansible-core==${ANSIBLE_CORE_VERSION}" "psycopg2-binary>=2.9" \
 && python -m venv /opt/checkov \
 && /opt/checkov/bin/pip install "checkov==${CHECKOV_VERSION}" \
 && ln -s /opt/ansible/bin/ansible* /usr/local/bin/ \
 && ln -s /opt/checkov/bin/checkov /usr/local/bin/checkov

# Colecciones de Ansible usadas por los roles y playbooks
COPY requirements.yml /tmp/requirements.yml
RUN ansible-galaxy collection install -r /tmp/requirements.yml -p /usr/share/ansible/collections \
 && rm /tmp/requirements.yml

# Packer necesita sus plugins de AWS y de Ansible; se instalan en la imagen para no depender de la red en cada build
ENV PACKER_PLUGIN_PATH=/opt/packer-plugins
RUN mkdir -p "${PACKER_PLUGIN_PATH}" \
 && packer plugins install github.com/hashicorp/amazon \
 && packer plugins install github.com/hashicorp/ansible \
 && packer plugins installed

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY toolbox-versions.sh /usr/local/bin/toolbox-versions
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/toolbox-versions

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["toolbox-versions"]
