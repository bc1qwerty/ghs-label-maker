// SQLite schema + prepared statements, extracted from index.js so tests can
// run against an in-memory database with the exact production statements.
import Database from "better-sqlite3";

export function createDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pubkey TEXT,
      ip TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS credits (
      pubkey TEXT PRIMARY KEY,
      amount INTEGER DEFAULT 0,
      plan TEXT DEFAULT 'free',
      plan_expires_at INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pubkey TEXT NOT NULL,
      payment_hash TEXT UNIQUE,
      amount_sats INTEGER,
      plan TEXT,
      status TEXT DEFAULT 'pending',
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pubkey TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'ghs',
      filename TEXT,
      data TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_usage_pubkey ON usage(pubkey);
    CREATE INDEX IF NOT EXISTS idx_usage_ip ON usage(ip);
    CREATE INDEX IF NOT EXISTS idx_history_pubkey ON history(pubkey);
  `);

  const stmts = {
    countByPubkey: db.prepare("SELECT COUNT(*) as cnt FROM usage WHERE pubkey = ?"),
    countByIp: db.prepare("SELECT COUNT(*) as cnt FROM usage WHERE ip = ? AND pubkey IS NULL"),
    recordUsage: db.prepare("INSERT INTO usage (pubkey, ip) VALUES (?, ?)"),
    getCredits: db.prepare("SELECT * FROM credits WHERE pubkey = ?"),
    upsertCredits: db.prepare(`
      INSERT INTO credits (pubkey, amount, plan, plan_expires_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(pubkey) DO UPDATE SET amount=?, plan=?, plan_expires_at=?
    `),
    deductCredit: db.prepare("UPDATE credits SET amount = amount - 1 WHERE pubkey = ? AND amount > 0"),
    // 원자적 예약: 잔액이 충분할 때만(amount >= n) 한 번에 차감한다. changes===1
    // 이어야 통과 — 동시 요청이 모두 checkUsage 를 지나쳐 1크레딧으로 N회
    // 추출하던 TOCTOU 를 닫는다(2026-08-31 감사). 무료 팩(plan='free')은 제외.
    reserveCredits: db.prepare("UPDATE credits SET amount = amount - ? WHERE pubkey = ? AND amount >= ? AND plan != 'free'"),
    // 추출 실패분(예약했으나 못 쓴 크레딧) 환급.
    refundCredits: db.prepare("UPDATE credits SET amount = amount + ? WHERE pubkey = ?"),
    createPayment: db.prepare("INSERT INTO payments (pubkey, payment_hash, amount_sats, plan) VALUES (?, ?, ?, ?)"),
    getPayment: db.prepare("SELECT * FROM payments WHERE payment_hash = ?"),
    // Conditional flip: only one caller can ever transition pending → paid.
    // Concurrent /api/payment/check polls used to double-credit via the old
    // unconditional UPDATE.
    completePayment: db.prepare("UPDATE payments SET status = 'paid' WHERE payment_hash = ? AND status = 'pending'"),
    saveHistory: db.prepare("INSERT INTO history (pubkey, mode, filename, data) VALUES (?, ?, ?, ?)"),
    getHistory: db.prepare("SELECT id, mode, filename, created_at FROM history WHERE pubkey = ? ORDER BY created_at DESC LIMIT 100"),
    getHistoryItem: db.prepare("SELECT * FROM history WHERE id = ? AND pubkey = ?"),
    deleteHistoryItem: db.prepare("DELETE FROM history WHERE id = ? AND pubkey = ?"),
    deleteOldHistory: db.prepare("DELETE FROM history WHERE created_at < unixepoch() - 86400 * 30"),
  };

  return { db, stmts };
}
