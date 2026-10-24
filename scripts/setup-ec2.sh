#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run with sudo: sudo ./scripts/setup-ec2.sh"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg unzip zip jq docker.io docker-compose-v2

if ! command -v aws >/dev/null 2>&1; then
  echo "Installing AWS CLI v2 using official bundled installer..."
  tmpdir="$(mktemp -d)"
  arch="$(uname -m)"
  if [[ "$arch" == "x86_64" ]]; then
    cli_url="https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip"
  elif [[ "$arch" == "aarch64" || "$arch" == "arm64" ]]; then
    cli_url="https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip"
  else
    echo "Unsupported architecture for AWS CLI: $arch"
    exit 1
  fi
  curl -fsSL "$cli_url" -o "$tmpdir/awscliv2.zip"
  unzip -q "$tmpdir/awscliv2.zip" -d "$tmpdir"
  "$tmpdir/aws/install" --update
  rm -rf "$tmpdir"
else
  echo "AWS CLI already installed: $(aws --version)"
fi

systemctl enable docker
systemctl start docker
usermod -aG docker ubuntu || true

ARCH="$(uname -m)"
TMP_DEB="/tmp/amazon-cloudwatch-agent.deb"
if [[ "$ARCH" == "x86_64" ]]; then
  curl -fsSL -o "$TMP_DEB" "https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb"
elif [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]]; then
  curl -fsSL -o "$TMP_DEB" "https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/arm64/latest/amazon-cloudwatch-agent.deb"
else
  echo "Unsupported architecture for CloudWatch Agent: $ARCH"
  exit 1
fi

dpkg -i "$TMP_DEB" || apt-get install -f -y

echo "Setup complete. Log out and log back in so the ubuntu user can run Docker without sudo."
echo "Verify with: docker --version && docker compose version && aws --version"
