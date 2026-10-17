#!/usr/bin/env bash
# Invoked only inside the dedicated Natively-SearXNG distro, as root.
set -euo pipefail
if [ "${EUID}" -ne 0 ]; then echo 'Run this installer as root in Natively-SearXNG.' >&2; exit 1; fi
revision=2a6fc07be3760543c7b6d1d1bfe62f5765d5d9d6
install_dir=/opt/natively-searxng
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends python3-dev python3-venv git build-essential libxslt1-dev zlib1g-dev libffi-dev libssl-dev ca-certificates
id natively-search >/dev/null 2>&1 || useradd --system --home-dir "$install_dir" --shell /usr/sbin/nologin natively-search
install -d -o natively-search -g natively-search "$install_dir" "$install_dir/cache"
if [ ! -d "$install_dir/source/.git" ]; then
  runuser -u natively-search -- git init "$install_dir/source"
  runuser -u natively-search -- git -C "$install_dir/source" remote add origin https://github.com/searxng/searxng.git
fi
runuser -u natively-search -- git -C "$install_dir/source" fetch --depth 1 origin "$revision"
runuser -u natively-search -- git -C "$install_dir/source" checkout -B master "$revision"
runuser -u natively-search -- git -C "$install_dir/source" update-ref refs/remotes/origin/master "$revision"
runuser -u natively-search -- git -C "$install_dir/source" branch --set-upstream-to=origin/master master
test -x "$install_dir/venv/bin/python" || runuser -u natively-search -- python3 -m venv "$install_dir/venv"
runuser -u natively-search -- "$install_dir/venv/bin/pip" install 'pip==26.2' 'setuptools==82.0.1' wheel pyyaml msgspec typing-extensions pybind11 'waitress==3.0.2'
cd "$install_dir/source"
runuser -u natively-search -- "$install_dir/venv/bin/pip" install --use-pep517 --no-build-isolation -e .
install -m 640 -o root -g natively-search "$script_dir/config/settings.yml" "$install_dir/settings.yml"
cat > /etc/systemd/system/natively-searxng.service <<'UNIT'
[Unit]
Description=Natively SearXNG (without Docker)
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=natively-search
Group=natively-search
WorkingDirectory=/opt/natively-searxng/source
Environment=SEARXNG_SETTINGS_PATH=/opt/natively-searxng/settings.yml
Environment=XDG_CACHE_HOME=/opt/natively-searxng/cache
Environment=PYTHONDONTWRITEBYTECODE=1
ExecStart=/opt/natively-searxng/venv/bin/waitress-serve --listen=127.0.0.1:8889 --threads=4 searx.webapp:application
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/natively-searxng/cache
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable natively-searxng.service
systemctl restart natively-searxng.service
echo 'WSL SearXNG installed at http://127.0.0.1:8889'
