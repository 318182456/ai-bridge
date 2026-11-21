#!/bin/sh
# AI Bridge native release installer. No Docker or source compilation.
set -eu
umask 077
usage() { printf '%s\n' 'Usage: sh install.sh --version VERSION [--check]'; }
version=; check=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) [ "$#" -ge 2 ] || { usage; exit 2; }; version=$2; shift 2 ;;
    --check) check=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[ "$(uname -s)" = Linux ] || { echo 'Only Linux is supported.' >&2; exit 1; }
case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) echo 'Unsupported CPU architecture.' >&2; exit 1 ;; esac
[ -r /etc/os-release ] || { echo 'Cannot identify Linux distribution.' >&2; exit 1; }
. /etc/os-release
case "$ID" in debian|ubuntu) ;; *) echo 'Currently supports Debian/Ubuntu with systemd.' >&2; exit 1 ;; esac
command -v systemctl >/dev/null || { echo 'systemd is required.' >&2; exit 1; }
[ -d /run/systemd/system ] || { echo 'systemd is not running.' >&2; exit 1; }
if [ "$check" = true ]; then printf 'Supported platform: %s / %s\n' "$ID" "$arch"; exit 0; fi
[ "$(id -u)" = 0 ] || { echo 'Run installer as root.' >&2; exit 1; }
# Reject shell/path metacharacters before constructing release paths (ASVS 2.2.1).
printf '%s' "$version" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$' || { echo 'An explicit --version is required.' >&2; exit 2; }
repository=${AI_BRIDGE_REPOSITORY:-318182456/ai-bridge}
printf '%s' "$repository" | LC_ALL=C grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || exit 2
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl xz-utils openssl fontconfig fonts-noto-cjk fonts-noto-core fonts-liberation dbus gnome-keyring libsecret-tools libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcups2 libdrm2 libx11-6 libxext6 libxcb1 libgtk-3-0 libnss3 libdbus-glib-1-2 libxtst6 libxrandr2 libgbm1 libxkbcommon0 libpango-1.0-0 libcairo2 libxcomposite1 libxdamage1 libxfixes3 libx11-xcb1 xvfb
# libasound package name changed with Ubuntu 24.04's t64 transition.
if apt-cache show libasound2t64 >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libasound2t64
else
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libasound2
fi
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT HUP INT TERM
asset=ai-bridge-linux-$arch.tar.gz
base=https://github.com/$repository/releases/download/v$version
curl --fail --location --proto '=https' --proto-redir '=https' --retry 3 --connect-timeout 15 --max-time 600 "$base/$asset" -o "$work/$asset"
curl --fail --location --proto '=https' --proto-redir '=https' --retry 3 --connect-timeout 15 --max-time 120 "$base/SHA256SUMS" -o "$work/SHA256SUMS"
awk -v file="$asset" '$2 == file {print $0}' "$work/SHA256SUMS" > "$work/checksum"
[ "$(wc -l < "$work/checksum")" -eq 1 ] || { echo 'Missing or duplicate release checksum.' >&2; exit 1; }
(cd "$work" && sha256sum --check checksum)
mkdir "$work/unpacked"
# Downloaded release archives are trusted only after checksum verification; reject traversal.
tar -tzf "$work/$asset" > "$work/members"
if LC_ALL=C grep -Eq '(^/|(^|/)\.\.(/|$))' "$work/members"; then echo 'Unsafe release archive.' >&2; exit 1; fi
tar -xzf "$work/$asset" --no-same-owner --no-same-permissions -C "$work/unpacked"
release=$work/unpacked/ai-bridge
[ -f "$release/src/server.mjs" ] && [ -x "$release/bin/node" ] && [ -x "$release/bin/agy" ] || { echo 'Invalid release layout.' >&2; exit 1; }
"$release/bin/node" "$release/scripts/check-release.mjs"
getent passwd ai-bridge >/dev/null || useradd --system --user-group --home-dir /var/lib/ai-bridge --shell /usr/sbin/nologin ai-bridge
install -d -m 0755 /opt/ai-bridge /opt/ai-bridge/releases
install -d -m 0750 -o root -g ai-bridge /etc/ai-bridge
install -d -m 0700 -o ai-bridge -g ai-bridge /var/lib/ai-bridge
# Preserve the administrator's existing configuration and data during every upgrade.
if [ ! -f /etc/ai-bridge/ai-bridge.env ]; then
  { printf 'ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 32)"; printf 'API_KEY=%s\n' "$(openssl rand -hex 32)"; printf '%s\n' 'HOST=127.0.0.1' 'PORT=18861' 'MAX_CONCURRENCY=1' 'QUEUE_LIMIT=32' 'SESSION_LIMIT=1' 'SESSION_IDLE_SECONDS=120' 'TASK_TIMEOUT_SECONDS=180'; } > /etc/ai-bridge/ai-bridge.env
  chown root:ai-bridge /etc/ai-bridge/ai-bridge.env
  chmod 0640 /etc/ai-bridge/ai-bridge.env
fi
target=/opt/ai-bridge/releases/$version
[ ! -e "$target" ] || { echo 'Version is already installed; no files changed in that release.' >&2; exit 1; }
cp -a "$release" "$target"
chown -R root:root "$target"
chmod -R go-w "$target"
# Respect an existing port override without sourcing administrator configuration as shell.
port=$("$target/bin/node" -e 'const fs=require("node:fs");const s=fs.readFileSync("/etc/ai-bridge/ai-bridge.env","utf8");const m=s.match(/^PORT=(?:"([0-9]+)"|([0-9]+))\s*$/m);const p=Number(m?.[1]||m?.[2]||18861);if(!Number.isInteger(p)||p<1||p>65535)process.exit(1);process.stdout.write(String(p));')
old=$(readlink /opt/ai-bridge/current || true)
ln -s "$target" /opt/ai-bridge/current.new
mv -Tf /opt/ai-bridge/current.new /opt/ai-bridge/current
install -m 0644 "$target/deploy/ai-bridge.service" /etc/systemd/system/ai-bridge.service
systemctl daemon-reload
systemctl enable ai-bridge.service
systemctl restart ai-bridge.service
healthy=false
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if systemctl is-active --quiet ai-bridge.service && curl --fail --silent --max-time 2 "http://127.0.0.1:$port/health" >/dev/null; then healthy=true; break; fi
  sleep 1
done
if [ "$healthy" != true ]; then
  if [ -n "$old" ] && [ -d "$old" ]; then
    ln -s "$old" /opt/ai-bridge/current.rollback
    mv -Tf /opt/ai-bridge/current.rollback /opt/ai-bridge/current
    systemctl restart ai-bridge.service
    echo 'Health check failed; restored the previous application release.' >&2
  else
    systemctl stop ai-bridge.service
    echo 'Health check failed; service stopped. Inspect journalctl -u ai-bridge.' >&2
  fi
  exit 1
fi
printf '%s\n' 'AI Bridge installed. Configuration: /etc/ai-bridge/ai-bridge.env' 'Data preserved at /var/lib/ai-bridge. Listen defaults to loopback; use an HTTPS reverse proxy.'
