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
    -- 추출이 끝나기 전에 잡아 둔 유료 크레딧. 정산되면 지운다 — 기동 때 남아 있는 행은
    -- 앞 프로세스가 정산하지 못하고 죽은 예약이라 환급한다(payments.js refundStaleReservations).
    CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pubkey TEXT NOT NULL,
      amount INTEGER NOT NULL,
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
    // 원자적 예약: 잔액이 충분할 때만(amount >= n) 한 번에 차감한다. changes===1
    // 이어야 통과 — 동시 요청이 모두 checkUsage 를 지나쳐 1크레딧으로 N회
    // 추출하던 TOCTOU 를 닫는다(2026-08-31 감사). 무료 팩(plan='free')은 제외.
    reserveCredits: db.prepare("UPDATE credits SET amount = amount - ? WHERE pubkey = ? AND amount >= ? AND plan != 'free'"),
    // 추출 실패분(예약했으나 못 쓴 크레딧) 환급.
    refundCredits: db.prepare("UPDATE credits SET amount = amount + ? WHERE pubkey = ?"),
    openReservation: db.prepare("INSERT INTO reservations (pubkey, amount) VALUES (?, ?)"),
    closeReservation: db.prepare("DELETE FROM reservations WHERE id = (SELECT id FROM reservations WHERE pubkey = ? AND amount = ? ORDER BY id LIMIT 1)"),
    closeReservationById: db.prepare("DELETE FROM reservations WHERE id = ?"),
    // 예약이 이미 환급된 뒤(기동 환급) 끝난 요청의 성공분을 다시 받는다. 잔액이 모자라면 0 까지만.
    chargeCredits: db.prepare("UPDATE credits SET amount = MAX(amount - ?, 0) WHERE pubkey = ?"),
    listReservations: db.prepare("SELECT id, pubkey, amount FROM reservations"),
    clearReservations: db.prepare("DELETE FROM reservations"),
    createPayment: db.prepare("INSERT INTO payments (pubkey, payment_hash, amount_sats, plan) VALUES (?, ?, ?, ?)"),
    getPayment: db.prepare("SELECT * FROM payments WHERE payment_hash = ?"),
    // 결제 후 모달이 닫혀 폴링이 죽은(paid-but-uncredited) 인보이스 재조정용.
    // 7일 창: 라이트닝 인보이스는 그 안에 만료되고, 전수 스캔을 피한다.
    // 닫은(expired) 인보이스도 만든 지 6시간 안이면 한 번씩 더 본다 — 닫은 뒤 결제가 확인되는 경우(닫는 판정이
    // 일렀거나 phoenixd 가 늦게 받아 준 경우)를 열린 결제창의 폴링 없이도 정산하기 위해서다. 그 뒤로는 묻지 않는다.
    getPendingPayments: db.prepare("SELECT * FROM payments WHERE pubkey = ? AND (status = 'pending' OR (status = 'expired' AND created_at > unixepoch() - 21600)) AND created_at > unixepoch() - 86400 * 7 ORDER BY created_at DESC LIMIT 50"),
    // Invoice expired and phoenixd confirmed it unpaid → it can never be paid; stop asking.
    expirePayment: db.prepare("UPDATE payments SET status = 'expired' WHERE payment_hash = ? AND status = 'pending'"),
    // Conditional flip: only one caller can ever transition pending → paid.
    // Concurrent /api/payment/check polls used to double-credit via the old
    // unconditional UPDATE. 'expired' 도 받는다 — 닫은 뒤에 결제가 확인되면(phoenixd 가 늦게 받아 줬거나
    // 닫는 판정이 일렀던 경우) 돈만 받고 크레딧을 안 주는 일이 없어야 한다. paid → paid 는 여전히 불가.
    completePayment: db.prepare("UPDATE payments SET status = 'paid' WHERE payment_hash = ? AND status IN ('pending', 'expired')"),
    saveHistory: db.prepare("INSERT INTO history (pubkey, mode, filename, data) VALUES (?, ?, ?, ?)"),
    getHistory: db.prepare("SELECT id, mode, filename, created_at FROM history WHERE pubkey = ? ORDER BY created_at DESC LIMIT 100"),
    getHistoryItem: db.prepare("SELECT * FROM history WHERE id = ? AND pubkey = ?"),
    deleteHistoryItem: db.prepare("DELETE FROM history WHERE id = ? AND pubkey = ?"),
    deleteOldHistory: db.prepare("DELETE FROM history WHERE created_at < unixepoch() - 86400 * 30"),
  };

  return { db, stmts };
}
