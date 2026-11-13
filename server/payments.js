// Payment plans, batch pricing, and credit settlement — extracted from
// index.js for unit testing. settlePayment is the only writer of paid
// status + credits and is transactional + idempotent.

// Count-based credit packs. No `days` field → credits never expire; you pay
// once for a number of extractions and keep them until used.
export const PLANS = {
  single:   { sats: 100,   credits: 1,    label: "1 extraction" },
  pack50:   { sats: 3000,  credits: 50,   label: "50 extractions" },
  pack200:  { sats: 9900,  credits: 200,  label: "200 extractions" },
  pack2400: { sats: 79000, credits: 2400, label: "2,400 extractions" },

  // Deprecated time-based keys, kept only so a Lightning invoice created
  // before the count-based migration still settles for in-flight payers.
  // No `days` → these also grant non-expiring credits now.
  weekly:  { sats: 3000,  credits: 50,   label: "50 extractions" },
  monthly: { sats: 9900,  credits: 200,  label: "200 extractions" },
  annual:  { sats: 79000, credits: 2400, label: "2,400 extractions" },
};

// Per-file pricing with volume discounts (tiers up to 30 files — the
// create-batch and price endpoints share this 1-30 range).
export const BATCH_MAX_FILES = 30;

export function calcBatchPrice(fileCount) {
  if (fileCount <= 0) return { perFile: 100, total: 0, discount: 0 };
  let perFile;
  if (fileCount >= 20) perFile = 50;       // 50% off
  else if (fileCount >= 10) perFile = 70;  // 30% off
  else if (fileCount >= 5) perFile = 85;   // 15% off
  else perFile = 100;
  return { perFile, total: perFile * fileCount, discount: Math.round((1 - perFile / 100) * 100) };
}

/** create-batch 의 fileCount 검증. 정수 1..BATCH_MAX_FILES 만 — `"1000000e-6"` 같은 문자열은 숫자 비교를
 *  통과하면서(Number 강제변환 = 1) plan 이름에는 그대로 실려, 100 sats 에 크레딧 1,000,000 이 붙었다. */
export function isValidBatchCount(n) {
  return Number.isInteger(n) && n >= 1 && n <= BATCH_MAX_FILES;
}

/** `batch-<n>` plan 의 크레딧 수. 형식이 어긋난 plan(검증 전에 만들어진 인보이스)은 낸 금액으로 되돌려
 *  계산한다 — 정가(100 sats/건) 기준이라 낸 것보다 많이 받을 수 없다. */
export function batchCredits(payment) {
  const m = /^batch-(\d{1,2})$/.exec(payment.plan);
  const n = m ? Number(m[1]) : 0;
  if (isValidBatchCount(n)) return n;
  const byAmount = Math.floor((Number(payment.amount_sats) || 0) / 100);
  console.error(`[GHS] settlePayment: 형식이 어긋난 batch plan '${payment.plan}' — 금액 기준 ${byAmount} 크레딧. hash=${payment.payment_hash}`);
  return Math.min(Math.max(byAmount, 0), BATCH_MAX_FILES);
}

/**
 * 통과시킨 요청의 사용량을 딱 한 번 정산한다. 핸들러는 추출이 끝나면 req._usageCount(성공 수)를 세팅한다.
 * - 정상 종료(finish): 그 값으로 정산(미설정이면 0 — 검증 실패·에러는 전액 환급).
 * - 클라이언트가 먼저 끊음(finish 없는 close): 추출은 계속 돌고 결과도 이력에 남는다. 그래서 여기서
 *   0 으로 정산하면 «올리고 끊기» 로 과금 없이 결과를 받는다. 핸들러가 _usageCount 를 세팅하는
 *   순간까지 기다렸다가 실제 성공 수로 정산한다. 끝내 세팅되지 않으면(핸들러 예외) graceMs 뒤 0 으로.
 */
export function trackUsage(req, res, settle, graceMs = 10 * 60 * 1000) {
  let settled = false;
  let waiting = false;
  let count;
  let timer = null;
  const doSettle = () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    settle(count || 0);
  };
  Object.defineProperty(req, "_usageCount", {
    configurable: true,
    get: () => count,
    set: (v) => { count = v; if (waiting) doSettle(); },
  });
  res.on("finish", doSettle);
  res.on("close", () => {
    if (settled) return;
    if (count !== undefined) return doSettle();
    waiting = true;
    timer = setTimeout(doSettle, graceMs);
    timer.unref?.();
  });
}

/**
 * Settle a confirmed payment: flip pending → paid and add credits, in one
 * transaction. Returns { credits, plan } on the first (winning) call and
 * null when the payment was already settled — concurrent /check polls for
 * the same hash can never double-credit.
 */
export function settlePayment(db, stmts, plans, payment) {
  const settle = db.transaction(() => {
    const flipped = stmts.completePayment.run(payment.payment_hash);
    if (flipped.changes !== 1) return null;

    const pubkey = payment.pubkey;
    const existing = stmts.getCredits.get(pubkey);
    const currentAmount = existing ? existing.amount : 0;

    let creditsToAdd, planName;
    if (payment.plan.startsWith("batch-")) {
      creditsToAdd = batchCredits(payment);
      // Purchased credits must never sit under plan='free' — reserveCredits
      // excludes free-plan rows, so credits parked there would be
      // unreservable (paid but unusable) after a plan-expiry reset.
      planName = existing && existing.plan !== "free" ? existing.plan : "payg";
    } else {
      const plan = Object.hasOwn(plans, payment.plan) ? plans[payment.plan] : null;
      if (!plan) {
        // ⚠ 여기 오면 **사용자는 돈을 냈는데 크레딧이 0**이다. completePayment 는
        // 위에서 이미 pending → paid 로 넘겼고, return 은 예외가 아니라서
        // 트랜잭션이 그대로 커밋된다 — 즉 손실이 조용히 굳는다.
        // 도달 경로는 하나뿐이다: 인보이스 생성 시점엔 PLANS 에 있던 키를
        // 나중에 배포로 지우고, 그 사이 만들어진 pending 인보이스가 결제되는 것.
        // (생성 시 `if (!PLANS[plan]) return 400` 검증이 있어 그 외에는 못 온다.)
        // 그래서 옛 time-based 키를 위에 남겨 뒀다. 지울 때는 pending 인보이스가
        // 없는지 먼저 확인할 것.
        console.error(
          `[GHS] settlePayment: 알 수 없는 plan '${payment.plan}' — 결제는 paid 로 ` +
          `기록됐으나 크레딧을 못 줬다. pubkey=${pubkey} hash=${payment.payment_hash}`,
        );
        return { credits: currentAmount, plan: payment.plan };
      }
      creditsToAdd = plan.credits;
      planName = payment.plan;
    }

    const newAmount = currentAmount + creditsToAdd;
    // plan_expires_at is written as 0 unconditionally: credits do not expire.
    // The column stays for schema compatibility with the deployed DB.
    stmts.upsertCredits.run(
      pubkey, newAmount, planName, 0,
      newAmount, planName, 0,
    );
    return { credits: newAmount, plan: payment.plan };
  });
  return settle();
}

/**
 * Record usage rows. Never deducts credits: paid usage is charged by
 * reserveCredits/settlePaidUsage at admission, and recordUsage is only
 * reached via the free/anonymous admission path — a leftover deduction
 * here double-charged a paid balance for free-tier usage (e.g. 1 credit
 * left, 2-file upload admitted free, then 1 paid credit silently gone).
 */
export function recordUsage(db, stmts, pubkey, ip, count) {
  const record = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      stmts.recordUsage.run(pubkey, ip);
    }
  });
  record();
}

/**
 * Settle paid-but-uncredited invoices for one pubkey. Settlement normally
 * happens inside GET /api/payment/check, which only the open payment modal
 * polls — close the tab after paying and the sats arrive but the credits
 * never do. Called on /api/user reads (every login) with `isPaid(hash)`
 * asking phoenixd; reuses settlePayment so it stays idempotent.
 */
// phoenixd 인보이스는 만료 시간을 주지 않으면 1시간짜리다(createinvoice 기본값). 여유를 두고
// 2시간이 지나서도 미결제로 확인된 인보이스는 앞으로도 결제될 수 없다.
const INVOICE_DEAD_AFTER_SEC = 2 * 3600;
const RECONCILE_CONCURRENCY = 5;

export async function reconcilePendingPayments(db, stmts, plans, pubkey, isPaid, nowSec = Math.floor(Date.now() / 1000)) {
  const pending = stmts.getPendingPayments.all(pubkey);
  // 예전엔 7일치 pending 을 조회 때마다 전부, 하나씩 phoenixd 에 물었다 — 인보이스를 쌓아 둔
  // 계정은 잔액 조회가 그만큼 느려졌다. 몇 개씩 나란히 묻고, 죽은 인보이스는 한 번 확인한 뒤 닫는다.
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const payment = pending[next++];
      try {
        if (await isPaid(payment.payment_hash)) settlePayment(db, stmts, plans, payment);
        else if (payment.status === "pending" && nowSec - payment.created_at > INVOICE_DEAD_AFTER_SEC) stmts.expirePayment.run(payment.payment_hash);
      } catch { /* phoenixd 불가 — 다음 조회에서 재시도 */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(RECONCILE_CONCURRENCY, pending.length) }, worker));
}

/**
 * Atomically reserve `n` paid credits at admission — before the long async
 * extraction — so concurrent requests can't all pass checkUsage and consume
 * a single credit for N extractions (TOCTOU, 2026-08-31 감사). Returns true
 * only when the balance covered it (changes===1). Free packs are excluded.
 */
export function reserveCredits(db, stmts, pubkey, n) {
  return reserve(db, stmts, pubkey, n) !== 0;
}

/** reserveCredits 와 같되 예약 행의 id 를 돌려준다(실패면 0). 정산은 이 id 로 한다 — settlePaidUsage 참고. */
export function reserve(db, stmts, pubkey, n) {
  return db.transaction(() => {
    if (stmts.reserveCredits.run(n, pubkey, n).changes !== 1) return 0;
    // 예약을 DB 에도 남긴다 — 정산 전에 프로세스가 죽으면(배포 재시작 포함) 기동 때 환급하기 위해서다.
    return Number(stmts.openReservation.run(pubkey, n).lastInsertRowid);
  })();
}

/**
 * 기동 때 한 번: 앞 프로세스가 정산하지 못한 예약을 전액 환급한다.
 * ⚠ «이 시점엔 처리 중인 요청이 없다» 는 전제는 프로세스가 하나일 때만 선다. 같은 DB 에 두 번째 프로세스가 뜨면
 *   (실수로 한 번 더 띄움·reload) 살아 있는 요청의 예약까지 환급한다 — 그래서 정산(settlePaidUsage)이 예약 행이
 *   아직 있는지를 보고, 이미 환급된 예약이면 환급하지 않고 성공분을 다시 받는다.
 */
export function refundStaleReservations(db, stmts) {
  return db.transaction(() => {
    const rows = stmts.listReservations.all();
    for (const r of rows) stmts.refundCredits.run(r.amount, r.pubkey);
    stmts.clearReservations.run();
    return rows.length;
  })();
}

/**
 * Settle a reserved paid request after extraction: record `success` usage rows
 * and refund the reserved-but-unused credits (reserved - success). Runs in one
 * transaction. ⚠ NOT idempotent: 같은 예약으로 두 번 부르면 두 번째는 «예약 행 없음» 분기로 가서 success 만큼을
 * 한 번 더 받는다. 호출부(index.js trackUsage)가 settled 플래그로 요청당 한 번만 부른다.
 */
export function settlePaidUsage(db, stmts, pubkey, ip, reserved, success, reservationId) {
  const settle = db.transaction(() => {
    for (let i = 0; i < success; i++) stmts.recordUsage.run(pubkey, ip);
    // 예약 행을 지운 쪽만 환급한다. 행이 없으면 다른 누군가(기동 환급)가 이미 전액 돌려준 것이므로,
    // 여기서 또 환급하면 두 번이다 — 대신 실제로 쓴 만큼(success)을 다시 받는다.
    const closed = reservationId
      ? stmts.closeReservationById.run(reservationId).changes === 1
      : stmts.closeReservation.run(pubkey, reserved).changes === 1;
    if (closed) {
      const refund = reserved - success;
      if (refund > 0) stmts.refundCredits.run(refund, pubkey);
    } else if (success > 0) {
      stmts.chargeCredits.run(success, pubkey);
    }
  });
  settle();
}
