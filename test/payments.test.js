import test from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../server/db.js";
import { PLANS, calcBatchPrice, settlePayment, recordUsage } from "../server/payments.js";

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

  // And recordUsage now actually deducts them
  recordUsage(db, stmts, "pk1", "1.2.3.4", 2);
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

  recordUsage(db, stmts, "pk1", "1.2.3.4", 3);
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

test("recordUsage: deduction never goes below zero", () => {
  const { db, stmts } = freshDb();
  stmts.upsertCredits.run("pk1", 1, "payg", 0, 1, "payg", 0);
  recordUsage(db, stmts, "pk1", "1.2.3.4", 3);
  assert.equal(stmts.getCredits.get("pk1").amount, 0);
});
