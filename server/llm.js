// LLM 백엔드: 로컬 MLX 우선, 실패하면 Claude 폴백.
//
// 로컬은 mac 의 MLX 서버(Qwen3.6-35B-A3B)이고, VPS 에서는 mac 이 여는 SSH 역터널
// 덕분에 127.0.0.1:8080 으로 보인다(~/bin/mlx-tunnel.sh). 평소 추출은 전부 로컬에서
// 돌아 비용이 0 이고, mac 이 꺼졌거나 터널이 끊겼을 때만 Claude 로 넘어간다.
// 결제한 사용자가 mac 상태에 인질로 잡히지 않게 하려는 것이므로, 폴백을 지우려면
// 그 트레이드오프를 다시 판단해야 한다.
import Anthropic from "@anthropic-ai/sdk";

const LOCAL_URL = process.env.LLM_LOCAL_URL || "http://127.0.0.1:8080/v1/chat/completions";
const LOCAL_MODEL = process.env.LLM_LOCAL_MODEL || "local";
const FALLBACK_MODEL = process.env.LLM_FALLBACK_MODEL || "claude-haiku-4-5-20251001";

// 로컬은 생성이 직렬이라(서버가 단일 락) 큰 문서에서 분 단위가 될 수 있다.
// 타임아웃이 너무 짧으면 멀쩡한 추론을 죽이고 유료 폴백으로 새게 된다.
const LOCAL_TIMEOUT_MS = Number(process.env.LLM_LOCAL_TIMEOUT_MS || 180_000);

const FALLBACK_ENABLED = process.env.LLM_FALLBACK !== "off";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 관측용 카운터. /api/health 가 노출한다 — 폴백이 조용히 상시화되면
// "로컬로 바꿨다"는 말만 남고 실제로는 계속 과금되는 상태가 되기 때문이다.
export const llmStats = { local: 0, fallback: 0, failed: 0, lastFallbackReason: null, lastFallbackAt: 0 };

async function callLocal(prompt, maxTokens) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LOCAL_TIMEOUT_MS);
  try {
    const res = await fetch(LOCAL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LOCAL_MODEL,
        max_tokens: maxTokens,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`local LLM HTTP ${res.status}`);
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content;
    if (!text || !text.trim()) throw new Error("local LLM returned empty response");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function callFallback(prompt, maxTokens) {
  const message = await anthropic.messages.create({
    model: FALLBACK_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  const text = message.content[0]?.type === "text" ? message.content[0].text : "";
  if (!text) throw new Error("fallback LLM returned empty response");
  return text;
}

/**
 * 프롬프트를 돌려 원문 텍스트를 반환한다. 로컬 → (실패 시) Claude.
 * 둘 다 실패하면 throw 한다 — 호출부가 사용자용 에러로 바꾼다.
 */
export async function complete(prompt, maxTokens, logTag = "llm") {
  try {
    const text = await callLocal(prompt, maxTokens);
    llmStats.local++;
    return text;
  } catch (err) {
    const reason = err.name === "AbortError" ? `timeout after ${LOCAL_TIMEOUT_MS}ms` : err.message;
    if (!FALLBACK_ENABLED) {
      llmStats.failed++;
      console.error(`[${logTag}] local LLM failed and fallback is off: ${reason}`);
      throw err;
    }
    console.warn(`[${logTag}] local LLM failed (${reason}) — falling back to ${FALLBACK_MODEL}`);
    llmStats.fallback++;
    llmStats.lastFallbackReason = reason;
    llmStats.lastFallbackAt = Math.floor(Date.now() / 1000);
    try {
      return await callFallback(prompt, maxTokens);
    } catch (err2) {
      llmStats.failed++;
      throw err2;
    }
  }
}

/**
 * 모델 출력에서 JSON 객체를 꺼낸다.
 *
 * ⚠로컬 모델은 Claude 와 달리 ```json 펜스로 감싸는 일이 잦고, 뒤에 설명 문장을
 * 덧붙이기도 한다. 기존 코드의 `/\{[\s\S]*\}/` 는 탐욕적이라 대개 통했지만,
 * 본문 뒤에 중괄호가 하나라도 더 있으면 거기까지 삼켜 파싱이 깨진다.
 * 그래서 ①펜스를 먼저 벗기고 ②첫 `{` 부터 **짝이 맞는** `}` 까지만 자른다.
 * 문자열 리터럴 안의 중괄호는 세지 않는다 — H/P 문구에 실제로 들어온다.
 */
export function extractJson(raw) {
  if (!raw) return null;
  let s = raw.trim();

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const start = s.indexOf("{");
  if (start === -1) return null;

  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}
