import express from "express";
import cors from "cors";
import multer from "multer";
import { createRequire } from "module";
import Anthropic from "@anthropic-ai/sdk";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3100;

// ─── Database ───
const db = new Database(path.join(__dirname, "ghs.db"));
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
  CREATE INDEX IF NOT EXISTS idx_usage_pubkey ON usage(pubkey);
  CREATE INDEX IF NOT EXISTS idx_usage_ip ON usage(ip);
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
  createPayment: db.prepare("INSERT INTO payments (pubkey, payment_hash, amount_sats, plan) VALUES (?, ?, ?, ?)"),
  getPayment: db.prepare("SELECT * FROM payments WHERE payment_hash = ?"),
  completePayment: db.prepare("UPDATE payments SET status = 'paid' WHERE payment_hash = ?"),
};

// ─── Config ───
const FREE_LIMIT = 3;
const PHOENIXD_URL = process.env.PHOENIXD_URL || "http://127.0.0.1:9740";
const PHOENIXD_PASSWORD = process.env.PHOENIXD_PASSWORD || "";

const PLANS = {
  single:  { sats: 100,   credits: 1,    label: "1 extraction" },
  weekly:  { sats: 3000,  credits: 50,   label: "Weekly (50)", days: 7 },
  monthly: { sats: 9900,  credits: 200,  label: "Monthly (200)", days: 30 },
  annual:  { sats: 79000, credits: 2400, label: "Annual (2400)", days: 365 },
};

// Per-file pricing with volume discounts
function calcBatchPrice(fileCount) {
  if (fileCount <= 0) return { perFile: 100, total: 0, discount: 0 };
  let perFile;
  if (fileCount >= 20) perFile = 50;       // 50% off
  else if (fileCount >= 10) perFile = 70;  // 30% off
  else if (fileCount >= 5) perFile = 85;   // 15% off
  else perFile = 100;
  return { perFile, total: perFile * fileCount, discount: Math.round((1 - perFile / 100) * 100) };
}

// ─── PDF parser ───
const _require = createRequire(import.meta.url);
const pdfParse = _require("pdf-parse");

// ─── Anthropic client ───
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Middleware ───
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "../dist")));

// Extract user pubkey from header (set by frontend after txid-auth login)
function getUserPubkey(req) {
  return req.headers["x-user-pubkey"] || null;
}

function getClientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "";
}

// ─── Auth & Usage check middleware ───
function checkUsage(req, res, next) {
  const pubkey = getUserPubkey(req);
  const ip = getClientIp(req);
  const fileCount = Array.isArray(req.files) ? req.files.length : (req.file ? 1 : 0);

  if (pubkey) {
    // Logged-in user: check credits or free tier
    const credits = stmts.getCredits.get(pubkey);

    if (credits) {
      // Has a plan — check if active
      const now = Math.floor(Date.now() / 1000);
      if (credits.plan !== "free" && credits.plan_expires_at > 0 && credits.plan_expires_at < now) {
        // Plan expired, reset to free
        stmts.upsertCredits.run(pubkey, 0, "free", 0, 0, "free", 0);
      } else if (credits.amount >= fileCount) {
        req.authInfo = { pubkey, type: "paid", remaining: credits.amount - fileCount };
        return next();
      }
    }

    // Check free tier
    const { cnt } = stmts.countByPubkey.get(pubkey);
    if (cnt + fileCount <= FREE_LIMIT) {
      req.authInfo = { pubkey, type: "free", remaining: FREE_LIMIT - cnt - fileCount };
      return next();
    }

    return res.status(402).json({
      error: "Usage limit reached",
      message: pubkey ? "Free trial exhausted. Purchase credits to continue." : "Please login first.",
      needsPayment: true,
      plans: PLANS,
    });
  }

  // Anonymous: check by IP
  const { cnt } = stmts.countByIp.get(ip);
  if (cnt + fileCount <= FREE_LIMIT) {
    req.authInfo = { pubkey: null, ip, type: "anonymous", remaining: FREE_LIMIT - cnt - fileCount };
    return next();
  }

  return res.status(402).json({
    error: "Usage limit reached",
    message: "Free trial exhausted. Login and purchase credits to continue.",
    needsPayment: true,
    needsLogin: true,
    plans: PLANS,
  });
}

// Record usage after successful extraction
function recordUsage(pubkey, ip, count) {
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

// ─── Lightning payments ───
function phoenixdAuth() {
  return "Basic " + Buffer.from(":" + PHOENIXD_PASSWORD).toString("base64");
}

// Batch price calculator
app.get("/api/payment/price/:count", (req, res) => {
  const count = parseInt(req.params.count) || 0;
  if (count <= 0 || count > 30) return res.status(400).json({ error: "Count must be 1-30" });
  res.json(calcBatchPrice(count));
});

// Create invoice for batch (per-file pricing)
app.post("/api/payment/create-batch", express.json(), async (req, res) => {
  const { fileCount, pubkey } = req.body;
  if (!pubkey) return res.status(400).json({ error: "Login required" });
  if (!fileCount || fileCount < 1 || fileCount > 30) return res.status(400).json({ error: "File count must be 1-30" });
  if (!PHOENIXD_PASSWORD) return res.status(503).json({ error: "Payment not configured" });

  const price = calcBatchPrice(fileCount);

  try {
    const resp = await fetch(`${PHOENIXD_URL}/createinvoice`, {
      method: "POST",
      headers: { Authorization: phoenixdAuth(), "Content-Type": "application/x-www-form-urlencoded" },
      body: `amountSat=${price.total}&description=${encodeURIComponent(`GHS Label: ${fileCount} file${fileCount > 1 ? "s" : ""}${price.discount ? ` (${price.discount}% off)` : ""}`)}`,
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
app.post("/api/payment/create", express.json(), async (req, res) => {
  const { plan, pubkey } = req.body;
  if (!pubkey) return res.status(400).json({ error: "Login required" });
  if (!PLANS[plan]) return res.status(400).json({ error: "Invalid plan" });
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

// Check payment status
app.get("/api/payment/check/:hash", async (req, res) => {
  const { hash } = req.params;
  const payment = stmts.getPayment.get(hash);
  if (!payment) return res.status(404).json({ error: "Payment not found" });
  if (payment.status === "paid") return res.json({ paid: true });

  if (!PHOENIXD_PASSWORD) return res.json({ paid: false });

  try {
    const resp = await fetch(`${PHOENIXD_URL}/payments/incoming/${hash}`, {
      headers: { Authorization: phoenixdAuth() },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return res.json({ paid: false });
    const data = await resp.json();

    if (data.isPaid) {
      stmts.completePayment.run(hash);

      // Add credits
      const pubkey = payment.pubkey;
      const now = Math.floor(Date.now() / 1000);
      const existing = stmts.getCredits.get(pubkey);
      const currentAmount = existing ? existing.amount : 0;

      // Handle batch payments (batch-5, batch-10, etc.) and plan payments
      let creditsToAdd, expiresAt;
      if (payment.plan.startsWith("batch-")) {
        creditsToAdd = parseInt(payment.plan.split("-")[1]) || 1;
        expiresAt = existing?.plan_expires_at || 0;
      } else {
        const plan = PLANS[payment.plan];
        if (!plan) return res.json({ paid: true });
        creditsToAdd = plan.credits;
        expiresAt = plan.days ? now + plan.days * 86400 : 0;
      }
      const newAmount = currentAmount + creditsToAdd;

      const planName = payment.plan.startsWith("batch-") ? (existing?.plan || "payg") : payment.plan;
      stmts.upsertCredits.run(
        pubkey, newAmount, planName, expiresAt,
        newAmount, planName, expiresAt
      );

      return res.json({ paid: true, credits: newAmount, plan: payment.plan });
    }

    res.json({ paid: false });
  } catch (err) {
    console.error("[GHS] Payment check error:", err.message);
    res.json({ paid: false });
  }
});

// User info (credits, usage)
app.get("/api/user/:pubkey", (req, res) => {
  const { pubkey } = req.params;
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

// ─── GHS extraction ───
async function extractGhsFromBuffer(buffer, language, filename) {
  let pdfText = "";
  try {
    const result = await pdfParse(buffer);
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
- Max 12 precautionary statements.
- Return ONLY valid JSON.`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [{ role: "user", content: `${systemPrompt}\n\nMSDS text:\n${pdfText.substring(0, 15000)}` }],
    });

    const rawContent = message.content[0]?.type === "text" ? message.content[0].text : "";
    if (!rawContent) return { success: false, error: "AI returned empty response" };

    const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { success: false, error: "Failed to parse AI response" };

    let ghsData;
    try { ghsData = JSON.parse(jsonMatch[0]); } catch { return { success: false, error: "Failed to parse AI response" }; }

    if (!ghsData.productName || !ghsData.signalWord) return { success: false, error: "Incomplete GHS information" };

    const pictograms = (Array.isArray(ghsData.pictograms) ? ghsData.pictograms : [])
      .map(p => ({ code: p.code ? normalizePictogramCode(p.code) : "", name: p.name }))
      .filter(p => GHS_PICTOGRAM_CODES.includes(p.code))
      .map(p => ({ code: p.code, name: p.name ?? picNames[p.code] ?? p.code }));

    return {
      success: true,
      data: {
        productName: String(ghsData.productName ?? ""),
        supplier: String(ghsData.supplier ?? ""),
        signalWord: String(ghsData.signalWord ?? signalWordWarning),
        pictograms,
        hazardStatements: Array.isArray(ghsData.hazardStatements) ? ghsData.hazardStatements.map(String) : [],
        precautionaryStatements: Array.isArray(ghsData.precautionaryStatements) ? ghsData.precautionaryStatements.map(String).slice(0, 12) : [],
        casNumber: ghsData.casNumber ? String(ghsData.casNumber) : null,
        chemicalFormula: ghsData.chemicalFormula ? String(ghsData.chemicalFormula) : null,
        emergencyPhone: ghsData.emergencyPhone ? String(ghsData.emergencyPhone) : null,
        language,
      },
    };
  } catch (err) {
    console.error(`[GHS] API error for ${filename}:`, err.message);
    return { success: false, error: "Failed to extract GHS information." };
  }
}

// ─── Upload config ───
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files are allowed"));
  },
});

// ─── Routes ───

// Single extraction
app.post("/api/ghs/extract", upload.single("file"), checkUsage, async (req, res) => {
  const file = req.file;
  const language = req.body.language;
  if (!file) return res.status(400).json({ error: "No PDF uploaded" });
  if (!language) return res.status(400).json({ error: "Language is required" });

  const filename = decodeFilename(file.originalname);
  const result = await extractGhsFromBuffer(file.buffer, language, filename);
  if (!result.success) return res.status(400).json({ error: result.error });

  recordUsage(req.authInfo.pubkey, getClientIp(req), 1);
  res.json(result.data);
});

// Batch extraction
app.post("/api/ghs/extract-batch", upload.array("files", 30), checkUsage, async (req, res) => {
  const files = req.files;
  const language = req.body.language;
  if (!files || files.length === 0) return res.status(400).json({ error: "No PDF files uploaded" });
  if (!language) return res.status(400).json({ error: "Language is required" });

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
  recordUsage(req.authInfo.pubkey, getClientIp(req), successCount);
  console.log(`[GHS] Batch done: ${successCount}/${files.length}`);
  res.json(results);
});

// Health
app.get("/api/health", (_req, res) => res.json({ status: "ok", service: "ghs-label-maker" }));

// Plans info
app.get("/api/plans", (_req, res) => res.json(PLANS));

// SPA fallback
app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(__dirname, "../dist/index.html"));
});

app.listen(PORT, () => console.log(`[GHS] Server running on port ${PORT}`));
