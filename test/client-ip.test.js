import test from "node:test";
import assert from "node:assert/strict";

// getClientIp 게이트. 이 함수 하나가 rate limit 버킷과 익명 무료한도(FREE_LIMIT)
// 카운트의 키를 동시에 만든다 — 틀리면 두 방어가 함께 무너진다.
//
// ⚠ 2026-09-07 사고: cf-connecting-ip 를 무조건 최우선으로 신뢰하고 있었다.
//   ghs.txid.uk 앞에는 Cloudflare 가 없고 Caddy 가 직접 종단하므로 그 헤더는
//   100% 클라이언트가 채우는 값이었다. 라이브 대조 실측에서 헤더 없이 13회는
//   10회 뒤 429 로 막혔지만, 매번 다른 CF-Connecting-IP 를 붙인 13회는 전부
//   통과했다. 한도 없는 익명 요청은 그대로 LLM 과금과 인보이스 남발이 된다.
//
// 모듈이 TRUST_CF_HEADER 를 로드 시점에 한 번 읽으므로, 두 모드를 각각
// 독립된 import 로 확인한다(쿼리스트링으로 캐시를 우회).
// ⚠ env 복원은 import 를 **await 한 뒤에** 해야 한다. 동적 import 는 비동기라
//   먼저 되돌리면 모듈이 평가될 때 이미 원래 값으로 돌아가 있다(이 파일을 처음
//   쓸 때 정확히 그 함정에 걸려 테스트가 거짓 실패했다).
const load = async (trust) => {
  const prev = process.env.TRUST_CF_HEADER;
  if (trust) process.env.TRUST_CF_HEADER = "1";
  else delete process.env.TRUST_CF_HEADER;
  try {
    return await import(`../server/client-ip.js?trust=${trust ? 1 : 0}`);
  } finally {
    if (prev === undefined) delete process.env.TRUST_CF_HEADER;
    else process.env.TRUST_CF_HEADER = prev;
  }
};

const req = (headers) => ({ headers, ip: "10.0.0.1", socket: { remoteAddress: "10.0.0.1" } });

test("CF 미사용(기본): 위조 cf-connecting-ip 는 무시하고 XFF 마지막 홉을 쓴다", async () => {
  const { getClientIp } = await load(false);
  const real = getClientIp(req({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }));
  assert.equal(real, "203.0.113.9");

  // 위조 헤더를 얹어도 키가 바뀌면 안 된다 — 바뀌면 매 요청 새 버킷이 된다.
  for (const forged of ["203.0.113.1", "203.0.113.2", "8.8.8.8"]) {
    const got = getClientIp(req({ "cf-connecting-ip": forged, "x-forwarded-for": "1.1.1.1, 203.0.113.9" }));
    assert.equal(got, real, `위조 ${forged} 가 버킷 키를 바꿨다`);
  }
});

test("CF 미사용: XFF 첫 엔트리(클라 위조 가능)를 쓰지 않는다", async () => {
  const { getClientIp } = await load(false);
  assert.equal(getClientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" })), "203.0.113.9");
});

test("CF 미사용: 헤더가 전혀 없으면 소켓 주소로 떨어진다", async () => {
  const { getClientIp } = await load(false);
  assert.equal(getClientIp(req({})), "10.0.0.1");
});

test("TRUST_CF_HEADER=1 일 때만 cf-connecting-ip 를 신뢰한다", async () => {
  const { getClientIp } = await load(true);
  assert.equal(getClientIp(req({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "1.1.1.1, 9.9.9.9" })), "203.0.113.7");
  // 켜져 있어도 헤더가 없으면 XFF 마지막 홉으로 간다.
  assert.equal(getClientIp(req({ "x-forwarded-for": "1.1.1.1, 9.9.9.9" })), "9.9.9.9");
});
