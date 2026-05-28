const express = require('express');
const { readFileSync } = require('fs');
const { join } = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const JOIN_TOKEN = process.env.JOIN_TOKEN || null;
const CONDUIT_MON_USER = 'conduitmon';
const SSH_KEY_PATH = process.env.SSH_KEY_PATH || join(process.env.HOME || '/root', '.ssh/id_ed25519');

// GET /join/:token - Cross-distro version with Alpine support
app.get('/join/:token', (req, res) => {
  if (!JOIN_TOKEN || req.params.token !== JOIN_TOKEN) {
    return res.status(403).type('text/plain').send('echo "Invalid or expired join token"');
  }

  let sshPubKey = '';
  try {
    sshPubKey = readFileSync(SSH_KEY_PATH + '.pub', 'utf8').trim();
  } catch (e) {
    return res.status(500).type('text/plain').send('echo "Dashboard SSH key not found"');
  }

  const dashboardHost = req.headers.host?.split(':')[0] || req.hostname;
  const dashboardPort = PORT;
  const customSshPort = req.query.port ? parseInt(req.query.port, 10) : null;

  const script = `#!/bin/sh
set -e

MON_USER="${CONDUIT_MON_USER}"
DEPLOY_MODE=""
SSH_PORT="${customSshPort || ''}"

printf "\n╔═══════════════════════════════════════════════╗\n"
printf "║     Connecting to Conduit Dashboard           ║\n"
printf "╚═══════════════════════════════════════════════╝\n\n"

# Detect SSH port
if [ -z "\$SSH_PORT" ]; then
  SSH_PORT=\$(grep -E "^Port " /etc/ssh/sshd_config 2>/dev/null | awk '{print \$2}' | head -1)
  [ -z "\$SSH_PORT" ] && SSH_PORT=22
fi
echo "SSH port: \$SSH_PORT"

# Detect deployment mode
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  DEPLOY_MODE="docker"
  echo "Docker detected - using containerized deployment"
else
  DEPLOY_MODE="native"
  echo "Using native deployment"
fi
echo ""

# [1/5] Cross-distro: Install sudo + create monitoring user (Alpine + Debian support)
echo "[1/5] Installing sudo and creating monitoring user..."

# OS Detection
if [ -f /etc/alpine-release ] || command -v apk >/dev/null 2>&1; then
  OS="alpine"
  PKG_INSTALL="apk add --no-cache"
  USER_ADD="adduser -D -s /bin/sh"
  SUDO_GROUP="wheel"
  echo "  Alpine Linux detected"
else
  OS="debian"
  PKG_INSTALL="apt-get update -qq && apt-get install -y -qq"
  USER_ADD="useradd -m -s /bin/bash"
  SUDO_GROUP="sudo"
  echo "  Debian/Ubuntu detected"
fi

# Install sudo
if [ "\$OS" = "alpine" ]; then
  apk add --no-cache sudo >/dev/null 2>&1 || true
else
  apt-get update -qq && apt-get install -y -qq sudo >/dev/null 2>&1 || true
fi

# Create monitoring user if missing
if ! id "\$MON_USER" >/dev/null 2>&1; then
  \$USER_ADD "\$MON_USER"
fi

# Add to correct sudo group
if [ "\$OS" = "alpine" ]; then
  addgroup "\$MON_USER" wheel 2>/dev/null || true
else
  usermod -aG sudo "\$MON_USER" 2>/dev/null || true
fi

# SSH key setup
install -d -m 700 -o "\$MON_USER" -g "\$MON_USER" "/home/\$MON_USER/.ssh" 2>/dev/null || true
touch "/home/\$MON_USER/.ssh/authorized_keys" 2>/dev/null || true
chown "\$MON_USER:\$MON_USER" "/home/\$MON_USER/.ssh/authorized_keys" 2>/dev/null || true
chmod 600 "/home/\$MON_USER/.ssh/authorized_keys" 2>/dev/null || true

if grep -qF "${sshPubKey}" "/home/\$MON_USER/.ssh/authorized_keys" 2>/dev/null; then
  echo "  SSH key already present for \$MON_USER"
else
  echo "${sshPubKey}" >> "/home/\$MON_USER/.ssh/authorized_keys"
  sort -u "/home/\$MON_USER/.ssh/authorized_keys" -o "/home/\$MON_USER/.ssh/authorized_keys" 2>/dev/null || true
  chown "\$MON_USER:\$MON_USER" "/home/\$MON_USER/.ssh/authorized_keys" 2>/dev/null || true
  chmod 600 "/home/\$MON_USER/.ssh/authorized_keys" 2>/dev/null || true
  echo "  SSH key added for \$MON_USER"
fi

# [2/5] Configure limited sudo for monitoring commands
printf "[2/5] Configuring sudoers for \$MON_USER...\n"
mkdir -p /etc/sudoers.d 2>/dev/null || true
cat > "/etc/sudoers.d/conduit-dashboard" <<SUDOEOF
Defaults:\${MON_USER} !requiretty
\${MON_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl *, /bin/systemctl *, /usr/bin/journalctl *, /bin/journalctl *, /usr/bin/grep *, /bin/grep *, /usr/bin/timeout *, /usr/bin/tcpdump *, /usr/sbin/tcpdump *
SUDOEOF
chmod 440 /etc/sudoers.d/conduit-dashboard 2>/dev/null || true

# [3/5] Add monitoring user to docker group (cross-distro)
if [ "\$DEPLOY_MODE" = "docker" ]; then
  printf "[3/5] Adding \$MON_USER to docker group...\n"
  if [ "\$OS" = "alpine" ]; then
    addgroup "\$MON_USER" docker 2>/dev/null || true
  else
    usermod -aG docker "\$MON_USER" 2>/dev/null || true
  fi
else
  printf "[3/5] Skipping docker group (native mode)\n"
fi

# [4/5] Install/Start conduit relay
printf "[4/5] Setting up Conduit Relay (\$DEPLOY_MODE mode)...\n"

if [ "\$DEPLOY_MODE" = "docker" ]; then
  CONDUIT_DIR="/opt/conduit"
  mkdir -p "\$CONDUIT_DIR"
  cd "\$CONDUIT_DIR"

  EXISTING_CONTAINER=\$(docker ps --format "{{.Names}}" 2>/dev/null | grep -E "^conduit(-relay)?\$" | head -1)
  if [ -n "\$EXISTING_CONTAINER" ]; then
    echo "  Conduit container already running: \$EXISTING_CONTAINER"
  else
    curl -sLo docker-compose.yml "https://raw.githubusercontent.com/paradixe/conduit-relay/main/docker-compose.relay-only.yml"
    cat > .env <<ENVEOF
MAX_CLIENTS=200
BANDWIDTH=-1
ENVEOF
    docker compose pull
    docker compose up -d
    echo "  Conduit relay container started"
  fi
else
  if command -v conduit >/dev/null 2>&1 || [ -f /usr/local/bin/conduit ]; then
    echo "  Conduit already installed"
  else
    echo "  Installing Conduit Relay..."
    curl -sL "https://raw.githubusercontent.com/paradixe/conduit-relay/main/install.sh" | sh || true
  fi
fi

# [5/5] Register with dashboard
printf "[5/5] Registering with dashboard...\n"
HOSTNAME=\$(hostname | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | cut -c1-20)
[ -z "\$HOSTNAME" ] && HOSTNAME="server"
IP=\$(curl -4 -s --connect-timeout 5 ifconfig.me 2>/dev/null || curl -4 -s --connect-timeout 5 icanhazip.com 2>/dev/null || hostname -I | awk '{print \$1}')

RESULT=\$(curl -sX POST "http://${dashboardHost}:${dashboardPort}/api/register" \
  -H "Content-Type: application/json" \
  -H "X-Join-Token: ${JOIN_TOKEN}" \
  -d "{\"name\":\"\$HOSTNAME\",\"host\":\"\$IP\",\"user\":\"\$MON_USER\",\"sshPort\":\$SSH_PORT}" 2>/dev/null)

if echo "\$RESULT" | grep -q '"success":true'; then
  printf "\n════════════════════════════════════════════════\n"
  printf "  Connected to dashboard!\n"
  printf "  Name: \$HOSTNAME\n"
  printf "  IP:   \$IP\n"
  printf "  SSH:  \$SSH_PORT\n"
  printf "  User: \$MON_USER\n"
  printf "  Mode: \$DEPLOY_MODE\n"
  printf "════════════════════════════════════════════════\n\n"
else
  printf "Registration may have failed. Check dashboard logs.\n"
fi
`;

  res.type('text/plain').send(script);
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Conduit Dashboard running on port ${PORT}`);
  if (!JOIN_TOKEN) console.warn('WARNING: JOIN_TOKEN not set!');
});
