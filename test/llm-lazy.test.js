import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// 회귀: Anthropic 클라이언트를 모듈 로드 시점에 만들면, index.js 의
// loadEnvFile() 이 그 뒤에 도는 탓에(.env 로만 키가 공급되는 재부팅 시나리오)
// apiKey=null 이 프로세스 수명 내내 굳는다 — SDK 는 생성 시점 값을 고정한다.
// 여기서는 키 없이 모듈을 로드한 뒤 키를 넣고, 폴백이 그 키를 쓰는지 본다.
// (별도 파일인 이유: node --test 는 파일마다 새 프로세스라 import 순서를
// 제어할 수 있다. llm.test.js 의 정적 import 와 섞이면 안 된다.)

test("complete: ANTHROPIC_API_KEY 를 모듈 로드 뒤에 넣어도 폴백이 산다", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  process.env.LLM_LOCAL_URL = "http://127.0.0.1:1/v1/chat/completions"; // 즉시 거부
  const { complete } = await import("../server/llm.js");

  // 가짜 Anthropic 엔드포인트 — 받은 x-api-key 를 확인하고 메시지를 돌려준다.
  let seenKey = null;
  const server = http.createServer((req, res) => {
    seenKey = req.headers["x-api-key"];
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      id: "msg_test", type: "message", role: "assistant",
      content: [{ type: "text", text: "pong" }],
      model: "test", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  // index.js 의 loadEnvFile() 이 하는 일을 흉내낸다: import 후에 키 공급.
  process.env.ANTHROPIC_API_KEY = "test-key-after-load";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;

  try {
    const text = await complete("ping", 10, "test");
    assert.equal(text, "pong");
    assert.equal(seenKey, "test-key-after-load");
  } finally {
    server.close();
  }
});
