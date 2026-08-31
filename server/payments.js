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
      if (!plan) return { credits: currentAmount, plan: payment.plan };
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
