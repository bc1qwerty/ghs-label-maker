import test from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../server/db.js";
import { PLANS, calcBatchPrice, settlePayment, reconcilePendingPayments, recordUsage, reserveCredits, settlePaidUsage } from "../server/payments.js";

// Payment/credit core paths against an in-memory DB with the exact
// production schema + statements. No network, no Lightning.

function freshDb() {
  return createDb(":memory:");
}

function seedPayment(stmts, { pubkey = "pk1", hash = "h1", sats = 100, plan = "single" } = {}) {
  stmts.createPayment.run(pubkey, hash, sats, plan);
  return stmts.getPayment.get(hash);
}

test("calcBatchPrice: volume tiers and totals", () => {
  assert.deepEqual(calcBatchPrice(1), { perFile: 100, total: 100, discount: 0 });
  assert.deepEqual(calcBatchPrice(4), { perFile: 100, total: 400, discount: 0 });
  assert.deepEqual(calcBatchPrice(5), { perFile: 85, total: 425, discount: 15 });
  assert.deepEqual(calcBatchPrice(10), { perFile: 70, total: 700, discount: 30 });
  assert.deepEqual(calcBatchPrice(20), { perFile: 50, total: 1000, discount: 50 });
  assert.deepEqual(calcBatchPrice(30), { perFile: 50, total: 1500, discount: 50 });
  assert.equal(calcBatchPrice(0).total, 0);
});

test("settlePayment: idempotent — second settle returns null, credits added once", () => {
  const { db, stmts } = freshDb();
  const payment = seedPayment(stmts, { plan: "single" });

  const first = settlePayment(db, stmts, PLANS, payment);
  assert.equal(first.credits, 1);
  const second = settlePayment(db, stmts, PLANS, payment);
  assert.equal(second, null);

  assert.equal(stmts.getCredits.get("pk1").amount, 1);
  assert.equal(stmts.getPayment.get("h1").status, "paid");
});

test("settlePayment: completePayment flips only pending rows (race guard at SQL level)", () => {
  const { db, stmts } = freshDb();
  seedPayment(stmts, { hash: "h2" });
  assert.equal(stmts.completePayment.run("h2").changes, 1);
  assert.equal(stmts.completePayment.run("h2").changes, 0);
});

test("settlePayment: count-based pack sets plan name and never expires", () => {
  const { db, stmts } = freshDb();
  const payment = seedPayment(stmts, { plan: "pack200", hash: "h3" });
  const r = settlePayment(db, stmts, PLANS, payment);
  assert.equal(r.credits, 200);
  const c = stmts.getCredits.get("pk1");
  assert.equal(c.plan, "pack200");
  assert.equal(c.plan_expires_at, 0, "count-based packs must not set an expiry");
});

test("settlePayment: batch bought on plan='free' row lands on 'payg' (no infinite credits)", () => {
  const { db, stmts } = freshDb();
  // Simulate post-expiry reset: plan='free', amount 0
  stmts.upsertCredits.run("pk1", 0, "free", 0, 0, "free", 0);
  const payment = seedPayment(stmts, { plan: "batch-5", hash: "h4", sats: 425 });

  const r = settlePayment(db, stmts, PLANS, payment);
  assert.equal(r.credits, 5);
  const c = stmts.getCredits.get("pk1");
  assert.equal(c.plan, "payg", "purchased credits must never sit under plan='free'");

  // And reserveCredits can now actually reserve them (plan != 'free')
  assert.equal(reserveCredits(db, stmts, "pk1", 2), true);
  assert.equal(stmts.getCredits.get("pk1").amount, 3);
});

test("settlePayment: batch on a paid plan keeps the plan and clears any legacy expiry", () => {
  const { db, stmts } = freshDb();
  // A row left over from the time-based era: still carries an expiry.
  const legacyExp = Math.floor(Date.now() / 1000) + 86400;
  stmts.upsertCredits.run("pk1", 10, "monthly", legacyExp, 10, "monthly", legacyExp);
  const payment = seedPayment(stmts, { plan: "batch-10", hash: "h5", sats: 700 });

  const r = settlePayment(db, stmts, PLANS, payment);
  assert.equal(r.credits, 20);
  const c = stmts.getCredits.get("pk1");
  assert.equal(c.plan, "monthly", "plan name is preserved");
  assert.equal(c.plan_expires_at, 0, "settlement must clear the legacy expiry, not carry it forward");
});

test("settlePayment: a legacy expiry already in the past never costs the buyer credits", () => {
  // The live regression this replaced: one account held 193 credits with an
  // expiry of 2026-05-10. Under the old middleware their next upload reset the
  // row to plan='free', amount=0. Settlement and usage must both leave it alone.
  const { db, stmts } = freshDb();
  const pastExp = Math.floor(Date.now() / 1000) - 86400 * 100;
  stmts.upsertCredits.run("pk1", 193, "monthly", pastExp, 193, "monthly", pastExp);

  assert.equal(reserveCredits(db, stmts, "pk1", 3), true);
  settlePaidUsage(db, stmts, "pk1", "1.2.3.4", 3, 3);
  assert.equal(stmts.getCredits.get("pk1").amount, 190, "usage deducts normally, no reset");

  const payment = seedPayment(stmts, { plan: "pack50", hash: "h6", sats: 3000 });
  const r = settlePayment(db, stmts, PLANS, payment);
  assert.equal(r.credits, 240, "top-up adds to the surviving balance");
  assert.equal(stmts.getCredits.get("pk1").plan_expires_at, 0);
});

test("recordUsage: free plan counts usage but never deducts", () => {
  const { db, stmts } = freshDb();
  stmts.upsertCredits.run("pk1", 3, "free", 0, 3, "free", 0);
  recordUsage(db, stmts, "pk1", "1.2.3.4", 2);
  assert.equal(stmts.getCredits.get("pk1").amount, 3);
  assert.equal(stmts.countByPubkey.get("pk1").cnt, 2);
});

test("recordUsage: 유료 plan 잔액이 있어도 무료 경로 정산은 차감하지 않는다", () => {
  // 회귀(2026-09-13 감사): single 팩(1크레딧) 보유 + 2파일 업로드 → 예약 실패
  // (1<2) → 무료 경로로 admit → recordUsage 가 결제한 크레딧을 무료 사용에
  // 차감했다. 유료 차감은 reserveCredits/settlePaidUsage 전담이다.
  const { db, stmts } = freshDb();
  stmts.upsertCredits.run("pk1", 1, "payg", 0, 1, "payg", 0);
  recordUsage(db, stmts, "pk1", "1.2.3.4", 2);
  assert.equal(stmts.getCredits.get("pk1").amount, 1, "무료 경로 사용이 유료 크레딧을 깎으면 안 된다");
  assert.equal(stmts.countByPubkey.get("pk1").cnt, 2);
});

// ─── TOCTOU 결제 예약(2026-08-31 감사) ───
function seedCredits(stmts, pubkey, amount, plan = "single") {
  stmts.upsertCredits.run(pubkey, amount, plan, 0, amount, plan, 0);
}

test("reserveCredits: 원자적 — 잔액이 n 이상일 때만 성공하며 그만큼 차감", () => {
  const { db, stmts } = freshDb();
  seedCredits(stmts, "pk1", 3, "single");
  assert.equal(reserveCredits(db, stmts, "pk1", 2), true);
  assert.equal(stmts.getCredits.get("pk1").amount, 1);
  assert.equal(reserveCredits(db, stmts, "pk1", 2), false); // 부족
  assert.equal(stmts.getCredits.get("pk1").amount, 1);       // 변화 없음
});

test("reserveCredits: race 종료 — 1크레딧에 예약 두 번, 하나만 성공", () => {
  const { db, stmts } = freshDb();
  seedCredits(stmts, "pk1", 1, "single");
  const a = reserveCredits(db, stmts, "pk1", 1);
  const b = reserveCredits(db, stmts, "pk1", 1);
  assert.equal([a, b].filter(Boolean).length, 1);
  assert.equal(stmts.getCredits.get("pk1").amount, 0);
});

test("reserveCredits: 무료 팩(plan=free)은 예약 대상 아님", () => {
  const { db, stmts } = freshDb();
  seedCredits(stmts, "pk1", 5, "free");
  assert.equal(reserveCredits(db, stmts, "pk1", 1), false);
  assert.equal(stmts.getCredits.get("pk1").amount, 5);
});

test("settlePaidUsage: 성공분 기록 + 미사용 예약분 환급", () => {
  const { db, stmts } = freshDb();
  seedCredits(stmts, "pk1", 5, "single");
  reserveCredits(db, stmts, "pk1", 3);               // 5 → 2
  settlePaidUsage(db, stmts, "pk1", "1.2.3.4", 3, 2); // 2건만 성공 → 1 환급
  assert.equal(stmts.getCredits.get("pk1").amount, 3);
  assert.equal(stmts.countByPubkey.get("pk1").cnt, 2);
});

test("settlePaidUsage: 전량 실패면 예약 전액 환급", () => {
  const { db, stmts } = freshDb();
  seedCredits(stmts, "pk1", 2, "single");
  reserveCredits(db, stmts, "pk1", 2);                // 2 → 0
  settlePaidUsage(db, stmts, "pk1", "1.2.3.4", 2, 0); // 전액 환급
  assert.equal(stmts.getCredits.get("pk1").amount, 2);
  assert.equal(stmts.countByPubkey.get("pk1").cnt, 0);
});

// PLANS 에서 키를 지운 뒤 그 키로 만들어진 pending 인보이스가 결제되면,
// completePayment 가 이미 paid 로 넘긴 뒤라 **돈만 받고 크레딧이 0**이 된다.
// 이 손실 자체는 막을 수 없지만(라이트닝은 이미 수신됐다) **조용하면 안 된다** —
// 로그가 없으면 사용자가 신고하기 전까지 아무도 모른다.
test("settlePayment: 모르는 plan 은 크레딧 0 이지만 조용히 지나가지 않는다", () => {
  const { db, stmts } = freshDb();
  const payment = seedPayment(stmts, { plan: "retired-plan" });

  const errs = [];
  const realError = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  let result;
  try {
    result = settlePayment(db, stmts, PLANS, payment);
  } finally {
    console.error = realError;
  }

  assert.equal(result.credits, 0, "모르는 plan 이라 크레딧은 늘지 않는다");
  assert.equal(stmts.getPayment.get("h1").status, "paid", "결제는 paid 로 굳는다(트랜잭션이 커밋된다)");
  assert.equal(errs.length, 1, "손실이 났으면 반드시 로그가 남아야 한다");
  assert.match(errs[0], /알 수 없는 plan 'retired-plan'/);
  assert.match(errs[0], /h1/, "어느 결제인지 hash 로 찾을 수 있어야 한다");
});

// 반대 방향: 아는 plan 은 로그를 남기지 않는다(정상 결제마다 에러가 찍히면
// 그 로그는 곧 무시된다).
test("settlePayment: 아는 plan 은 조용하다", () => {
  const { db, stmts } = freshDb();
  const payment = seedPayment(stmts, { plan: "pack50" });
  const errs = [];
  const realError = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  try {
    settlePayment(db, stmts, PLANS, payment);
  } finally {
    console.error = realError;
  }
  assert.deepEqual(errs, [], "정상 결제는 에러 로그를 남기지 않는다");
});

// ─── 결제-후-모달-닫힘 재조정(2026-09-13 감사) ───
// 정산이 열려 있는 모달의 /check 폴링에만 의존했다 — 결제 직후 탭을 닫으면
// sats 는 수취되고 크레딧은 영원히 안 붙었다. reconcilePendingPayments 가
// /api/user 조회(로그인마다) 시점에 pending 인보이스를 phoenixd 로 확인해 정산한다.

test("reconcilePendingPayments: paid-but-uncredited 인보이스를 정산한다", async () => {
  const { db, stmts } = freshDb();
  seedPayment(stmts, { plan: "pack50", hash: "h-orphan" });

  await reconcilePendingPayments(db, stmts, PLANS, "pk1", async () => true);

  assert.equal(stmts.getPayment.get("h-orphan").status, "paid");
  assert.equal(stmts.getCredits.get("pk1").amount, 50);

  // 멱등: 두 번 돌아도(예: /check 폴링과 경합) 이중 적립 없음
  await reconcilePendingPayments(db, stmts, PLANS, "pk1", async () => true);
  assert.equal(stmts.getCredits.get("pk1").amount, 50);
});

test("reconcilePendingPayments: 미결제·phoenixd 에러는 pending 을 건드리지 않는다", async () => {
  const { db, stmts } = freshDb();
  seedPayment(stmts, { plan: "pack50", hash: "h-unpaid" });

  await reconcilePendingPayments(db, stmts, PLANS, "pk1", async () => false);
  assert.equal(stmts.getPayment.get("h-unpaid").status, "pending");

  await reconcilePendingPayments(db, stmts, PLANS, "pk1", async () => { throw new Error("phoenixd down"); });
  assert.equal(stmts.getPayment.get("h-unpaid").status, "pending");
  assert.equal(stmts.getCredits.get("pk1"), undefined);
});

test("reconcilePendingPayments: 7일 지난 pending 은 조회 대상이 아니다", async () => {
  const { db, stmts } = freshDb();
  seedPayment(stmts, { plan: "pack50", hash: "h-old" });
  db.exec("UPDATE payments SET created_at = unixepoch() - 86400 * 8 WHERE payment_hash = 'h-old'");

  let asked = 0;
  await reconcilePendingPayments(db, stmts, PLANS, "pk1", async () => { asked++; return true; });
  assert.equal(asked, 0, "만료된 옛 인보이스로 phoenixd 를 두드리지 않는다");
  assert.equal(stmts.getPayment.get("h-old").status, "pending");
});
