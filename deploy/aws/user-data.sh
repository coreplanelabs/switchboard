#!/bin/bash
# EC2 user-data for a Switchboard host (Amazon Linux 2023, arm64 or x86_64).
# Installs Docker + compose plugin and prepares /opt/switchboard.
# After boot: copy the repo (git clone or scp), add .env + config/config.yaml,
# then: cd /opt/switchboard && docker compose up -d
set -euxo pipefail

dnf update -y
dnf install -y docker git
systemctl enable --now docker

# docker compose v2 plugin
DOCKER_CONFIG=/usr/local/lib/docker
mkdir -p "$DOCKER_CONFIG/cli-plugins"
ARCH=$(uname -m) # aarch64 or x86_64
curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${ARCH}" \
  -o "$DOCKER_CONFIG/cli-plugins/docker-compose"
chmod +x "$DOCKER_CONFIG/cli-plugins/docker-compose"

usermod -aG docker ec2-user
mkdir -p /opt/switchboard
chown ec2-user:ec2-user /opt/switchboard
