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
# shellcheck disable=SC2088  # 여기서는 확장되면 안 된다 — rsync 의 `호스트:경로` 와
#   `ssh "cd $DEST"` 는 **원격 셸이** 물결표를 푼다. 로컬에서 $HOME 으로 풀면
#   맥의 경로가 원격에 박혀 배포가 엉뚱한 데로 간다(2026-08-30 확인).
DEST="~/ghs-label-maker"

echo "==> Tests"
(cd "$SRC" && npm test)

echo "==> Building frontend"
(cd "$SRC" && npm run build)

echo "==> Syncing dist/"
rsync -az --delete -e ssh "$SRC/dist/" "$VPS:$DEST/dist/"

echo "==> Syncing server files (no .env, no DB)"
# ⚠서버 파일은 이름을 하나하나 적는다. 새 모듈을 만들면 여기에 추가하지 않는 한
# 배포에서 빠지고, VPS 는 import 실패로 부팅조차 못 한다.
rsync -az -e ssh \
  "$SRC/server/index.js" "$SRC/server/db.js" "$SRC/server/payments.js" "$SRC/server/llm.js" \
  "$VPS:$DEST/server/"
rsync -az -e ssh "$SRC/package.json" "$SRC/package-lock.json" "$VPS:$DEST/"

echo "==> Installing deps + restarting"
ssh "$VPS" "cd $DEST && npm install --omit=dev --no-audit --no-fund && pm2 restart ghs-label"

echo "==> Smoke"
sleep 3
curl -sf https://ghs.txid.uk/api/health | grep -q '"ok"' && echo "health OK"
curl -sf https://ghs.txid.uk/api/payment/price/5 | grep -q '"total":425' && echo "price OK"
# 추출이 로컬 MLX 로 도는지 확인한다. 터널이 끊겨 있으면 Claude 폴백으로 조용히
# 넘어가 응답은 정상이므로, 카운터를 보지 않으면 과금 중인 걸 알 수 없다.
if ssh "$VPS" 'curl -sf -m 5 http://127.0.0.1:8080/v1/models' >/dev/null 2>&1; then
  echo "local MLX reachable from VPS OK"
else
  echo "WARNING: VPS cannot reach the local MLX tunnel — extractions will fall back to Claude." >&2
  echo "         check launchd uk.txid.mlx-tunnel on the mac." >&2
fi
echo "Deployed."
