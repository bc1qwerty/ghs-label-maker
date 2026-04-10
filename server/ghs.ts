import { Router, type IRouter } from "express";
import multer from "multer";
import { createRequire } from "module";
import OpenAI from "openai";
import { logger } from "../lib/logger";

const _require = createRequire(import.meta.url);
// pdf-parse v1 — accepts a Buffer directly and returns { text, numpages }
type PdfParseResult = { text: string; numpages: number };
const pdfParse = _require("pdf-parse") as (buf: Buffer) => Promise<PdfParseResult>;

async function extractTextFromPdf(buffer: Buffer): Promise<{ text: string; numPages: number }> {
  const result = await pdfParse(buffer);
  return { text: result.text, numPages: result.numpages };
}

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed"));
    }
  },
});

if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL) {
  throw new Error("AI_INTEGRATIONS_OPENAI_BASE_URL must be set.");
}
if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
  throw new Error("AI_INTEGRATIONS_OPENAI_API_KEY must be set.");
}

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

const GHS_PICTOGRAM_CODES = [
  "GHS01", "GHS02", "GHS03", "GHS04",
  "GHS05", "GHS06", "GHS07", "GHS08", "GHS09"
];

// Normalize various AI-returned code formats to standard GHSxx
function normalizePictogramCode(raw: string): string {
  const upper = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^GHS\d{2}$/.test(upper)) return upper;           // Already correct: GHS07
  const shortM = upper.match(/^GHS(\d)$/);
  if (shortM) return `GHS0${shortM[1]}`;                // GHS7 → GHS07
  const numOnly = raw.replace(/\D/g, "").padStart(2, "0");
  if (numOnly) return `GHS${numOnly.slice(-2)}`;        // "7" → GHS07, "07" → GHS07
  return upper;
}

// Decode multer filenames from latin1 → utf8 (browsers send UTF-8 in multipart)
function decodeFilename(name: string): string {
  try {
    return Buffer.from(name, "latin1").toString("utf8");
  } catch {
    return name;
  }
}

const GHS_PICTOGRAM_NAMES_KO: Record<string, string> = {
  GHS01: "폭발성",
  GHS02: "인화성",
  GHS03: "산화성",
  GHS04: "고압가스",
  GHS05: "부식성",
  GHS06: "급성독성",
  GHS07: "유해성",
  GHS08: "건강유해성",
  GHS09: "환경유해성",
};

const GHS_PICTOGRAM_NAMES_EN: Record<string, string> = {
  GHS01: "Explosive",
  GHS02: "Flammable",
  GHS03: "Oxidizer",
  GHS04: "Compressed Gas",
  GHS05: "Corrosive",
  GHS06: "Acute Toxicity",
  GHS07: "Harmful",
  GHS08: "Health Hazard",
  GHS09: "Environmental Hazard",
};

async function extractGhsFromBuffer(
  buffer: Buffer,
  language: string,
  filename: string,
  log: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void }
): Promise<{ success: true; data: Record<string, unknown> } | { success: false; error: string }> {
  let pdfText = "";
  try {
    const pdfData = await extractTextFromPdf(buffer);
    pdfText = pdfData.text;
    log.info({ filename, pages: pdfData.numPages, textLength: pdfText.length }, "PDF parsed");
  } catch (err) {
    log.error({ err, filename }, "Failed to parse PDF");
    return { success: false, error: "Failed to parse PDF file. Please ensure it is a valid PDF." };
  }

  if (!pdfText || pdfText.trim().length < 50) {
    return { success: false, error: "Could not extract text from PDF. The file may be scanned or image-based." };
  }

  const isKorean = language === "ko";
  const signalWordDanger = isKorean ? "위험" : "Danger";
  const signalWordWarning = isKorean ? "경고" : "Warning";
  const langLabel = isKorean ? "Korean (한국어)" : "English";

  const systemPrompt = `You are an expert in chemical safety and GHS (Globally Harmonized System of Classification and Labelling of Chemicals).
Your task is to extract GHS label information from MSDS (Material Safety Data Sheet) text and return it in ${langLabel}.

Return a JSON object with exactly this structure:
{
  "productName": "string - the chemical product name in ${langLabel}",
  "supplier": "string - supplier/manufacturer name",
  "signalWord": "string - must be exactly '${signalWordDanger}' or '${signalWordWarning}' based on the hazard level",
  "pictograms": [{"code": "GHSxx", "name": "string"}],
  "hazardStatements": ["string"],
  "precautionaryStatements": ["string"],
  "casNumber": "string or null",
  "chemicalFormula": "string or null",
  "emergencyPhone": "string or null",
  "language": "${language}"
}

Pictogram codes to use (only applicable ones): ${GHS_PICTOGRAM_CODES.join(", ")}
Pictogram names in ${langLabel}: ${Object.entries(isKorean ? GHS_PICTOGRAM_NAMES_KO : GHS_PICTOGRAM_NAMES_EN).map(([k, v]) => `${k}: ${v}`).join(", ")}

Rules for pictograms:
- STEP 1: Search Section 2 (GHS label elements / 라벨요소 / 그림문자) for EXPLICITLY listed pictogram codes or symbol names (e.g. "GHS02", "인화성", "해골", "느낌표"). Collect only what is directly stated.
- STEP 2: If and ONLY IF zero explicit pictograms were found in Step 1, infer from H-statement codes: H2xx→GHS01/GHS02/GHS03, H270/H271/H272/H280/H281→GHS04, H290/H314/H318→GHS05, H300/H310/H330→GHS06, H302/H312/H332/H315/H319/H335/H317→GHS07, H340/H341/H350/H351/H360/H361/H370/H371/H372/H373/H334→GHS08, H400/H410/H411/H412→GHS09
- NEVER add inferred pictograms to an already-populated explicit list. Explicit beats inferred.
- Return exactly the pictograms the document specifies, no more, no less.

Rules for phone number (emergencyPhone):
- Look for a phone/telephone number (전화, 연락처, 비상연락처, phone, tel) in BOTH the supplier/distributor section AND the manufacturer/제조자 section.
- If the manufacturer and supplier are the same company, the phone is often listed only once in the manufacturer section. In that case, use that phone number as emergencyPhone.
- Include any emergency hotline numbers (119, 1339, poison control, 화학물질안전원, etc.) if present.
- If multiple phone numbers found, prefer the emergency/비상 line; otherwise use the main contact number.

Rules for H-statements and P-statements (CRITICAL for Korean text quality):
- PDF text extraction sometimes produces garbled or corrupted Korean characters due to font encoding issues.
- Always identify statements by their H-code or P-code (e.g. H319, P260). Use the STANDARD ${langLabel} text for that code — do NOT copy corrupted/garbled text from the PDF.
- Standard Korean H-statement examples: H302=삼키면 유해함, H315=피부 자극을 일으킴, H319=눈에 심한 자극을 일으킴, H335=호흡기 자극을 일으킬 수 있음, H314=피부에 심한 화상과 눈 손상을 일으킴, H318=눈에 심한 손상을 일으킴
- If you cannot identify the H/P code, skip that statement rather than including corrupted text.

Other rules:
- If signal word not found, infer from hazard class: Category 1/2 = ${signalWordDanger}, Category 3+ = ${signalWordWarning}
- Max 12 precautionary statements
- Return ONLY valid JSON, no markdown, no explanation`;

  const userPrompt = `Extract GHS label information from this MSDS text:\n\n${pdfText.substring(0, 15000)}`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.2",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
    });

    const rawContent = completion.choices[0]?.message?.content;
    if (!rawContent) {
      return { success: false, error: "AI returned empty response" };
    }

    let ghsData: Record<string, unknown>;
    try {
      ghsData = JSON.parse(rawContent) as Record<string, unknown>;
    } catch {
      log.error({ rawContent, filename }, "Failed to parse AI JSON");
      return { success: false, error: "Failed to parse AI response" };
    }

    if (!ghsData.productName || !ghsData.signalWord) {
      log.warn({ ghsData, filename }, "Incomplete GHS data");
      return { success: false, error: "Could not extract complete GHS information from the document" };
    }

    const pictogramsRaw = Array.isArray(ghsData.pictograms) ? ghsData.pictograms as Array<{ code?: string; name?: string }> : [];
    log.info({ filename, rawPictograms: pictogramsRaw }, "Raw pictograms from AI");
    const pictograms = pictogramsRaw
      .map((p) => {
        const normalized = p.code ? normalizePictogramCode(p.code) : "";
        return { code: normalized, name: p.name };
      })
      .filter((p) => GHS_PICTOGRAM_CODES.includes(p.code))
      .map((p) => ({
        code: p.code,
        name: p.name ?? (isKorean ? GHS_PICTOGRAM_NAMES_KO[p.code] : GHS_PICTOGRAM_NAMES_EN[p.code]) ?? p.code,
      }));

    const result = {
      productName: String(ghsData.productName ?? ""),
      supplier: String(ghsData.supplier ?? ""),
      signalWord: String(ghsData.signalWord ?? signalWordWarning),
      pictograms,
      hazardStatements: Array.isArray(ghsData.hazardStatements) ? (ghsData.hazardStatements as string[]).map(String) : [],
      precautionaryStatements: Array.isArray(ghsData.precautionaryStatements) ? (ghsData.precautionaryStatements as string[]).map(String).slice(0, 12) : [],
      casNumber: ghsData.casNumber ? String(ghsData.casNumber) : null,
      chemicalFormula: ghsData.chemicalFormula ? String(ghsData.chemicalFormula) : null,
      emergencyPhone: ghsData.emergencyPhone ? String(ghsData.emergencyPhone) : null,
      language,
    };

    log.info({ filename, productName: result.productName }, "GHS extracted successfully");
    return { success: true, data: result };
  } catch (err) {
    log.error({ err, filename }, "OpenAI API error");
    return { success: false, error: "Failed to extract GHS information. Please try again." };
  }
}

// Single file endpoint
router.post("/ghs/extract", upload.single("file"), async (req, res): Promise<void> => {
  const file = req.file;
  const language = req.body.language as string;

  if (!file) {
    res.status(400).json({ error: "No PDF file uploaded" });
    return;
  }

  if (!language || !["ko", "en"].includes(language)) {
    res.status(400).json({ error: "Language must be 'ko' or 'en'" });
    return;
  }

  const filename = decodeFilename(file.originalname);
  const result = await extractGhsFromBuffer(file.buffer, language, filename, req.log);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
});

// Batch endpoint
router.post("/ghs/extract-batch", upload.array("files", 30), async (req, res): Promise<void> => {
  const files = req.files as Express.Multer.File[] | undefined;
  const language = req.body.language as string;

  if (!files || files.length === 0) {
    res.status(400).json({ error: "No PDF files uploaded" });
    return;
  }

  if (!language || !["ko", "en"].includes(language)) {
    res.status(400).json({ error: "Language must be 'ko' or 'en'" });
    return;
  }

  req.log.info({ fileCount: files.length, language }, "Starting batch GHS extraction");

  const results = await Promise.all(
    files.map(async (file) => {
      const filename = decodeFilename(file.originalname);
      const result = await extractGhsFromBuffer(file.buffer, language, filename, req.log);
      if (result.success) {
        return {
          filename,
          status: "success" as const,
          data: result.data,
          error: null,
        };
      } else {
        return {
          filename,
          status: "error" as const,
          data: undefined,
          error: result.error,
        };
      }
    })
  );

  const successCount = results.filter((r) => r.status === "success").length;
  req.log.info({ total: files.length, success: successCount, failed: files.length - successCount }, "Batch extraction complete");

  res.json(results);
});

export default router;
