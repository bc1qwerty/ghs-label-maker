import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 회귀: ghs 의 유일한 종량 과금 경로는 Claude 폴백인데, 그 흔적이 메모리 카운터
// (llmStats)와 console.warn 뿐이었다. 카운터는 pm2 restart 마다 0 으로 돌아가고
// 로그는 pm2-logrotate 가 지우므로 "언제부터 얼마나 썼나" 를 사후에 복원할 수가
// 없었다. 이제 과금된 호출마다 ~/.ai-usage/YYYY-MM-DD.jsonl 에 한 줄 남긴다
// (형식은 content-engine·news-summary-bot 원장과 동일).
//
// 여기서는 실제 Anthropic 을 부르지 않는다 — 가짜 엔드포인트로 폴백 경로만 태운다.
// (별도 파일인 이유: LLM_LOCAL_URL 은 모듈 로드 시점에 const 로 굳으므로 import
//  순서를 제어해야 한다. node --test 는 파일마다 새 프로세스다.)

// content-engine(lib/providers.mjs)·news-summary-bot(internal/llm/usage.go)이 쓰는
// 공통 필드. 이게 갈리면 원장을 세는 방법이 서비스마다 둘로 갈린다.
const SHARED_FIELDS = ["ts", "host", "service", "model", "prompt_chars", "prompt_tokens_estimate"];

const FALLBACK_MODEL = "claude-haiku-4-5-20251001"; // llm.js 의 기본값
const utcDay = () => new Date().toISOString().slice(0, 10);

let complete;
let server;
let localOk = false; // 로컬 MLX 를 살릴지 죽일지 — 테스트마다 뒤집는다
let anthropicCalls = 0;

function freshHome(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ghs-usage-${tag}-`));
  process.env.HOME = dir;
  return dir;
}

function readLedger(home) {
  const file = path.join(home, ".ai-usage", `${utcDay()}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url.startsWith("/v1/chat/completions")) {
        // 로컬 MLX 흉내
        if (!localOk) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: "tunnel down" }));
          return;
        }
        res.end(JSON.stringify({ choices: [{ message: { content: "local-answer" } }] }));
        return;
      }
      // Anthropic 흉내 (/v1/messages)
      anthropicCalls++;
      res.end(JSON.stringify({
        id: "msg_test", type: "message", role: "assistant",
        content: [{ type: "text", text: "fallback-answer" }],
        model: FALLBACK_MODEL, stop_reason: "end_turn",
        usage: { input_tokens: 11, output_tokens: 7 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  process.env.LLM_LOCAL_URL = `http://127.0.0.1:${port}/v1/chat/completions`;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.AI_SERVICE_NAME;
  delete process.env.HOST_TAG;

  ({ complete } = await import("../server/llm.js"));
});

after(() => server.close());

test("폴백 1회가 ~/.ai-usage 원장에 형제 서비스와 같은 형식으로 한 줄 남는다", async () => {
  localOk = false;
  const home = freshHome("fallback");

  const text = await complete("ping".repeat(10), 256, "test");
  assert.equal(text, "fallback-answer");

  const lines = readLedger(home);
  assert.equal(lines.length, 1, "폴백 1회 = 원장 1줄");

  const e = lines[0];
  for (const f of SHARED_FIELDS) assert.ok(f in e, `공통 필드 ${f} 누락`);
  assert.equal(e.service, "ghs-label-maker");
  assert.equal(e.model, `claude/${FALLBACK_MODEL}`);
  assert.equal(e.prompt_chars, 40);
  assert.equal(e.prompt_tokens_estimate, 10);
  assert.equal(e.max_tokens, 256);
  assert.equal(e.host, os.hostname().split(".")[0]);
  assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  // API 가 돌려준 실측 토큰 — 추정치만으로는 과금액을 못 센다.
  assert.equal(e.input_tokens, 11);
  assert.equal(e.output_tokens, 7);
  // 폴백 사유가 남아야 pm2 로그가 지워진 뒤에도 "왜 과금됐나" 를 안다.
  assert.match(e.reason, /503/);

  // wc -l 이 곧 과금 횟수여야 하므로 두 번째 호출은 덮지 않고 붙는다.
  await complete("ping", 64, "test");
  assert.equal(readLedger(home).length, 2);
});

test("로컬이 성공하면 원장에 남기지 않는다 (과금된 호출만 센다)", async () => {
  localOk = true;
  const home = freshHome("local");
  const before = anthropicCalls;

  const text = await complete("ping", 256, "test");
  assert.equal(text, "local-answer");

  assert.equal(anthropicCalls, before, "로컬 성공인데 Anthropic 을 불렀다");
  assert.equal(fs.existsSync(path.join(home, ".ai-usage")), false, "로컬 호출은 무료 — 원장에 남으면 안 된다");
});

test("원장 기록이 실패해도 폴백 응답은 산다", async () => {
  localOk = false;
  process.env.HOME = "/dev/null/nope"; // mkdir 이 ENOTDIR 로 죽는 경로

  const text = await complete("ping", 256, "test");
  assert.equal(text, "fallback-answer", "원장 때문에 사용자 추출이 죽으면 안 된다");
});
