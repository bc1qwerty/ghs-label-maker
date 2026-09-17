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
SERVER_FILES=(index.js db.js payments.js llm.js client-ip.js)

# ⚠그 "추가하는 걸 잊는" 사고를 사람 기억에 맡기지 않는다(2026-09-07 신설).
# server/ 에 있는데 위 목록에 없는 .js 가 있으면 배포를 멈춘다. 목록에서 빠진
# 모듈은 조용히 안 올라가고, 그걸 import 하는 index.js 때문에 VPS 가 부팅에
# 실패한다 — 배포가 끝난 뒤에야 사이트가 죽은 걸로 알게 된다.
missing=()
# 런타임 모듈은 .js 만이 아니다 — .mjs/.cjs/런타임 .json 도 같은 지뢰라 함께
# 훑는다(안 맞는 글롭은 리터럴로 남으므로 -e 로 거른다).
for f in "$SRC"/server/*.js "$SRC"/server/*.mjs "$SRC"/server/*.cjs "$SRC"/server/*.json; do
  [ -e "$f" ] || continue
  base=$(basename "$f")
  found=0
  for listed in "${SERVER_FILES[@]}"; do [ "$base" = "$listed" ] && found=1 && break; done
  [ $found -eq 0 ] && missing+=("$base")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "✗ deploy.sh 의 SERVER_FILES 에 없는 서버 모듈: ${missing[*]}" >&2
  echo "  목록에 추가하지 않으면 VPS 가 import 실패로 뜨지 못한다." >&2
  exit 1
fi

rsync -az -e ssh \
  "${SERVER_FILES[@]/#/$SRC/server/}" \
  "$VPS:$DEST/server/"

# ⚠역방향 지뢰(2026-09-17 신설): 위 rsync 는 파일 나열이라 --delete 가 없다 —
# 리포에서 **지운** 모듈이 프로드에 영영 남는다. 실사고: b6f735e(9/14)가 지운
# 4파일(build.mjs·ghs.ts·health.ts·logger.ts)이 사흘간 프로드에 남아 있었고,
# disk-audit 의 코드 드리프트 검사도 git ls-files 기준이라 **원리적으로 못 본다**
# (리포에 없는 파일은 비교 목록에 안 들어간다). 배포가 삭제도 전파해야 한다.
# server/ 의 코드 확장자만 대상 — .env·ghs.db* 는 확장자가 달라 애초에 대상 밖이다.
echo "==> Pruning server files removed from the repo"
ssh "$VPS" "cd $DEST/server && for f in *.js *.mjs *.cjs *.ts; do [ -e \"\$f\" ] || continue; case \" ${SERVER_FILES[*]} \" in *\" \$f \"*) ;; *) rm -v \"\$f\";; esac; done"
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
