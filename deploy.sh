#!/usr/bin/env bash
# Deploy ghs.txid.uk to the VPS.
#
# The VPS copy (~/ghs-label-maker, pm2 "ghs-label") is NOT a git repo — this
# script is the only deploy path. Safety rules (learned the hard way on
# lib.txid.uk):
#   - NEVER sync .env or ghs.db* — the VPS holds canonical payments/credits
#   - pm2 restart only; never pm2 delete (and no --update-env): the process
#     env predates server-side .env loading. index.js now loadEnvFile()s the
#     VPS ~/ghs-label-maker/.env (exec cwd) on boot, so restarts and reboots are safe going forward.
set -euo pipefail

VPS="${VPS_HOST:-vps}"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="~/ghs-label-maker"

echo "==> Tests"
(cd "$SRC" && npm test)

echo "==> Building frontend"
(cd "$SRC" && npm run build)

echo "==> Syncing dist/"
rsync -az --delete -e ssh "$SRC/dist/" "$VPS:$DEST/dist/"

echo "==> Syncing server files (no .env, no DB)"
rsync -az -e ssh \
  "$SRC/server/index.js" "$SRC/server/db.js" "$SRC/server/payments.js" \
  "$VPS:$DEST/server/"
rsync -az -e ssh "$SRC/package.json" "$SRC/package-lock.json" "$VPS:$DEST/"

echo "==> Installing deps + restarting"
ssh "$VPS" "cd $DEST && npm install --omit=dev --no-audit --no-fund && pm2 restart ghs-label"

echo "==> Smoke"
sleep 3
curl -sf https://ghs.txid.uk/api/health | grep -q '"ok"' && echo "health OK"
curl -sf https://ghs.txid.uk/api/payment/price/5 | grep -q '"total":425' && echo "price OK"
echo "Deployed."
