// SQLite schema + prepared statements, extracted from index.js so tests can
// run against an in-memory database with the exact production statements.
import Database from "better-sqlite3";
import { createHmac } from "node:crypto";

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
    // 익명 한도는 원본 IP 와 그 가명(ipTag) 둘 다로 센다 — 90일 지난 행은 가명만 남는다.
    countByIp: db.prepare("SELECT COUNT(*) as cnt FROM usage WHERE ip IN (?, ?) AND pubkey IS NULL"),
    oldAnonIps: db.prepare("SELECT DISTINCT ip FROM usage WHERE pubkey IS NULL AND ip IS NOT NULL AND ip NOT LIKE 'h:%' AND created_at < unixepoch() - 86400 * 90"),
    tagOldAnonIp: db.prepare("UPDATE usage SET ip = ? WHERE pubkey IS NULL AND ip = ? AND created_at < unixepoch() - 86400 * 90"),
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
    // 처리방침의 «IP 는 최대 90일». 로그인 사용량은 pubkey 로 세므로 IP 를 지워도 한도 계산이 그대로다.
    // 익명 행의 IP 는 평생 무료 3건의 키라 지우지 않고, 90일 뒤 서버 비밀값으로 만든 가명으로 바꾼다(pseudonymizeOldAnonIps).
    forgetOldUsageIps: db.prepare("UPDATE usage SET ip = NULL WHERE pubkey IS NOT NULL AND ip IS NOT NULL AND created_at < unixepoch() - 86400 * 90"),
    deleteOldHistory: db.prepare("DELETE FROM history WHERE created_at < unixepoch() - 86400 * 30"),
  };

  return { db, stmts };
}

// 익명 사용량의 IP 가명. 서버 비밀값으로 만든 HMAC 이라 DB 만으로는 원래 IP 를 되짚을 수 없다.
// 비밀값이 없으면(개발 환경) 원본을 그대로 돌려준다 — 한도 계산은 같고 가명화만 안 된다.
export function ipTag(secret, ip) {
  if (!secret || !ip) return ip;
  return "h:" + createHmac("sha256", secret).update(String(ip)).digest("hex").slice(0, 32);
}

// 90일 지난 익명 행의 원본 IP 를 가명으로 바꾼다. 평생 무료 한도는 countByIp 가 둘 다 세므로 그대로다.
export function pseudonymizeOldAnonIps(stmts, secret) {
  if (!secret) return 0;
  let n = 0;
  for (const { ip } of stmts.oldAnonIps.all()) n += stmts.tagOldAnonIp.run(ipTag(secret, ip), ip).changes;
  return n;
}
