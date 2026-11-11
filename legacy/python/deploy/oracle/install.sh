#!/usr/bin/env bash
set -euo pipefail
umask 077

# Run as the default ubuntu user on a new OCI Ubuntu 24.04 instance.
# This installs the service but leaves starting it until after token setup.
readonly BOT_DIR=/home/ubuntu/ArugoBot
readonly BOT_REPOSITORY=https://github.com/eggag32/ArugoBot.git
readonly BOT_REVISION=6848332333bef2384d28ca90bce229d913d84da6
DEPLOY_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly DEPLOY_DIR

fail() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

if [[ "$(uname -s)" != Linux || ! -r /etc/os-release ]]; then
    fail "Run this on the Oracle Ubuntu VM, not on your local computer."
fi

# shellcheck source=/dev/null
source /etc/os-release
if [[ "${ID:-}" != ubuntu || "${VERSION_ID:-}" != 24.04 ]]; then
    fail "This installer requires Ubuntu 24.04."
fi
if [[ "$(id -un)" != ubuntu ]]; then
    fail "Run as ubuntu: bash arugobot-oracle/install.sh (without sudo)."
fi
for companion in arugobot.service arugobot.logrotate; do
    [[ -r "$DEPLOY_DIR/$companion" ]] || fail "Missing $DEPLOY_DIR/$companion."
done
if systemctl is-active --quiet arugobot.service; then
    fail "ArugoBot is running. Stop it before reinstalling: sudo systemctl stop arugobot"
fi

sudo apt-get update
sudo apt-get install -y ca-certificates git python3.12 python3.12-venv sqlite3 logrotate

if [[ -e "$BOT_DIR" ]]; then
    [[ -d "$BOT_DIR/.git" ]] || fail "$BOT_DIR already exists and is not a Git checkout."
    [[ "$(git -C "$BOT_DIR" remote get-url origin)" == "$BOT_REPOSITORY" ]] ||
        fail "$BOT_DIR has a different origin; inspect it before continuing."
    [[ "$(git -C "$BOT_DIR" rev-parse HEAD)" == "$BOT_REVISION" ]] ||
        fail "$BOT_DIR is at a different revision; this installer will not overwrite it."
    git -C "$BOT_DIR" diff --quiet HEAD -- ||
        fail "$BOT_DIR has changes to tracked files; this installer will not overwrite them."
else
    git clone "$BOT_REPOSITORY" "$BOT_DIR"
    git -C "$BOT_DIR" checkout --detach "$BOT_REVISION"
fi

python3.12 -m venv "$BOT_DIR/.venv"
"$BOT_DIR/.venv/bin/python" -m pip install \
    --no-cache-dir --only-binary=:all: \
    -r "$BOT_DIR/requirements.txt"
"$BOT_DIR/.venv/bin/python" -m compileall -q \
    "$BOT_DIR/main.py" "$BOT_DIR/util.py" "$BOT_DIR/proxy.py" \
    "$BOT_DIR/exceptions.py" "$BOT_DIR/commands"

sudo install -o root -g root -m 0644 \
    "$DEPLOY_DIR/arugobot.service" /etc/systemd/system/arugobot.service
sudo install -o root -g root -m 0644 \
    "$DEPLOY_DIR/arugobot.logrotate" /etc/logrotate.d/arugobot
sudo systemd-analyze verify /etc/systemd/system/arugobot.service
sudo systemctl daemon-reload

cat <<'NEXT_STEPS'
ArugoBot and its service are installed.

Next, follow the token setup in /home/ubuntu/arugobot-oracle/README.md, then run:
  sudo systemctl enable --now arugobot
  sudo journalctl -u arugobot -n 80 --no-pager

The service has not been started by this installer.
NEXT_STEPS
