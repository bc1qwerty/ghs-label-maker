// AI 가 돌려준 라벨 데이터를 규칙으로 다듬는다. AI 의 판단에 맡기면 안 되는 것만 여기서 고정한다.
// 같은 규칙을 MSDS 목록(~/projects/msds, msds.py)의 경고표지 생성도 쓴다 — 한쪽만 고치지 말 것.

// H 코드 → 그림문자. 느낌표(GHS07)는 아래 우선순위로 따로 정한다.
const H_TO_PICTOGRAM = {
  GHS01: ["H200", "H201", "H202", "H203", "H204", "H205", "H240", "H241"],
  GHS02: ["H220", "H221", "H222", "H223", "H224", "H225", "H226", "H228", "H241", "H242", "H250", "H251", "H252", "H260", "H261"],
  GHS03: ["H270", "H271", "H272"],
  GHS04: ["H280", "H281"],
  GHS05: ["H290", "H314", "H318"],
  GHS06: ["H300", "H301", "H310", "H311", "H330", "H331"],
  GHS08: ["H304", "H334", "H340", "H341", "H350", "H351", "H360", "H361", "H370", "H371", "H372", "H373"],
  GHS09: ["H400", "H410", "H411"],
};
// UN GHS 1.4.10.5.3.1: 느낌표는 그것을 부른 H 코드가 다른 그림문자에 흡수되지 않을 때만 붙는다.
const ACUTE_TOX4 = ["H302", "H312", "H332"]; // 해골(GHS06)이 있으면 흡수
const IRRITATION = ["H315", "H319"]; // 부식성(GHS05) 또는 호흡기 과민(H334)이 있으면 흡수
const SKIN_SENS = ["H317"]; // 호흡기 과민(H334)이 있으면 흡수
const ALWAYS_07 = ["H335", "H336", "H420"];

const codesOf = (stmt) => (String(stmt).match(/[HP]\d{3}/g) || []);
const codeKey = (stmt) => codesOf(stmt).map((c) => Number(c.slice(1)));

export function hCodes(statements) {
  return new Set(statements.flatMap((s) => codesOf(s).filter((c) => c.startsWith("H"))));
}

export function pictogramsFromH(codes) {
  const has = (list) => list.some((c) => codes.has(c));
  const out = Object.entries(H_TO_PICTOGRAM).filter(([, list]) => has(list)).map(([g]) => g);
  const need07 = has(ALWAYS_07)
    || (has(ACUTE_TOX4) && !out.includes("GHS06"))
    || (has(IRRITATION) && !out.includes("GHS05") && !codes.has("H334"))
    || (has(SKIN_SENS) && !codes.has("H334"));
  if (need07) out.push("GHS07");
  return out.sort();
}

// 코드 번호순(P301+P310 은 301,310 순으로 비교). 코드가 없는 문구는 원래 순서대로 맨 뒤.
export function sortStatements(statements) {
  return statements
    .map((s, i) => ({ s, i, k: codeKey(s) }))
    .sort((a, b) => {
      if (!a.k.length || !b.k.length) return (a.k.length ? -1 : b.k.length ? 1 : a.i - b.i);
      for (let j = 0; j < Math.max(a.k.length, b.k.length); j++) {
        const d = (a.k[j] ?? -1) - (b.k[j] ?? -1);
        if (d) return d;
      }
      return a.i - b.i;
    })
    .map((x) => x.s);
}

// PDF 표에서 온 「(031) 499 - 0394」 같은 띄어쓰기
export function normalizePhone(phone) {
  return phone ? String(phone).replace(/\s*-\s*/g, "-").replace(/\s+/g, " ").trim() : phone;
}

/** names: { GHS01: "폭발성", … } 라벨 언어의 그림문자 이름 */
export function normalizeGhsData(data, names) {
  const hazards = sortStatements(data.hazardStatements);
  const codes = hCodes(hazards);
  let pictograms = data.pictograms;
  if (codes.size) {
    // H 코드가 있으면 그림문자는 H 코드에서 정한다. AI 가 명시한 것 중 H 코드로 설명 안 되는
    // 느낌표는 우선순위 위반이라 버리고, 나머지는 놓친 H 코드가 있을 수 있어 남긴다.
    const derived = pictogramsFromH(codes);
    const extra = data.pictograms.map((p) => p.code).filter((c) => c !== "GHS07" && !derived.includes(c));
    pictograms = [...new Set([...derived, ...extra])].sort().map((code) => ({ code, name: names[code] ?? code }));
  }
  return {
    ...data,
    pictograms,
    hazardStatements: hazards,
    precautionaryStatements: sortStatements(data.precautionaryStatements),
    emergencyPhone: normalizePhone(data.emergencyPhone),
  };
}
