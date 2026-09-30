#!/usr/bin/env bash
# Chattering Anywhere relay on Ubuntu (design/85, anywhere/README.md).
#
# Makes a fresh Ubuntu server into the relay: the meeting point (relay.js
# behind Caddy, which gets its certificate), coturn for phones that cannot
# reach their computer directly, and everything around them kept small,
# patched and quiet. Safe to run again: each step checks before it acts.
#
#   sudo DOMAIN=encrypted-link-to-your-devices.rockfrog.ai bash setup-ubuntu.sh
#
# Options (environment):
#   DOMAIN        the relay's name (required)
#   PUBLIC_SSH    1 (default): SSH open to the internet, keys only.
#                 0: SSH only through Tailscale (after `tailscale up`).
#   TZ_NAME       time zone for the nightly reboot (America/Toronto)
#
# The relay's code is not installed here: deploy-relay.sh (run from a
# checkout) puts a pushed commit in /opt/chattering-anywhere/releases.
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN, e.g. DOMAIN=encrypted-link-to-your-devices.rockfrog.ai}"
PUBLIC_SSH="${PUBLIC_SSH:-1}"
TZ_NAME="${TZ_NAME:-America/Toronto}"
RELAY_PORT=8790
CADDY_FPR=65760C51EDEA2017CEA2CA15155B6D79CA56EA34      # Caddy's published signing key
TAILSCALE_FPR=2596A99EAAB33821893C0A79458CA832957F5868  # Tailscale's published signing key

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
. /etc/os-release
[ "$ID" = ubuntu ] || { echo "this script is for Ubuntu"; exit 1; }
CODENAME="$VERSION_CODENAME"
say() { printf '\n== %s\n' "$*"; }
write() { # write FILE MODE OWNER: stdin to FILE only if it changed; prints the name if so
  local f=$1 mode=$2 owner=$3 tmp; tmp=$(mktemp)
  cat > "$tmp"
  if [ -f "$f" ] && cmp -s "$tmp" "$f"; then rm -f "$tmp"; return 1; fi
  install -D -m "$mode" -o "${owner%:*}" -g "${owner#*:}" "$tmp" "$f"; rm -f "$tmp"; echo "  wrote $f"
}
export DEBIAN_FRONTEND=noninteractive
# Wait for the package manager when automatic updates hold it (a fresh
# server runs its first ones right after boot).
apt_get() { apt-get -o DPkg::Lock::Timeout=1200 "$@"; }

say "time zone ($TZ_NAME), for the nightly reboot"
timedatectl set-timezone "$TZ_NAME"

say "no logs on disk: the journal lives in memory, a day at most; no syslog files"
write /etc/systemd/journald.conf.d/10-volatile.conf 0644 root:root <<'EOF' && systemctl restart systemd-journald || true
[Journal]
Storage=volatile
RuntimeMaxUse=64M
MaxRetentionSec=1day
ForwardToSyslog=no
EOF
rm -rf /var/log/journal

say "remove what a relay does not need"
purge=()
for p in rsyslog snapd apport modemmanager udisks2 packagekit multipath-tools ufw popularity-contest ubuntu-report; do
  dpkg -s "$p" >/dev/null 2>&1 && purge+=("$p")
done
if [ ${#purge[@]} -gt 0 ]; then apt_get purge -y -qq "${purge[@]}"; apt_get autoremove -y -qq --purge; fi
rm -f /var/log/syslog* /var/log/auth.log* /var/log/kern.log* /var/log/ufw.log*

say "software sources: Caddy's and Tailscale's own, keys checked"
apt_get update -qq
apt_get install -y -qq curl gnupg ca-certificates >/dev/null
fetch_key() { # URL KEYRING FINGERPRINT [armored]
  local tmp; tmp=$(mktemp)
  curl -fsSL "$1" -o "$tmp"
  local fpr; fpr=$(gpg --show-keys --with-colons "$tmp" 2>/dev/null | awk -F: '/^fpr/{print $10; exit}')
  [ "$fpr" = "$3" ] || { echo "key at $1 has fingerprint $fpr, expected $3: stopping"; rm -f "$tmp"; exit 1; }
  if [ "${4:-}" = armored ]; then gpg --dearmor < "$tmp" > "$tmp.gpg"; mv "$tmp.gpg" "$tmp"; fi
  install -D -m 0644 "$tmp" "$2"; rm -f "$tmp"
}
[ -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg ] || fetch_key https://dl.cloudsmith.io/public/caddy/stable/gpg.key /usr/share/keyrings/caddy-stable-archive-keyring.gpg "$CADDY_FPR" armored
[ -f /usr/share/keyrings/tailscale-archive-keyring.gpg ] || fetch_key "https://pkgs.tailscale.com/stable/ubuntu/$CODENAME.noarmor.gpg" /usr/share/keyrings/tailscale-archive-keyring.gpg "$TAILSCALE_FPR"
write /etc/apt/sources.list.d/caddy-stable.list 0644 root:root <<'EOF' || true
deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main
EOF
write /etc/apt/sources.list.d/tailscale.list 0644 root:root <<EOF || true
deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/ubuntu $CODENAME main
EOF

say "install: caddy, coturn, node, tailscale, nftables, unattended-upgrades"
apt_get update -qq
apt_get install -y -qq caddy coturn nodejs tailscale nftables unattended-upgrades >/dev/null
node -e 'const [a] = process.versions.node.split(".").map(Number); if (a < 20) { console.error("node " + process.version + " is too old"); process.exit(1); }'

say "security updates every day, from every source; reboot at 04:00 when one needs it"
write /etc/apt/apt.conf.d/20auto-upgrades 0644 root:root <<'EOF' || true
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
write /etc/apt/apt.conf.d/52chattering-relay 0644 root:root <<'EOF' || true
// The relay's other sources: Caddy and Tailscale publish their own fixes.
Unattended-Upgrade::Origins-Pattern {
        "origin=cloudsmith/caddy/stable";
        "origin=Tailscale";
};
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

say "ssh: keys only, one user"
write /etc/ssh/sshd_config.d/00-keys-only.conf 0644 root:root <<'EOF' && { sshd -t && systemctl reload ssh; } || true
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers ubuntu
MaxAuthTries 3
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
EOF

say "the TURN secret (shared by the relay and coturn; never leaves this machine)"
install -d -m 0750 -o root -g turnserver /etc/chattering-anywhere
if [ ! -s /etc/chattering-anywhere/turn-secret ]; then
  (umask 027; openssl rand -hex 32 > /etc/chattering-anywhere/turn-secret)
fi
chown root:turnserver /etc/chattering-anywhere/turn-secret; chmod 0640 /etc/chattering-anywhere/turn-secret
SECRET=$(cat /etc/chattering-anywhere/turn-secret)

say "the relay's service (its code arrives with deploy-relay.sh)"
install -d -m 0755 -o root -g root /opt/chattering-anywhere /opt/chattering-anywhere/releases
write /etc/systemd/system/chattering-anywhere.service 0644 root:root <<EOF && systemctl daemon-reload || true
[Unit]
Description=Chattering Anywhere relay (the meeting point; keeps nothing)
After=network-online.target
Wants=network-online.target
ConditionPathExists=/opt/chattering-anywhere/current/anywhere/relay.js

[Service]
Environment=PORT=$RELAY_PORT HOST=127.0.0.1 TRUST_PROXY=1
Environment="TURN_URLS=turn:$DOMAIN:3478?transport=udp,turn:$DOMAIN:3478?transport=tcp,turns:$DOMAIN:5349?transport=tcp"
Environment=TURN_SECRET_FILE=%d/turn
LoadCredential=turn:/etc/chattering-anywhere/turn-secret
ExecStart=/usr/bin/node /opt/chattering-anywhere/current/anywhere/relay.js
Restart=always
RestartSec=2
# Its own throwaway user; nothing to write; no way out. It only answers
# Caddy on this machine: even taken over, it cannot call anywhere.
DynamicUser=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
IPAddressDeny=any
IPAddressAllow=localhost
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=pid
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
UMask=0077
MemoryMax=512M
TasksMax=64

[Install]
WantedBy=multi-user.target
EOF
systemctl enable chattering-anywhere >/dev/null 2>&1

say "Caddy: the certificate (Let's Encrypt only), https in front of the relay, no access log"
write /etc/caddy/Caddyfile 0644 root:root <<EOF && CADDY_CHANGED=1 || CADDY_CHANGED=0
{
	# No admin API: nothing on this machine can reconfigure Caddy.
	admin off
	# Certificates from Let's Encrypt only (the domain's CAA records say so too).
	acme_ca https://acme-v02.api.letsencrypt.org/directory
	# Caddy's own messages (certificates, start, stop) stay; the kinds that
	# carry a visitor's address do not: a request that failed, the proxy's
	# errors, and Go's TLS handshake errors ("from 1.2.3.4").
	log default {
		output stderr
		exclude http.log.error http.handlers.reverse_proxy http.stdlib
	}
}

$DOMAIN {
	encode zstd gzip
	header -Server
	# No "log" directive: Caddy writes no access log.
	reverse_proxy 127.0.0.1:$RELAY_PORT
}
EOF
# With the admin API off there is no reload: a change is a restart.
write /etc/systemd/system/caddy.service.d/10-relay.conf 0644 root:root <<'EOF' && systemctl daemon-reload || true
[Service]
ExecReload=
Restart=always
NoNewPrivileges=yes
ProtectHome=yes
PrivateTmp=yes
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null 2>&1
[ "$CADDY_CHANGED" = 1 ] && systemctl restart caddy || systemctl start caddy

say "coturn: TURN for phones with no direct path; never towards this machine or a private network; no logs"
# The server's public addresses: those on the default route's interface
# (never tailscale0's 100.x and fd7a: ones, also "global" to the kernel).
WAN=$(ip -o route show default | awk '{for (i=1;i<NF;i++) if ($i=="dev") print $(i+1); exit}')
PUB4=$(ip -4 -o addr show dev "$WAN" scope global | awk '{print $4}' | cut -d/ -f1 | head -1)
PUB6=$(ip -6 -o addr show dev "$WAN" scope global | awk '{print $4}' | cut -d/ -f1 | head -1)
install -d -m 0750 -o root -g turnserver /etc/coturn/tls
write /etc/turnserver.conf 0640 root:turnserver <<EOF || true
# Chattering Anywhere (written by setup-ubuntu.sh; edit there).
realm=$DOMAIN
server-name=$DOMAIN
# The public addresses only: not loopback, not the Tailscale ones.
${PUB4:+listening-ip=$PUB4}
${PUB6:+listening-ip=$PUB6}
${PUB4:+relay-ip=$PUB4}
${PUB6:+relay-ip=$PUB6}
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret
static-auth-secret=$SECRET
min-port=49152
max-port=65535
cert=/etc/coturn/tls/cert.pem
pkey=/etc/coturn/tls/key.pem
no-tlsv1
no-tlsv1_1
no-cli
no-multicast-peers
no-loopback-peers
# No logs: not to a file, not to the journal.
log-file=/dev/null
no-stdout-log
simple-log
# Relay only between phones and computers out on the internet: never to
# this machine (its own addresses, loopback) or any private network,
# including the Tailscale ranges.
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=224.0.0.0-255.255.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
${PUB4:+denied-peer-ip=$PUB4}
${PUB6:+denied-peer-ip=$PUB6}
# What one session and all of them may take.
max-bps=3000000
user-quota=12
total-quota=1200
stale-nonce=600
EOF
[ -f /etc/default/coturn ] && sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn

say "coturn gets Caddy's certificate whenever Caddy renews it"
write /usr/local/sbin/relay-cert-sync 0755 root:root <<EOF || true
#!/bin/sh
# Copy Caddy's certificate for $DOMAIN to coturn when it changed.
set -eu
src=/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$DOMAIN
[ -f "\$src/$DOMAIN.crt" ] || exit 0
if ! cmp -s "\$src/$DOMAIN.crt" /etc/coturn/tls/cert.pem 2>/dev/null; then
  install -m 0640 -o root -g turnserver "\$src/$DOMAIN.crt" /etc/coturn/tls/cert.pem
  install -m 0640 -o root -g turnserver "\$src/$DOMAIN.key" /etc/coturn/tls/key.pem
  systemctl restart coturn
fi
EOF
write /etc/systemd/system/relay-cert-sync.service 0644 root:root <<'EOF' || true
[Unit]
Description=Give coturn Caddy's certificate
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/relay-cert-sync
EOF
write /etc/systemd/system/relay-cert-sync.path 0644 root:root <<EOF || true
[Unit]
Description=Watch Caddy's certificate for $DOMAIN
[Path]
PathChanged=/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$DOMAIN/$DOMAIN.crt
[Install]
WantedBy=multi-user.target
EOF
write /etc/systemd/system/relay-cert-sync.timer 0644 root:root <<'EOF' || true
[Unit]
Description=Check Caddy's certificate for coturn, hourly (the watch needs the folder to exist)
[Timer]
OnBootSec=2min
OnUnitActiveSec=1h
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now relay-cert-sync.path relay-cert-sync.timer >/dev/null 2>&1
/usr/local/sbin/relay-cert-sync
systemctl enable coturn >/dev/null 2>&1
systemctl restart coturn

say "firewall: the relay's ports, SSH $( [ "$PUBLIC_SSH" = 1 ] && echo 'from anywhere (keys only)' || echo 'through Tailscale only')"
SSH_RULE='iifname "tailscale0" tcp dport 22 accept'
[ "$PUBLIC_SSH" = 1 ] && SSH_RULE='tcp dport 22 accept'
write /etc/nftables/relay.nft 0644 root:root <<EOF || true
# The relay's firewall (setup-ubuntu.sh). Its own table: Tailscale's
# rules live in theirs and are left alone.
table inet relay
delete table inet relay
table inet relay {
	chain input {
		type filter hook input priority filter; policy drop;
		ct state established,related accept
		ct state invalid drop
		iif lo accept
		meta l4proto icmp accept
		meta l4proto ipv6-icmp accept
		udp dport 68 accept comment "DHCP: this server's IPv4 address"
		$SSH_RULE
		tcp dport { 80, 443 } accept comment "Caddy: the page, the introductions"
		udp dport 443 accept comment "Caddy: HTTP/3"
		tcp dport { 3478, 5349 } accept comment "coturn"
		udp dport 3478 accept comment "coturn"
		udp dport 49152-65535 accept comment "coturn: relayed media"
		udp dport 41641 accept comment "Tailscale: direct connections"
	}
	chain forward {
		type filter hook forward priority filter; policy drop;
	}
}
EOF
write /etc/nftables.conf 0755 root:root <<'EOF' || true
#!/usr/sbin/nft -f
# No "flush ruleset": that would erase Tailscale's rules too.
include "/etc/nftables/relay.nft"
EOF
nft -c -f /etc/nftables.conf
systemctl enable nftables >/dev/null 2>&1
nft -f /etc/nftables.conf

say "done"
echo "  relay code:  $( [ -e /opt/chattering-anywhere/current ] && readlink -f /opt/chattering-anywhere/current || echo 'not deployed yet: run deploy-relay.sh from a checkout')"
echo "  certificate: $( [ -f /etc/coturn/tls/cert.pem ] && echo present || echo "waiting for DNS: $DOMAIN must point here")"
echo "  tailscale:   $(tailscale status --self --peers=false 2>/dev/null | head -1 || echo 'not signed in: tailscale up --advertise-tags=tag:relay --hostname=encrypted-link-relay --ssh=false --accept-dns=false')"
