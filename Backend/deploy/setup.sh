#!/usr/bin/env bash
# Prepare a fresh Ubuntu server (Oracle Cloud Always Free, AWS EC2, Google Cloud e2-micro, any VPS) to run
# the Yuki backend: Node 24, the repository in /opt/yuki, a systemd unit per network and
# Caddy for HTTPS. Safe to run again (it also pulls the latest code).
#
#   sudo bash Backend/deploy/setup.sh <domain>          e.g. yuki-api.example.org
#
# On a server that already runs other sites, set YUKI_EDGE_PORT to a free port (and EDGE_PORT,
# PORT, FLEET_PORT in the env file to match). Caddy keeps every site it already serves: Yuki's
# is added as an import, never by replacing the Caddyfile.
#
# Then copy the env file(s) and the ledger over, and start the backend (see docs/DEPLOY.md).
set -euo pipefail

DOMAIN="${1:-}"
REPO="${YUKI_REPO:-https://github.com/Nouman-wp/NEAR-Protocol.git}"
DIR=/opt/yuki
EDGE_PORT="${YUKI_EDGE_PORT:-8790}"
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }

echo "── packages"
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git debian-keyring debian-archive-keyring apt-transport-https
if ! node -v 2>/dev/null | grep -q '^v24'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -q nodejs
fi
corepack enable
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

# a 1 GB machine needs swap to get through pnpm install
if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 2000000 ] && ! swapon --show | grep -q /swapfile; then
  echo "── 2 GB swap"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "── code in $DIR"
id yuki >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/yuki --shell /usr/sbin/nologin yuki
if [ -d "$DIR/.git" ]; then
  sudo -u yuki git -C "$DIR" pull --ff-only
else
  git clone "$REPO" "$DIR"
fi
mkdir -p "$DIR/.data"
chown -R yuki:yuki "$DIR"
sudo -u yuki -H bash -c "cd $DIR && corepack pnpm install --frozen-lockfile"
for f in "$DIR"/.env.testnet; do
  if [ -f "$f" ]; then
    chown yuki:yuki "$f"
    chmod 600 "$f"
  fi
done

echo "── systemd"
install -m 644 "$DIR/Backend/deploy/yuki@.service" /etc/systemd/system/yuki@.service
systemctl daemon-reload

echo "── firewall"
# Oracle's Ubuntu images reject everything but SSH in iptables; open HTTP(S) for Caddy
if command -v netfilter-persistent >/dev/null; then
  iptables -C INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT
  netfilter-persistent save
fi

if [ -n "$DOMAIN" ]; then
  echo "── Caddy for https://$DOMAIN -> 127.0.0.1:$EDGE_PORT"
  sed -e "s/YUKI_DOMAIN/$DOMAIN/" -e "s/127.0.0.1:8790/127.0.0.1:$EDGE_PORT/" "$DIR/Backend/deploy/Caddyfile" > /etc/caddy/yuki.caddy
  touch /etc/caddy/Caddyfile
  grep -qxF 'import /etc/caddy/yuki.caddy' /etc/caddy/Caddyfile || printf '
import /etc/caddy/yuki.caddy
' >> /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  systemctl reload caddy || systemctl restart caddy
fi

cat <<EOF

Done. Next:
  1. Copy your env file(s) here, from your PC (they never go through git):
       scp .env.testnet <user>@<server>:/tmp/  &&  ssh <user>@<server> 'sudo mv /tmp/.env.testnet $DIR/'
     then run this script again to lock their permissions.
  2. Bring the ledger: stop the backend on the PC and copy .data/quorum-testnet-*.sqlite*
     to $DIR/.data/ (or, with the Supabase mirror, run: sudo -u yuki node $DIR/Blockchain/scripts/db-restore.mjs testnet).
  3. Start it:      sudo systemctl enable --now yuki@testnet
     Logs:          journalctl -u yuki@testnet -f
  4. On your PC:    node Blockchain/scripts/publish-web.mjs testnet --backend https://${DOMAIN:-<domain>}
EOF
