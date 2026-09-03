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
      creditsToAdd = parseInt(payment.plan.split("-")[1], 10) || 1;
      // Purchased credits must never sit under plan='free' — recordUsage
      // only deducts non-free plans, so 'free' meant infinite credits when
      // a batch was bought after a plan-expiry reset.
      planName = existing && existing.plan !== "free" ? existing.plan : "payg";
    } else {
      const plan = plans[payment.plan];
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
 * Record usage rows and deduct credits for paid plans. Free-tier usage is
 * counted but never deducts.
 */
export function recordUsage(db, stmts, pubkey, ip, count) {
  const record = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      stmts.recordUsage.run(pubkey, ip);
    }
    if (pubkey) {
      const credits = stmts.getCredits.get(pubkey);
      if (credits && credits.amount > 0 && credits.plan !== "free") {
        for (let i = 0; i < count; i++) {
          stmts.deductCredit.run(pubkey);
        }
      }
    }
  });
  record();
}

/**
 * Atomically reserve `n` paid credits at admission — before the long async
 * extraction — so concurrent requests can't all pass checkUsage and consume
 * a single credit for N extractions (TOCTOU, 2026-08-31 감사). Returns true
 * only when the balance covered it (changes===1). Free packs are excluded.
 */
export function reserveCredits(db, stmts, pubkey, n) {
  return stmts.reserveCredits.run(n, pubkey, n).changes === 1;
}

/**
 * Settle a reserved paid request after extraction: record `success` usage rows
 * and refund the reserved-but-unused credits (reserved - success). Idempotent
 * per call; runs in one transaction.
 */
export function settlePaidUsage(db, stmts, pubkey, ip, reserved, success) {
  const settle = db.transaction(() => {
    for (let i = 0; i < success; i++) stmts.recordUsage.run(pubkey, ip);
    const refund = reserved - success;
    if (refund > 0) stmts.refundCredits.run(refund, pubkey);
  });
  settle();
}
