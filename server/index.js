import express from "express";
import cors from "cors";
import multer from "multer";
import { createRequire } from "module";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { createDb, countAnonByIp, loadIpSecret, pseudonymizeOldAnonIps } from "./db.js";
import { PLANS, isValidBatchCount, trackUsage, calcBatchPrice, settlePayment, reconcilePendingPayments, recordUsage as recordUsageImpl, reserve as reserveImpl, settlePaidUsage as settlePaidUsageImpl, refundStaleReservations } from "./payments.js";
import { complete, extractJson, llmStats } from "./llm.js";
import { getClientIp, crossOriginGuard } from "./client-ip.js";
import { isDangerWord, normalizeGhsData, pdfBytes, shapeDocument } from "./ghs-normalize.js";

// Load .env from the working directory (node 22+ builtin). The VPS pm2
// process used to depend on env vars captured at first `pm2 start` — a
// reboot + resurrect would have silently dropped ANTHROPIC_API_KEY and
// PHOENIXD_PASSWORD (payments + AI dead, /api/health still green).
try { process.loadEnvFile(); } catch { /* no .env in dev — fine */ }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// helmet 을 안 쓰는 유일한 Express 앱이라(형제 api·dash 는 helmet 이 지운다) 직접 끈다.
app.disable("x-powered-by");
const PORT = process.env.PORT || 3100;

// ─── Database ───
// GHS_DB_PATH 는 통합 테스트가 임시 DB 로 서버를 띄울 때만 쓴다.
const GHS_DB_PATH = process.env.GHS_DB_PATH || path.join(__dirname, "ghs.db");
const { db, stmts } = createDb(GHS_DB_PATH);
{
  const refunded = refundStaleReservations(db, stmts);
  if (refunded) console.log(`[GHS] 앞 프로세스가 정산하지 못한 예약 ${refunded}건을 환급했다`);
}

// stmts come from createDb (server/db.js).

// ─── Config ───
const FREE_LIMIT = 3;
const PHOENIXD_URL = process.env.PHOENIXD_URL || "http://127.0.0.1:9740";
const PHOENIXD_PASSWORD = process.env.PHOENIXD_PASSWORD || "";
// 익명 사용량의 IP 가명에 쓰는 비밀값(GHS_IP_SECRET, 없으면 DB 옆 .ghs-ip-secret 파일). 결제 비밀번호와 독립이다.
// 예전엔 PHOENIXD_PASSWORD 에서 파생했다 — 그때 가명화된 행이 있을 수 있어 옛 값도 대조에 넣는다.
const IP_SECRET = loadIpSecret(GHS_DB_PATH, process.env.GHS_IP_SECRET || "", { fs, path, randomBytes });
const IP_SECRETS = [IP_SECRET, PHOENIXD_PASSWORD ? `ghs-usage-ip:${PHOENIXD_PASSWORD}` : ""];

// PLANS / calcBatchPrice / settlePayment live in server/payments.js.

// ─── PDF parser ───
const _require = createRequire(import.meta.url);
const pdfParse = _require("pdf-parse");


// Concurrency limiter for AI calls
const MAX_CONCURRENT_AI = 3;
let activeAiCalls = 0;
const MAX_AI_QUEUE = 30;
const aiQueue = [];
function acquireAiSlot() {
  return new Promise((resolve) => {
    if (activeAiCalls < MAX_CONCURRENT_AI) { activeAiCalls++; resolve(); }
    else aiQueue.push(resolve);
  });
}
function releaseAiSlot() {
  activeAiCalls--;
  if (aiQueue.length > 0) { activeAiCalls++; aiQueue.shift()(); }
}

// ─── Middleware ───
// ⚠ 개발용 localhost 오리진을 프로덕션 허용목록에 두지 않는다(2026-09-07 수정).
//   credentials:true 와 함께이므로, 피해자 기기에서 도는 임의의 로컬 프로그램이
//   그 포트를 잡으면 세션을 실은 요청을 이 API 에 보낼 수 있다. api.txid.uk 가
//   같은 이유로 와일드카드 오리진을 걷어낸 전례가 있다(log.txid.uk 건).
//   ⚠ NODE_ENV 로 판정하지 않는다 — VPS pm2 프로세스에는 NODE_ENV 가 아예 없어서
//     "production 이 아니면 허용"이 곧 "언제나 허용"이 된다(pm2 describe 로 확인).
//     기본값을 안전한 쪽에 두고 로컬에서만 명시적으로 켠다(TRUST_CF_HEADER 와 같은 방식).
const DEV_ORIGINS = ["http://localhost:5173", "http://localhost:3100"];
const ALLOWED_ORIGINS = ["https://ghs.txid.uk"].concat(
  process.env.ALLOW_DEV_ORIGINS === "1" ? DEV_ORIGINS : [],
);
app.use(cors({
  origin: ALLOWED_ORIGINS,
  credentials: true,
}));
// 상태를 바꾸는 요청은 우리 화면에서 온 것만 받는다. 쿠키가 SameSite=Lax; Domain=.txid.uk 라 바깥 사이트는
// 막히지만, 같은 사이트인 다른 txid.uk 서브도메인의 multipart POST 는 preflight 없이 쿠키를 싣고 온다
// (→ 피해자 크레딧으로 추출). Origin 이 없는 요청(curl·서버 간 호출)은 브라우저 공격 경로가 아니라 통과.
app.use("/api", crossOriginGuard(ALLOWED_ORIGINS));
app.use(express.json());
// Vite 산출물 /assets/* 는 파일명에 콘텐츠 해시가 있어 내용이 바뀌면 이름도 바뀐다 —
// 1년 immutable 로 두면 재방문마다 에셋마다 재검증 왕복이 없다(CF 없이 Caddy 직결이라
// 기본값 max-age=0 이 그대로 브라우저에 닿았다, 2026-09-29 실측). index.html 과
// public/ 의 파일은 해시가 없으니 아래 기본값(재검증) 그대로 둔다.
app.use("/assets", express.static(path.join(__dirname, "../dist/assets"), { maxAge: "1y", immutable: true }));
app.use(express.static(path.join(__dirname, "../dist")));

// ─── Auth: verify via shared api.txid.uk session DB ───
const AUTH_DB_PATH = process.env.AUTH_DB_PATH || "/home/ubuntu/api.txid.uk/data/txid-auth.db";
let authDb;
try {
  authDb = new Database(AUTH_DB_PATH, { readonly: true, fileMustExist: true });
  console.log("[GHS] Connected to auth DB:", AUTH_DB_PATH);
} catch (e) {
  console.warn("[GHS] Auth DB not available:", e.message, "— auth will be disabled");
}
const authStmt = authDb ? authDb.prepare("SELECT u.pubkey FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > unixepoch()") : null;

// Session cache to avoid DB reads on every request
const sessionCache = new Map(); // token → { pubkey, expires }
setInterval(() => { const now = Date.now(); for (const [k,v] of sessionCache) { if (now > v.expires) sessionCache.delete(k); } }, 300_000);
function hourlyCleanup() {
  try { stmts.deleteOldHistory.run(); stmts.forgetOldUsageIps.run(); pseudonymizeOldAnonIps(stmts, IP_SECRET); } catch (e) { console.error("[GHS] History cleanup error:", e.message); }
}
setInterval(hourlyCleanup, 3600_000);
hourlyCleanup();

function readCookie(req, name) {
  const c = req.headers.cookie;
  if (!c) return null;
  const m = c.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  if (!m) return null;
  // 깨진 퍼센트 인코딩(`%E0%A4%A`)은 URIError 를 던진다 — 로그아웃으로 읽는다.
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

async function getUserPubkey(req) {
  // Prefer explicit header (legacy SPA path), fall back to shared .txid.uk cookie
  const token = req.headers["x-auth-token"] || readCookie(req, "txid_session");
  if (!token || !authStmt) return null;
  // Check cache
  const cached = sessionCache.get(token);
  if (cached && Date.now() < cached.expires) return cached.pubkey;
  // Check DB
  try {
    const row = authStmt.get(token);
    if (row) {
      sessionCache.set(token, { pubkey: row.pubkey, expires: Date.now() + 60_000 }); // cache 1 min
      return row.pubkey;
    }
  } catch (e) { console.error("[GHS] Auth DB query error:", e.message); }
  return null;
}


// ─── Auth & Usage check middleware ───
// 사용량 정산은 trackUsage(payments.js) 가 한 번만 한다 — 조기 끊김 처리는 거기 주석.
// 무료 한도는 추출이 끝나야 usage 에 적힌다. 그 사이의 동시 요청이 같은 잔여분을 보고 전부 통과하지
// 않게, 통과시킨 무료 건수를 정산 때까지 키(pubkey 또는 ip)별로 잡아 둔다.
const pendingFree = new Map();
// 통과시켜 아직 끝나지 않은 파일 수. aiQueue.length 는 pdf 파싱 뒤에야 늘어 동시 요청이 상한을 함께 지나간다.
let inflightFiles = 0;
// 실패한 추출은 과금도 무료 한도 차감도 없다 — 그것만으로 LLM 을 계속 부를 수 있어 IP 별로 시간당 묶는다.
const FAIL_LIMIT = 20;
const failures = new Map(); // ip → { windowStart, count }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of failures) if (now - v.windowStart > 3600_000) failures.delete(k);
}, 600_000).unref();
function failureCount(ip) {
  const f = failures.get(ip);
  return f && Date.now() - f.windowStart <= 3600_000 ? f.count : 0;
}
function noteFailures(ip, n) {
  if (n <= 0) return;
  const now = Date.now();
  let f = failures.get(ip);
  if (!f || now - f.windowStart > 3600_000) { f = { windowStart: now, count: 0 }; failures.set(ip, f); }
  f.count += n;
}

function admitUsage(req, res, next, ip, authInfo) {
  req.authInfo = authInfo;
  const fileCount = authInfo.fileCount || 0;
  // 무료로 잡아 둔 건수: 무료·익명은 전부, 유료는 묶음 앞쪽의 무료분(freePart)만.
  const freePart = authInfo.type === "paid" ? (authInfo.freePart || 0) : fileCount;
  const freeKey = freePart > 0 ? (authInfo.pubkey || `ip:${ip}`) : null;
  inflightFiles += fileCount;
  if (freeKey) pendingFree.set(freeKey, (pendingFree.get(freeKey) || 0) + freePart);
  trackUsage(req, res, (success) => {
    inflightFiles -= fileCount;
    if (freeKey) {
      const left = (pendingFree.get(freeKey) || 0) - freePart;
      if (left > 0) pendingFree.set(freeKey, left); else pendingFree.delete(freeKey);
    }
    noteFailures(ip, fileCount - success);
    if (authInfo.type === "paid") {
      // 성공분은 무료분부터 채운다 — 실패한 파일이 있어도 무료분을 먼저 쓴 것으로 치고 나머지만 과금한다.
      const freeUsed = Math.min(success, freePart);
      if (freeUsed > 0) recordUsageImpl(db, stmts, authInfo.pubkey, ip, freeUsed);
      settlePaidUsageImpl(db, stmts, authInfo.pubkey, ip, authInfo.reserved, success - freeUsed, authInfo.reservationId);
    } else {
      recordUsageImpl(db, stmts, authInfo.pubkey, ip, success);
    }
  });
  return next();
}

async function checkUsage(req, res, next) {
  const pubkey = await getUserPubkey(req);
  const ip = getClientIp(req);
  const fileCount = Array.isArray(req.files) ? req.files.length : (req.file ? 1 : 0);

  // AI 호출은 동시 3건이고 나머지는 줄을 선다. 줄에 상한이 없으면 무료 요청이 쌓여 유료 사용자의
  // 대기가 타임아웃(→ 폴백 과금)까지 늘어난다. 예약·사용량 기록 전에 돌려보낸다.
  if (inflightFiles + fileCount > MAX_AI_QUEUE + MAX_CONCURRENT_AI) {
    res.set("Retry-After", "60");
    return res.status(503).json({ error: "Server busy", message: "Too many extractions in progress. Please retry in a minute." });
  }
  if (failureCount(ip) >= FAIL_LIMIT) {
    res.set("Retry-After", "3600");
    return res.status(429).json({ error: "Too many failed extractions", message: "Too many failed extractions from this address. Try again in an hour." });
  }

  if (pubkey) {
    // 무료 체험(로그인)을 크레딧보다 먼저 쓴다 — 크레딧을 먼저 사면 유료 사용이 usage 를 채워 무료 3건이 사라졌다.
    // 카운트 기반이고 돈이 안 걸려 예약 없이 둔다.
    const { cnt } = stmts.countByPubkey.get(pubkey);
    const freeLeft = Math.max(0, FREE_LIMIT - cnt - (pendingFree.get(pubkey) || 0));
    if (fileCount <= freeLeft) {
      return admitUsage(req, res, next, ip, { pubkey, type: "free", remaining: freeLeft - fileCount, fileCount });
    }

    // 유료: 원자적으로 예약(amount >= n 일 때만 한 번에 차감). 동시
    // 요청이 모두 checkUsage 를 지나쳐 1크레딧으로 N회 추출하던 TOCTOU 를 닫는다
    // (2026-08-31 감사). 크레딧은 만료되지 않으므로 잔액 리셋은 하지 않는다.
    // 추출 실패분은 응답 정산에서 환급된다.
    // 무료분이 남은 묶음은 남은 무료분을 먼저 쓰고 나머지만 예약한다 — 통째로 유료 처리하면 무료분이 그대로 사라졌다.
    const paidPart = fileCount - freeLeft;
    const reservationId = fileCount > 0 ? reserveImpl(db, stmts, pubkey, paidPart) : 0;
    if (reservationId) {
      return admitUsage(req, res, next, ip, { pubkey, type: "paid", reserved: paidPart, freePart: freeLeft, reservationId, fileCount });
    }

    // 여기 왔다면 (남은 무료분 + 크레딧)이 요청한 파일 수보다 적다 — 아무것도 없을 때만 «소진» 이라고 한다.
    const balance = stmts.getCredits.get(pubkey);
    const credits = balance && balance.plan !== "free" ? balance.amount : 0;
    const have = [freeLeft > 0 ? `${freeLeft} free extraction(s)` : "", credits > 0 ? `${credits} credit(s)` : ""].filter(Boolean).join(" and ");
    return res.status(402).json({
      error: "Usage limit reached",
      message: have
        ? `You have ${have} left but uploaded ${fileCount} file(s). Upload fewer files or purchase ${credits > 0 ? "more " : ""}credits.`
        : "Free trial exhausted. Purchase credits to continue.",
      credits,
      freeRemaining: freeLeft,
      needsPayment: true,
      plans: PLANS,
    });
  }

  // Anonymous: check by IP
  const cnt = countAnonByIp(stmts, IP_SECRETS, ip);
  const anonLeft = Math.max(0, FREE_LIMIT - cnt - (pendingFree.get(`ip:${ip}`) || 0));
  if (fileCount <= anonLeft) {
    return admitUsage(req, res, next, ip, { pubkey: null, ip, type: "anonymous", remaining: anonLeft - fileCount, fileCount });
  }

  return res.status(402).json({
    error: "Usage limit reached",
    message: anonLeft > 0
      ? `You have ${anonLeft} free extraction(s) left but uploaded ${fileCount} file(s). Upload fewer files, or login and purchase credits.`
      : "Free trial exhausted. Login and purchase credits to continue.",
    needsPayment: true,
    needsLogin: true,
    plans: PLANS,
  });
}


// 업로드(multer, 최대 10×10MB 메모리)보다 먼저 선다: 무료 한도를 다 쓴 익명 IP 의 본문은 읽지 않는다.
async function anonQuotaGate(req, res, next) {
  if (await getUserPubkey(req)) return next();
  // 화면은 로그인 상태라고 믿는데(SDK) 서버 세션만 만료된 요청. 익명 무료분으로 조용히 처리하면
  // 본인 계정의 크레딧·기록과 무관하게 돌아간다 — 본문을 읽기 전에 다시 로그인하라고 돌려보낸다.
  if (req.get("x-ghs-expect-session") === "1") {
    return res.status(401).json({ error: "Session expired", message: "Your session expired. Please login again.", needsLogin: true });
  }
  const gateIp = getClientIp(req);
  const cnt = countAnonByIp(stmts, IP_SECRETS, gateIp);
  if (cnt < FREE_LIMIT) return next();
  return res.status(402).json({
    error: "Usage limit reached",
    message: "Free trial exhausted. Login and purchase credits to continue.",
    needsPayment: true,
    needsLogin: true,
    plans: PLANS,
  });
}

// ─── Rate Limiting (in-memory, per IP) ───
const rateLimitStore = new Map();

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now - entry.windowStart > 120_000) rateLimitStore.delete(key);
  }
  if (rateLimitStore.size > 50_000) rateLimitStore.clear();
}, 300_000);

function rateLimit(maxRequests, windowMs = 60_000) {
  return (req, res, next) => {
    const ip = getClientIp(req);
    const key = `${ip}:${maxRequests}`;
    const now = Date.now();

    let entry = rateLimitStore.get(key);
    if (!entry || now - entry.windowStart > windowMs) {
      entry = { windowStart: now, count: 0 };
      rateLimitStore.set(key, entry);
    }

    entry.count++;
    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: "Too many requests",
        message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
        retryAfter,
      });
    }

    next();
  };
}

const apiRateLimit = rateLimit(30);       // 30 req/min for API endpoints
const paymentRateLimit = rateLimit(10);   // 10 req/min for payment endpoints

// Apply rate limits to API routes
app.use("/api/ghs", apiRateLimit);
app.use("/api/transport", apiRateLimit);
app.use("/api/dgd", apiRateLimit);
app.use("/api/sds", apiRateLimit);
app.use("/api/un383", apiRateLimit);
app.use("/api/payment", (req, res, next) => {
  // The price lookup is pure arithmetic — no invoice, no phoenixd call, no DB —
  // but the prefix mount put it under the payment limiter, which exists to
  // throttle invoice creation. The UI refetches the price on every file-count
  // change, so a handful of adjustments burned that budget and the endpoint
  // started answering 429 in the middle of the payment flow.
  // /check/ 도 같은 카브아웃: 모달이 3초마다 폴링(20/min)해 10/min 버킷을
  // 넘겨 매 분 후반 ~30초는 429 — 결제 완료 표시가 그만큼 늦었다. check 는
  // 인보이스도 phoenixd 쓰기도 만들지 않는 조회다.
  if (req.path.startsWith("/price/") || req.path.startsWith("/check/")) return apiRateLimit(req, res, next);
  return paymentRateLimit(req, res, next);
});
app.use("/api/user", apiRateLimit);
app.use("/api/history", apiRateLimit);
app.use("/api/plans", apiRateLimit);

// ─── Lightning payments ───
function phoenixdAuth() {
  return "Basic " + Buffer.from(":" + PHOENIXD_PASSWORD).toString("base64");
}

// Batch price calculator
app.get("/api/payment/price/:count", (req, res) => {
  const count = /^\d{1,2}$/.test(req.params.count) ? Number(req.params.count) : 0;
  if (count <= 0 || count > 30) return res.status(400).json({ error: "Count must be 1-30" });
  res.json(calcBatchPrice(count));
});

// Create invoice for batch (per-file pricing)
// ⚠ body 의 pubkey 를 믿지 않는다: 존재만 보고 통과시키면 비로그인 클라이언트가
//   임의 pubkey 로 phoenixd 인보이스를 남발할 수 있다. 세션 검증(requireAuth)을
//   거쳐 req.verifiedPubkey 만 쓴다 — 다른 로그인 게이트 라우트와 동일.
app.post("/api/payment/create-batch", express.json(), requireAuth, async (req, res) => {
  const { fileCount } = req.body || {};
  const pubkey = req.verifiedPubkey;
  if (!isValidBatchCount(fileCount)) return res.status(400).json({ error: "File count must be 1-30" });
  if (!PHOENIXD_PASSWORD) return res.status(503).json({ error: "Payment not configured" });

  const price = calcBatchPrice(fileCount);

  try {
    const resp = await fetch(`${PHOENIXD_URL}/createinvoice`, {
      method: "POST",
      headers: { Authorization: phoenixdAuth(), "Content-Type": "application/x-www-form-urlencoded" },
      body: `amountSat=${price.total}&description=${encodeURIComponent(`GHS Label: ${fileCount} file${fileCount > 1 ? "s" : ""}${price.discount ? ` (${price.discount}% off)` : ""}`)}`,
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error("phoenixd error: " + resp.status);
    const data = await resp.json();

    stmts.createPayment.run(pubkey, data.paymentHash, price.total, `batch-${fileCount}`);

    res.json({
      paymentRequest: data.serialized,
      paymentHash: data.paymentHash,
      amount: price.total,
      fileCount,
      perFile: price.perFile,
      discount: price.discount,
    });
  } catch (err) {
    console.error("[GHS] Batch payment create error:", err.message);
    res.status(500).json({ error: "Failed to create invoice" });
  }
});

// Create invoice (plan-based)
app.post("/api/payment/create", express.json(), requireAuth, async (req, res) => {
  const { plan } = req.body || {};
  const pubkey = req.verifiedPubkey;
  if (typeof plan !== "string" || !Object.hasOwn(PLANS, plan)) return res.status(400).json({ error: "Invalid plan" });
  if (!PHOENIXD_PASSWORD) return res.status(503).json({ error: "Payment not configured" });

  const { sats, label } = PLANS[plan];

  try {
    const resp = await fetch(`${PHOENIXD_URL}/createinvoice`, {
      method: "POST",
      headers: {
        Authorization: phoenixdAuth(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `amountSat=${sats}&description=${encodeURIComponent(`GHS Label: ${label}`)}`,
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) throw new Error("phoenixd error: " + resp.status);
    const data = await resp.json();

    stmts.createPayment.run(pubkey, data.paymentHash, sats, plan);

    res.json({
      paymentRequest: data.serialized,
      paymentHash: data.paymentHash,
      amount: sats,
      plan,
    });
  } catch (err) {
    console.error("[GHS] Payment create error:", err.message);
    res.status(500).json({ error: "Failed to create invoice" });
  }
});

async function phoenixdIsPaid(hash) {
  const resp = await fetch(`${PHOENIXD_URL}/payments/incoming/${hash}`, {
    headers: { Authorization: phoenixdAuth() },
    signal: AbortSignal.timeout(10000),
  });
  // 오류 응답을 «미결제» 로 읽지 않는다 — reconcile 이 만료 지난 인보이스를 미결제로 확인하면 닫기 때문이다.
  if (!resp.ok) throw new Error("phoenixd error: " + resp.status);
  const data = await resp.json();
  return !!data.isPaid;
}

// Check payment status
app.get("/api/payment/check/:hash", async (req, res) => {
  const { hash } = req.params;
  const payment = stmts.getPayment.get(hash);
  if (!payment) return res.status(404).json({ error: "Payment not found" });
  if (payment.status === "paid") return res.json({ paid: true });

  if (!PHOENIXD_PASSWORD) return res.json({ paid: false });

  try {
    if (await phoenixdIsPaid(hash)) {
      // Transactional + idempotent (server/payments.js): only the first
      // poll settles; concurrent polls for the same hash get paid:true
      // without double-crediting.
      const result = settlePayment(db, stmts, PLANS, payment);
      if (!result) return res.json({ paid: true });
      return res.json({ paid: true, credits: result.credits, plan: payment.plan });
    }

    res.json({ paid: false });
  } catch (err) {
    console.error("[GHS] Payment check error:", err.message);
    res.json({ paid: false });
  }
});

// Auth guard middleware for protected endpoints
async function requireAuth(req, res, next) {
  const pubkey = await getUserPubkey(req);
  if (!pubkey) return res.status(401).json({ error: "Authentication required" });
  req.verifiedPubkey = pubkey;
  next();
}

// User info (credits, usage)
app.get("/api/user/:pubkey", requireAuth, async (req, res) => {
  const { pubkey } = req.params;
  if (pubkey !== req.verifiedPubkey) return res.status(403).json({ error: "Forbidden" });
  // 결제 후 모달을 닫아 /check 폴링이 죽은 인보이스(돈은 왔는데 크레딧이 안
  // 붙은 상태)를 로그인·잔액 조회 시점에 정산한다. settlePayment 가 멱등이라
  // /check 폴링과 경합해도 이중 적립은 없다.
  if (PHOENIXD_PASSWORD) await reconcilePendingPayments(db, stmts, PLANS, pubkey, phoenixdIsPaid);
  const credits = stmts.getCredits.get(pubkey);
  const { cnt } = stmts.countByPubkey.get(pubkey);

  res.json({
    pubkey,
    totalUsed: cnt,
    credits: credits?.amount || 0,
    plan: credits?.plan || "free",
    planExpiresAt: credits?.plan_expires_at || 0,
    freeRemaining: Math.max(0, FREE_LIMIT - cnt),
  });
});

// ─── GHS constants ───
const GHS_PICTOGRAM_CODES = ["GHS01","GHS02","GHS03","GHS04","GHS05","GHS06","GHS07","GHS08","GHS09"];
const GHS_PICTOGRAM_NAMES_KO = { GHS01:"폭발성",GHS02:"인화성",GHS03:"산화성",GHS04:"고압가스",GHS05:"부식성",GHS06:"급성독성",GHS07:"유해성",GHS08:"건강유해성",GHS09:"환경유해성" };
const GHS_PICTOGRAM_NAMES_EN = { GHS01:"Explosive",GHS02:"Flammable",GHS03:"Oxidizer",GHS04:"Compressed Gas",GHS05:"Corrosive",GHS06:"Acute Toxicity",GHS07:"Harmful",GHS08:"Health Hazard",GHS09:"Environmental Hazard" };

function normalizePictogramCode(raw) {
  const upper = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^GHS\d{2}$/.test(upper)) return upper;
  const shortM = upper.match(/^GHS(\d)$/);
  if (shortM) return `GHS0${shortM[1]}`;
  const numOnly = raw.replace(/\D/g, "").padStart(2, "0");
  if (numOnly) return `GHS${numOnly.slice(-2)}`;
  return upper;
}

function decodeFilename(name) {
  try { return Buffer.from(name, "latin1").toString("utf8"); } catch { return name; }
}

const LANGUAGES = ["en", "ko", "ja", "zh", "de", "fr", "es", "pt", "th", "vi"];
// language 는 프롬프트에 그대로 들어간다 — 목록 밖 값(긴 문자열·지시문)은 LLM 을 부르기 전에 돌려보낸다.
function badLanguage(language) {
  return typeof language !== "string" || !LANGUAGES.includes(language);
}

// ─── GHS extraction ───
async function extractGhsFromBuffer(buffer, language, filename) {
  let pdfText = "";
  try {
    const result = await pdfParse(pdfBytes(buffer));
    pdfText = result.text;
    console.log(`[GHS] Parsed ${filename}: ${result.numpages} pages, ${pdfText.length} chars`);
  } catch (err) {
    console.error(`[GHS] Failed to parse ${filename}:`, err.message);
    return { success: false, error: "Failed to parse PDF file." };
  }

  if (!pdfText || pdfText.trim().length < 50) {
    return { success: false, error: "Could not extract text from PDF." };
  }

  const LANG_MAP = {
    en: { label: "English", danger: "Danger", warning: "Warning" },
    ko: { label: "Korean (한국어)", danger: "위험", warning: "경고" },
    ja: { label: "Japanese (日本語)", danger: "危険", warning: "警告" },
    zh: { label: "Chinese Simplified (简体中文)", danger: "危险", warning: "警告" },
    de: { label: "German (Deutsch)", danger: "Gefahr", warning: "Achtung" },
    fr: { label: "French (Français)", danger: "Danger", warning: "Attention" },
    es: { label: "Spanish (Español)", danger: "Peligro", warning: "Atención" },
    pt: { label: "Portuguese (Português)", danger: "Perigo", warning: "Atenção" },
    th: { label: "Thai (ภาษาไทย)", danger: "อันตราย", warning: "คำเตือน" },
    vi: { label: "Vietnamese (Tiếng Việt)", danger: "Nguy hiểm", warning: "Cảnh báo" },
  };
  const lang = LANG_MAP[language] || LANG_MAP.en;
  const signalWordDanger = lang.danger;
  const signalWordWarning = lang.warning;
  const langLabel = lang.label;
  const picNames = language === "ko" ? GHS_PICTOGRAM_NAMES_KO : GHS_PICTOGRAM_NAMES_EN;

  const systemPrompt = `You are an expert in chemical safety and GHS. Extract GHS label information from MSDS text and return it in ${langLabel}.

Return a JSON object:
{"productName":"string","supplier":"string","signalWord":"${signalWordDanger} or ${signalWordWarning}","pictograms":[{"code":"GHSxx","name":"string"}],"hazardStatements":["string"],"precautionaryStatements":["string"],"casNumber":"string or null","chemicalFormula":"string or null","emergencyPhone":"string or null","language":"${language}"}

Pictogram codes: ${GHS_PICTOGRAM_CODES.join(", ")}
Names: ${Object.entries(picNames).map(([k,v])=>`${k}:${v}`).join(", ")}

Rules:
- Search Section 2 for explicit pictograms first. Only infer from H-codes if none found.
- Use STANDARD ${langLabel} H/P-statement text, not corrupted PDF text.
- IMPORTANT: PDF text extraction often garbles Korean/CJK characters (e.g. "전"→"젂", "안"→"앆"). If you detect corrupted characters in ANY field (product name, supplier, laws, statements), correct them to the proper standard text. Never output garbled characters.
- Return ONLY valid JSON.`;

  await acquireAiSlot();
  try {
    const rawContent = await complete(
      `${systemPrompt}\n\nMSDS text:\n${pdfText.substring(0, 15000)}`,
      2048,
    );
    if (!rawContent) return { success: false, error: "AI returned empty response" };

    const ghsData = extractJson(rawContent);
    if (!ghsData || typeof ghsData !== "object" || Array.isArray(ghsData)) return { success: false, error: "Failed to parse AI response" };

    if (!ghsData.productName || !ghsData.signalWord) return { success: false, error: "Incomplete GHS information" };

    const pictograms = (Array.isArray(ghsData.pictograms) ? ghsData.pictograms : [])
      .filter(p => p && typeof p === "object")
      .map(p => ({ code: p.code ? normalizePictogramCode(String(p.code)) : "", name: p.name }))
      .filter(p => GHS_PICTOGRAM_CODES.includes(p.code))
      .map(p => ({ code: p.code, name: p.name ?? picNames[p.code] ?? p.code }));

    return {
      success: true,
      data: normalizeGhsData({
        productName: String(ghsData.productName ?? ""),
        supplier: String(ghsData.supplier ?? ""),
        // 신호어는 라벨 언어의 두 단어뿐이다. 다른 언어로 왔으면(«Danger» 를 한국어 라벨에) 뜻으로 옮긴다.
        signalWord: isDangerWord(ghsData.signalWord, Object.values(LANG_MAP).map(l => l.danger))
          ? signalWordDanger : signalWordWarning,
        pictograms,
        hazardStatements: Array.isArray(ghsData.hazardStatements) ? ghsData.hazardStatements.map(String) : [],
        // 12개로 자르던 것을 없앴다(2026-11-05). 안내 없이 잘린 문구는 라벨에서 사라진다 — 많으면 라벨이 2단·축소로 담는다.
        precautionaryStatements: Array.isArray(ghsData.precautionaryStatements) ? ghsData.precautionaryStatements.map(String) : [],
        casNumber: ghsData.casNumber ? String(ghsData.casNumber) : null,
        chemicalFormula: ghsData.chemicalFormula ? String(ghsData.chemicalFormula) : null,
        emergencyPhone: ghsData.emergencyPhone ? String(ghsData.emergencyPhone) : null,
        language,
      }, picNames, { danger: signalWordDanger }),
    };
  } catch (err) {
    console.error(`[GHS] API error for ${filename}:`, err.message);
    return { success: false, error: "Failed to extract GHS information." };
  } finally { releaseAiSlot(); }
}

// ─── Transport extraction ───
async function extractTransportFromBuffer(buffer, language, filename) {
  let pdfText = "";
  try {
    const result = await pdfParse(pdfBytes(buffer));
    pdfText = result.text;
    console.log(`[TRANSPORT] Parsed ${filename}: ${result.numpages} pages, ${pdfText.length} chars`);
  } catch (err) {
    console.error(`[TRANSPORT] Failed to parse ${filename}:`, err.message);
    return { success: false, error: "Failed to parse PDF file." };
  }

  if (!pdfText || pdfText.trim().length < 50) {
    return { success: false, error: "Could not extract text from PDF." };
  }

  const LANG_LABELS = {
    en: "English", ko: "Korean", ja: "Japanese", zh: "Chinese", de: "German",
    fr: "French", es: "Spanish", pt: "Portuguese", th: "Thai", vi: "Vietnamese",
  };
  const langLabel = LANG_LABELS[language] || "English";

  const systemPrompt = `You are an expert in dangerous goods transport regulations (UN, ADR, IMDG, IATA).
Extract transport information from MSDS/SDS Section 14 and return in ${langLabel}.

Return a JSON object:
{
  "productName": "string",
  "unNumber": "string — UN four-digit number (e.g. UN1230) or 'Not regulated'",
  "properShippingName": "string — official UN proper shipping name in ${langLabel}",
  "hazardClass": "string — primary class (e.g. 3, 6.1, 8)",
  "subsidiaryRisks": ["string — additional classes if any"],
  "packingGroup": "string — I, II, or III, or null",
  "marinePollutant": "boolean",
  "transportCategory": "string — ADR transport category if available, or null",
  "specialProvisions": ["string — any special provision codes"],
  "tunnelRestrictionCode": "string or null",
  "emergencyAction": "string — emergency response code if available, or null",
  "additionalInfo": "string — any other transport-relevant notes, or null",
  "notRegulated": "boolean — true if the substance is not classified as dangerous goods for transport",
  "language": "${language}"
}

Rules:
- Focus on Section 14 (Transport Information) of the MSDS
- If the substance is not regulated for transport, set notRegulated=true and unNumber="Not regulated"
- Use standard ${langLabel} terminology
- IMPORTANT: PDF text extraction often garbles Korean/CJK characters. If you detect corrupted characters in ANY field, correct them to proper standard text. Never output garbled characters.
- Return ONLY valid JSON, no markdown`;

  await acquireAiSlot();
  try {
    const rawContent = await complete(
      `${systemPrompt}\n\nMSDS text:\n${pdfText.substring(0, 15000)}`,
      1024,
    );
    if (!rawContent) return { success: false, error: "AI returned empty response" };

    const data = extractJson(rawContent);
    if (!data || typeof data !== "object" || Array.isArray(data)) return { success: false, error: "Failed to parse AI response" };

    // 모델은 불리언을 문자열로 내기도 한다 — Boolean("false") 는 true 라 규제 물질에 «NOT REGULATED» 가 찍혔다.
    const flag = (v) => v === true || (typeof v === "string" && v.trim().toLowerCase() === "true");
    const notRegulated = flag(data.notRegulated);
    // 빈 응답을 «규제 대상 아님» 으로 채워 성공시키지 않는다.
    if (!notRegulated && (!data.unNumber || !data.hazardClass)) return { success: false, error: "Incomplete transport information" };

    return {
      success: true,
      data: {
        productName: String(data.productName ?? ""),
        unNumber: String(data.unNumber ?? (notRegulated ? "Not regulated" : "")),
        properShippingName: String(data.properShippingName ?? ""),
        hazardClass: String(data.hazardClass ?? ""),
        subsidiaryRisks: Array.isArray(data.subsidiaryRisks) ? data.subsidiaryRisks.map(String) : [],
        packingGroup: data.packingGroup ? String(data.packingGroup) : null,
        marinePollutant: flag(data.marinePollutant),
        transportCategory: data.transportCategory ? String(data.transportCategory) : null,
        specialProvisions: Array.isArray(data.specialProvisions) ? data.specialProvisions.map(String) : [],
        tunnelRestrictionCode: data.tunnelRestrictionCode ? String(data.tunnelRestrictionCode) : null,
        emergencyAction: data.emergencyAction ? String(data.emergencyAction) : null,
        additionalInfo: data.additionalInfo ? String(data.additionalInfo) : null,
        notRegulated,
        language: language,
      },
    };
  } catch (err) {
    console.error(`[TRANSPORT] API error for ${filename}:`, err.message);
    return { success: false, error: "Failed to extract transport information." };
  } finally { releaseAiSlot(); }
}

// ─── Upload config ───
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, fieldSize: 1024, fields: 2 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files are allowed"));
  },
});

// ─── Routes ───

// Single extraction
app.post("/api/ghs/extract", anonQuotaGate, upload.single("file"), checkUsage, async (req, res) => {
  const file = req.file;
  const language = req.body.language;
  if (!file) return res.status(400).json({ error: "No PDF uploaded" });
  if (badLanguage(language)) return res.status(400).json({ error: "Language is required" });

  const filename = decodeFilename(file.originalname);
  const result = await extractGhsFromBuffer(file.buffer, language, filename);
  if (!result.success) return res.status(400).json({ error: result.error });

  req._usageCount = 1;
  res.json(result.data);
});

// Batch extraction
app.post("/api/ghs/extract-batch", anonQuotaGate, upload.array("files", 10), checkUsage, async (req, res) => {
  const files = req.files;
  const language = req.body.language;
  if (!files || files.length === 0) return res.status(400).json({ error: "No PDF files uploaded" });
  if (badLanguage(language)) return res.status(400).json({ error: "Language is required" });

  console.log(`[GHS] Batch: ${files.length} files, language=${language}`);

  const results = await Promise.all(
    files.map(async (file) => {
      const filename = decodeFilename(file.originalname);
      const result = await extractGhsFromBuffer(file.buffer, language, filename);
      return result.success
        ? { filename, status: "success", data: result.data, error: null }
        : { filename, status: "error", data: undefined, error: result.error };
    })
  );

  const successCount = results.filter(r => r.status === "success").length;
  req._usageCount = successCount;
  // Save to history
  if (req.authInfo.pubkey) {
    for (const r of results) {
      if (r.status === "success" && r.data) {
        try { stmts.saveHistory.run(req.authInfo.pubkey, "ghs", r.filename, JSON.stringify(r.data)); } catch {}
      }
    }
  }
  console.log(`[GHS] Batch done: ${successCount}/${files.length}`);
  res.json(results);
});

// Transport extraction (single)
app.post("/api/transport/extract", anonQuotaGate, upload.single("file"), checkUsage, async (req, res) => {
  const file = req.file;
  const language = req.body.language;
  if (!file) return res.status(400).json({ error: "No PDF uploaded" });
  if (badLanguage(language)) return res.status(400).json({ error: "Language is required" });

  const filename = decodeFilename(file.originalname);
  const result = await extractTransportFromBuffer(file.buffer, language, filename);
  if (!result.success) return res.status(400).json({ error: result.error });

  req._usageCount = 1;
  res.json(result.data);
});

// Transport batch extraction
app.post("/api/transport/extract-batch", anonQuotaGate, upload.array("files", 10), checkUsage, async (req, res) => {
  const files = req.files;
  const language = req.body.language;
  if (!files || files.length === 0) return res.status(400).json({ error: "No PDF files uploaded" });
  if (badLanguage(language)) return res.status(400).json({ error: "Language is required" });

  console.log(`[TRANSPORT] Batch: ${files.length} files, language=${language}`);

  const results = await Promise.all(
    files.map(async (file) => {
      const filename = decodeFilename(file.originalname);
      const result = await extractTransportFromBuffer(file.buffer, language, filename);
      return result.success
        ? { filename, status: "success", data: result.data, error: null }
        : { filename, status: "error", data: undefined, error: result.error };
    })
  );

  const successCount = results.filter(r => r.status === "success").length;
  req._usageCount = successCount;
  if (req.authInfo.pubkey) {
    for (const r of results) {
      if (r.status === "success" && r.data) {
        try { stmts.saveHistory.run(req.authInfo.pubkey, "transport", r.filename, JSON.stringify(r.data)); } catch {}
      }
    }
  }
  console.log(`[TRANSPORT] Batch done: ${successCount}/${files.length}`);
  res.json(results);
});

// ─── History ───
app.get("/api/history/:pubkey", requireAuth, (req, res) => {
  if (req.params.pubkey !== req.verifiedPubkey) return res.status(403).json({ error: "Forbidden" });
  const { pubkey } = req.params;
  const items = stmts.getHistory.all(pubkey);
  res.json(items);
});

app.get("/api/history/:pubkey/:id", requireAuth, (req, res) => {
  if (req.params.pubkey !== req.verifiedPubkey) return res.status(403).json({ error: "Forbidden" });
  const item = stmts.getHistoryItem.get(Number(req.params.id), req.params.pubkey);
  if (!item) return res.status(404).json({ error: "Not found" });
  res.json({ ...item, data: JSON.parse(item.data) });
});

app.delete("/api/history/:pubkey/:id", requireAuth, (req, res) => {
  if (req.params.pubkey !== req.verifiedPubkey) return res.status(403).json({ error: "Forbidden" });
  stmts.deleteHistoryItem.run(Number(req.params.id), req.params.pubkey);
  res.json({ ok: true });
});

// ─── Generic AI extraction helper ───
async function extractWithPrompt(buffer, language, filename, systemPrompt, logTag) {
  let pdfText = "";
  try {
    const result = await pdfParse(pdfBytes(buffer));
    pdfText = result.text;
    console.log(`[${logTag}] Parsed ${filename}: ${result.numpages} pages, ${pdfText.length} chars`);
  } catch (err) {
    console.error(`[${logTag}] Failed to parse ${filename}:`, err.message);
    return { success: false, error: "Failed to parse PDF file." };
  }
  if (!pdfText || pdfText.trim().length < 50) {
    return { success: false, error: "Could not extract text from PDF." };
  }
  await acquireAiSlot();
  try {
    const rawContent = await complete(
      `${systemPrompt}\n\nDocument text:\n${pdfText.substring(0, 15000)}`,
      4096,
    );
    if (!rawContent) return { success: false, error: "AI returned empty response" };
    const data = shapeDocument(extractJson(rawContent));
    if (!data) return { success: false, error: "Failed to parse AI response" };
    return { success: true, data };
  } catch (err) {
    console.error(`[${logTag}] API error for ${filename}:`, err.message);
    return { success: false, error: `Failed to extract ${logTag} information.` };
  } finally { releaseAiSlot(); }
}

function batchRoute(path, promptFn, logTag, mode) {
  app.post(path, anonQuotaGate, upload.array("files", 10), checkUsage, async (req, res) => {
    const files = req.files;
    const language = req.body.language;
    if (!files || files.length === 0) return res.status(400).json({ error: "No PDF files uploaded" });
    if (badLanguage(language)) return res.status(400).json({ error: "Language is required" });
    console.log(`[${logTag}] Batch: ${files.length} files, language=${language}`);
    const results = await Promise.all(files.map(async (file) => {
      const filename = decodeFilename(file.originalname);
      const prompt = promptFn(language);
      const result = await extractWithPrompt(file.buffer, language, filename, prompt, logTag);
      return result.success
        ? { filename, status: "success", data: result.data, error: null }
        : { filename, status: "error", data: undefined, error: result.error };
    }));
    const successCount = results.filter(r => r.status === "success").length;
    req._usageCount = successCount;
    if (req.authInfo.pubkey) {
      for (const r of results) {
        if (r.status === "success" && r.data) {
          try { stmts.saveHistory.run(req.authInfo.pubkey, mode, r.filename, JSON.stringify(r.data)); } catch {}
        }
      }
    }
    console.log(`[${logTag}] Batch done: ${successCount}/${files.length}`);
    res.json(results);
  });
}

// ─── IATA DGD ───
const dgdPrompt = (lang) => `You are an expert in IATA Dangerous Goods Regulations.
Extract information needed for a Shipper's Declaration for Dangerous Goods from this MSDS/SDS.

Return JSON:
{
  "productName": "string",
  "unNumber": "string (e.g. UN1230)",
  "properShippingName": "string — official IATA shipping name",
  "hazardClass": "string",
  "subsidiaryRisks": ["string"],
  "packingGroup": "string or null",
  "quantity": "string — net quantity per package if found, or null",
  "packagingInstructions": "string — IATA packing instruction number if found, or null",
  "authorization": "string — special permit or approval if needed, or null",
  "additionalHandling": "string — additional handling info, or null",
  "emergencyPhone": "string or null",
  "marinePollutant": false,
  "radioactive": false,
  "declarationText": "I hereby declare that the contents of this consignment are fully and accurately described above by the proper shipping name, and are classified, packaged, marked and labelled/placarded, and are in all respects in proper condition for transport according to applicable international and national governmental regulations.",
  "language": "${lang}"
}

Rules:
- Extract UN number, proper shipping name, class, and packing group from Section 14
- Use standard IATA terminology
- If corrupted characters detected, correct them
- Return ONLY valid JSON`;

batchRoute("/api/dgd/extract-batch", dgdPrompt, "DGD", "dgd");

// ─── SDS Convert (8→16 section) ───
const sdsConvertPrompt = (lang) => {
  const LANG_LABELS = { en:"English", ko:"Korean", ja:"Japanese", zh:"Chinese", de:"German", fr:"French", es:"Spanish", pt:"Portuguese", th:"Thai", vi:"Vietnamese" };
  const langLabel = LANG_LABELS[lang] || "English";
  return `You are an expert in GHS Safety Data Sheet authoring.
Convert this MSDS/SDS into the standard GHS 16-section format in ${langLabel}.

Return JSON with exactly these 16 sections:
{
  "productName": "string",
  "sections": {
    "1": { "title": "Identification", "content": "string" },
    "2": { "title": "Hazard Identification", "content": "string" },
    "3": { "title": "Composition/Information on Ingredients", "content": "string" },
    "4": { "title": "First-Aid Measures", "content": "string" },
    "5": { "title": "Fire-Fighting Measures", "content": "string" },
    "6": { "title": "Accidental Release Measures", "content": "string" },
    "7": { "title": "Handling and Storage", "content": "string" },
    "8": { "title": "Exposure Controls/Personal Protection", "content": "string" },
    "9": { "title": "Physical and Chemical Properties", "content": "string" },
    "10": { "title": "Stability and Reactivity", "content": "string" },
    "11": { "title": "Toxicological Information", "content": "string" },
    "12": { "title": "Ecological Information", "content": "string" },
    "13": { "title": "Disposal Considerations", "content": "string" },
    "14": { "title": "Transport Information", "content": "string" },
    "15": { "title": "Regulatory Information", "content": "string" },
    "16": { "title": "Other Information", "content": "string" }
  },
  "language": "${lang}"
}

Rules:
- Map existing content to the correct GHS section numbers
- If a section has no data in the source, write "No data available"
- Section titles must be in ${langLabel}
- Content must be in ${langLabel}
- Fix any corrupted/garbled characters
- Return ONLY valid JSON`;
};

batchRoute("/api/sds/convert-batch", sdsConvertPrompt, "SDS", "sds-convert");

// ─── UN38.3 Battery Summary ───
const un383Prompt = (lang) => `You are an expert in lithium battery transport regulations.
Extract information for a UN38.3 Transport Document Summary from this test report or MSDS.

Return JSON:
{
  "productName": "string — battery or product name",
  "manufacturer": "string",
  "batteryType": "string — e.g. Lithium Ion, Lithium Metal, etc.",
  "wattHourRating": "string — Wh rating per cell/battery, or null",
  "lithiumContent": "string — grams of lithium per cell/battery, or null",
  "unNumber": "string — UN3480, UN3481, UN3090, or UN3091",
  "properShippingName": "string",
  "hazardClass": "9",
  "packingGroup": "null",
  "testResults": [
    "T.1 Altitude Simulation: Pass/Fail/Not tested",
    "T.2 Thermal Test: Pass/Fail/Not tested",
    "T.3 Vibration: Pass/Fail/Not tested",
    "T.4 Shock: Pass/Fail/Not tested",
    "T.5 External Short Circuit: Pass/Fail/Not tested",
    "T.6 Impact/Crush: Pass/Fail/Not tested",
    "T.7 Overcharge: Pass/Fail/Not tested",
    "T.8 Forced Discharge: Pass/Fail/Not tested"
  ],
  "testLab": "string — testing laboratory name, or null",
  "testDate": "string — date of testing, or null",
  "additionalInfo": "string or null",
  "language": "${lang}"
}

Rules:
- If this is an MSDS rather than a test report, extract battery-relevant info from available sections
- UN3480=Li-ion batteries alone, UN3481=Li-ion in/with equipment, UN3090=Li-metal alone, UN3091=Li-metal in/with equipment
- If test results not found, mark as "Not tested"
- Fix corrupted characters
- Return ONLY valid JSON`;

batchRoute("/api/un383/extract-batch", un383Prompt, "UN383", "un383");

// Health
// llm 카운터를 같이 낸다. 추출이 로컬에서 도는지 유료 폴백으로 새고 있는지는
// 응답만 봐서는 구분이 안 된다 — 둘 다 정상적인 JSON 을 돌려주기 때문이다.
// 이게 없으면 "로컬로 바꿨다"는 기억만 남고 실제로는 계속 과금될 수 있다.
app.get("/api/health", (_req, res) => res.json({ status: "ok", service: "ghs-label-maker", llm: llmStats }));

// Plans info
app.get("/api/plans", (_req, res) => res.json(PLANS));

// ⚠ 이 앱에는 클라이언트 라우팅이 있다(src/App.tsx 의 wouter, 라우트 /·/terms·
//   /privacy). 2026-08-26 soft-404 조치 때 "클라이언트 라우팅이 없다"고 잘못 보고
//   전 경로를 404 로 돌렸더니, 법적 고지 두 페이지가 화면은 정상인데 상태 코드만
//   404 로 나갔다(2026-09-07 실측·수정). 홈 푸터가 raw <a> 로 이 둘을 링크하므로
//   크롤러가 반드시 방문한다 - 색인에서 탈락한다.
//   ⚠ 이 목록은 App.tsx 의 <Route path> 와 짝이다. 한쪽만 늘리면 다시 404 가 난다.
//   값은 그 페이지의 <h1> 제목. 셸(index.html)의 canonical·og:url·title 이 홈으로
//   굳어 있어 그대로 보내면 두 페이지가 «홈의 중복» 으로 선언된다(Lighthouse canonical
//   실패, 2026-09-29 실측) — 라우트별로 그 값들만 바꿔 보낸다.
const SPA_ROUTES = { "/terms": "Terms of Service", "/privacy": "Privacy Policy" };
const SHELL_PATH = path.join(__dirname, "../dist/index.html");
for (const [route, title] of Object.entries(SPA_ROUTES)) {
  const url = `https://ghs.txid.uk${route}`;
  const fullTitle = `${title} — GHS Label Generator`;
  app.get(route, (_req, res) => {
    const html = fs.readFileSync(SHELL_PATH, "utf8")
      .replace(/<link rel="canonical" href="[^"]*"/, `<link rel="canonical" href="${url}"`)
      .replace(/<meta property="og:url" content="[^"]*"/, `<meta property="og:url" content="${url}"`)
      .replace(/<title>[^<]*<\/title>/, `<title>${fullTitle}</title>`)
      .replace(/<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${fullTitle}"`)
      .replace(/<meta name="twitter:title" content="[^"]*"/, `<meta name="twitter:title" content="${fullTitle}"`);
    res.type("html").send(html);
  });
}

// 인쇄 전용 /print(src/pages/print-label.tsx). 라벨 데이터가 주소 # 뒤에 실려 오는 화면이라
// 색인할 내용이 없다 — SPA_ROUTES(색인 대상)에 넣지 않고 200 + noindex 로만 준다.
app.get("/print", (_req, res) => {
  res.set("X-Robots-Tag", "noindex").sendFile(SHELL_PATH);
});

// 없는 API 경로는 JSON 404. 아래 catch-all 은 앱 셸 HTML 을 주는데, /api/* 를 부르는 쪽은 JSON 을
// 기대한다(2026-11-12). GET 외 메서드도 여기서 받는다 — 안 그러면 Express 기본 «Cannot POST» HTML.
app.all("/api/{*splat}", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// 없는 경로 fallback.
// ⚠ 200 이 아니라 404 로 준다. 실제 페이지(/, /index.html)는
// 위의 express.static 이, SPA 라우트는 바로 위 화이트리스트가 처리한다 — 여기까지
// 온 경로는 존재하지 않는 것이다. 200 을 주면 검색엔진이 오타 URL 을 정상 페이지로
// 색인하고 링크 검사도 깨진 링크를 못 잡는다(soft-404).
// 화면은 그대로 앱 셸을 보여주되 상태 코드만 진실을 말하게 한다.
app.get("/{*splat}", (_req, res) => {
  res.status(404).sendFile(path.join(__dirname, "../dist/index.html"));
});

// ─── Error handler ───
// multer 에러(비 PDF·10MB 초과·11개 이상)가 Express 기본 핸들러로 떨어지면
// HTML 500 + 전체 스택트레이스(서버 절대경로 포함)가 그대로 나간다 — VPS pm2
// 에는 NODE_ENV 가 없어 non-production 취급이다(위 CORS 주석 참조). JSON 을
// 기대하는 프론트를 위해 상태코드와 본문을 바로잡는다.
// eslint 없음 — next 는 4-인자 시그니처(에러 미들웨어 판별)를 위해 필요하다.
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: err.message });
  }
  if (err.message === "Only PDF files are allowed") {
    return res.status(400).json({ error: err.message });
  }
  // 깨진 JSON·과대 본문은 클라이언트 오류다(스택을 로그에 남길 일도 아니다).
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON" });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "Request body too large" });
  console.error("[GHS] Unhandled error:", err);
  res.status(500).json({ error: "Internal error" });
});

app.listen(PORT, () => console.log(`[GHS] Server running on port ${PORT}`));
