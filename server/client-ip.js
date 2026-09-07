// 클라이언트 IP 판정. rate limit 버킷과 익명 무료한도 카운트의 키를 만드는
// 유일한 지점이라, 여기가 틀리면 두 방어가 동시에 무너진다. 테스트 가능하도록
// index.js 에서 떼어냈다(2026-09-07).

// 앞단에 Cloudflare 가 실제로 있을 때만 켠다. CF 는 자기가 프록시한 요청의
// cf-connecting-ip 를 엣지에서 덮어쓰고 클라이언트가 보낸 사본을 거부하므로,
// **CF 뒤에 있을 때만** 그 헤더가 신뢰할 수 있는 값이 된다.
const TRUST_CF_HEADER = process.env.TRUST_CF_HEADER === "1";

export function getClientIp(req) {
  // ⚠ XFF 첫 엔트리는 클라가 위조할 수 있다(Caddy 는 실제 peer 를 뒤에 append).
  //   위조 IP 로 무료한도·rate-limit·정산이 전부 우회되던 것을 막는다(2026-08-31 감사).
  //   신뢰 프록시(Caddy, 현재 단일 홉)가 붙인 마지막 엔트리가 진짜 client 다.
  //
  // ⚠ cf-connecting-ip 를 무조건 믿으면 안 된다(2026-09-07 수정). 위 주석이
  //   "앞단에 CF 를 두게 되면 우선한다(현재는 부재)"라고 스스로 밝혀 놓고도
  //   그 헤더를 최우선으로 읽고 있었다. CF 가 없으면 그 값은 100% 클라이언트가
  //   채우는 값이라, 매 요청 난수 IP 를 넣는 것만으로 rate limit 과 익명 무료
  //   3회 한도가 통째로 우회됐다. 라이브 대조 실측:
  //     헤더 없이 13회 → 404×10 후 429×3 (정상 차단)
  //     위조 헤더 13회 → 404×13 (차단 없음)
  //   한도 없는 익명 요청은 곧바로 MLX/Claude 폴백 과금과 phoenixd 인보이스
  //   남발로 이어진다. CF 를 실제로 앞단에 두면 TRUST_CF_HEADER=1 로 켠다.
  if (TRUST_CF_HEADER) {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf.trim()) return cf.trim();
  }
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string") {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.ip || (req.socket && req.socket.remoteAddress) || "";
}
