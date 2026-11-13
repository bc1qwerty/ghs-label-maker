// AI 가 돌려준 라벨 데이터를 규칙으로 다듬는다. AI 의 판단에 맡기면 안 되는 것만 여기서 고정한다.
// 같은 규칙을 MSDS 목록(~/projects/msds, msds.py)의 경고표지 생성도 쓴다 — 한쪽만 고치지 말 것.

// H 코드 → 그림문자. 느낌표(GHS07)는 아래 우선순위로 따로 정한다.
// 근거: 「화학물질의 분류·표시 및 물질안전보건자료에 관한 기준」 별표 2(고시 제2026-26호, 2026-11-13 대조).
//   ⚠ H221(인화성 가스 구분 2)은 그림문자 «없음» — UN GHS 판에 따라 불꽃을 붙이기도 하지만 국내 표는 없다.
//   H232(자연발화성 가스)는 불꽃, H305(흡인 유해성 구분 2)는 건강 유해성(구분 1 의 H304 와 같다).
//   ⚠ H205(폭발성 물질 등급 1.5)는 폭탄 그림이 아니라 «주황색 바탕에 숫자 1.5» 다 — 이 앱에 그 그림이 없으므로
//   GHS01 에 넣지 않는다(신호어는 «위험» 그대로).
const H_TO_PICTOGRAM = {
  GHS01: ["H200", "H201", "H202", "H203", "H204", "H240", "H241"],
  GHS02: ["H220", "H222", "H223", "H224", "H225", "H226", "H228", "H232", "H241", "H242", "H250", "H251", "H252", "H260", "H261"],
  GHS03: ["H270", "H271", "H272"],
  GHS04: ["H280", "H281"],
  GHS05: ["H290", "H314", "H318"],
  GHS06: ["H300", "H301", "H310", "H311", "H330", "H331"],
  GHS08: ["H304", "H305", "H334", "H340", "H341", "H350", "H351", "H360", "H361", "H370", "H371", "H372", "H373"],
  GHS09: ["H400", "H410", "H411"],
};
// 그림문자 우선순위 — 같은 고시 제6조의2 ②:
//   1호 «해골과 Ⅹ자형 뼈» 와 «감탄부호(!)» 에 모두 해당되면 해골만 표시한다. 급성 독성 구분 4 뿐 아니라
//       느낌표를 부른 이유가 무엇이든(H335·H315 등) 해골이 있으면 느낌표는 붙이지 않는다.
//   2호 부식성과 피부·눈 자극성에 모두 해당되면 부식성만 — 자극성(H315·H319)은 느낌표를 부르지 못한다.
//   3호 호흡기 과민성과 피부 과민성·피부 자극성·눈 자극성에 모두 해당되면 호흡기 과민성만.
//   4호(5개 이상이면 4개만 «표시할 수 있다»)는 선택 규정이라 적용하지 않는다.
const ACUTE_TOX4 = ["H302", "H312", "H332"];
const IRRITATION = ["H315", "H319"]; // 부식성(GHS05) 또는 호흡기 과민(H334)이 있으면 흡수
const SKIN_SENS = ["H317"]; // 호흡기 과민(H334)이 있으면 흡수
const ALWAYS_07 = ["H335", "H336", "H420"];

// 신호어 «위험» 이 확정되는 H 코드(별표 2). 구분에 따라 위험·경고가 갈리는 코드(H228·H242·H261·H272)는
// 코드만으로 정할 수 없어 넣지 않는다. 하나라도 있으면 신호어는 «위험» 이다 — «위험과 경고에 모두 해당되는 경우에는
// "위험"만을 표시한다»(같은 고시 제6조의2 ③). AI 가 «경고» 를 냈거나 비웠어도 올린다(낮춰 표시하지 않게).
export const DANGER_H = new Set([
  "H200", "H201", "H202", "H203", "H205", "H220", "H222", "H224", "H225", "H232", "H240", "H241", "H250", "H251",
  "H260", "H270", "H271", "H300", "H301", "H304", "H310", "H311", "H314", "H318", "H330", "H331", "H334", "H340",
  "H350", "H360", "H370", "H372",
]);

const codesOf = (stmt) => (String(stmt).match(/[HP]\d{3}/g) || []);
const codeKey = (stmt) => codesOf(stmt).map((c) => Number(c.slice(1)));

export function hCodes(statements) {
  return new Set(statements.flatMap((s) => codesOf(s).filter((c) => c.startsWith("H"))));
}

export function pictogramsFromH(codes) {
  const has = (list) => list.some((c) => codes.has(c));
  const out = Object.entries(H_TO_PICTOGRAM).filter(([, list]) => has(list)).map(([g]) => g);
  const need07 = !out.includes("GHS06") && (
    has(ALWAYS_07)
    || has(ACUTE_TOX4)
    || (has(IRRITATION) && !out.includes("GHS05") && !codes.has("H334"))
    || (has(SKIN_SENS) && !codes.has("H334"))
  );
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

// PDF 표에서 한 문구가 두 줄로 갈라져 뒷부분이 코드 없이 온다(「P377 가스 누출 화재」 + 「누출을 안전하게
// 막을 수 없다면, …」). 앞 문구가 문장으로 끝나지 않았을 때만 붙인다. 원래 코드 없는 문구는 그대로 둔다.
export function mergeContinuations(statements) {
  const out = [];
  for (const s of statements) {
    const prev = out[out.length - 1];
    if (prev && !codesOf(s).length && codesOf(prev).length && !/[.。]\s*$|(오|다|것)\s*$/.test(prev)) {
      out[out.length - 1] = `${prev.replace(/[:：]?\s*$/, "")}: ${s.trim()}`;
    } else {
      out.push(s);
    }
  }
  return out;
}

// 국내 번호는 첫 번호만 하이픈으로: 「(031) 499 - 0394」 「0553455200」 「02.721.0800」
// 「TEL : 043)536-0161, FAX : …」 「080-727-7777 야간 : 070-…」 「031-467-6114 건축기술1팀」.
// 국내 번호로 읽히지 않으면 하이픈 주변 띄어쓰기만 다듬는다.
export function normalizePhone(phone) {
  if (!phone) return phone;
  const s = String(phone);
  const m = s.match(/(?<!\d)(?:\(?0\d{1,2}\)?[\s.)-]*\d{3,4}[\s.-]*\d{4}|1[5-8]\d{2}[\s.-]*\d{4})(?!\d)/);
  if (m) {
    const d = m[0].replace(/\D/g, "");
    if (/^1[5-8]\d{6}$/.test(d)) return `${d.slice(0, 4)}-${d.slice(4)}`;
    const area = d.startsWith("02") ? 2 : 3;
    const rest = d.slice(area);
    if (rest.length === 7 || rest.length === 8) return `${d.slice(0, area)}-${rest.slice(0, -4)}-${rest.slice(-4)}`;
  }
  return s.replace(/\s*-\s*/g, "-").replace(/\s+/g, " ").trim();
}

/** names: { GHS01: "폭발성", … } 라벨 언어의 그림문자 이름. danger: 라벨 언어의 «위험»(없으면 신호어를 손대지 않는다) */
export function normalizeGhsData(data, names, { danger } = {}) {
  const hazards = sortStatements(mergeContinuations(data.hazardStatements));
  const codes = hCodes(hazards);
  let pictograms = data.pictograms;
  if (codes.size) {
    // H 코드가 있으면 그림문자는 H 코드에서 정한다. AI 가 명시한 것 중 H 코드로 설명 안 되는
    // 느낌표는 우선순위 위반이라 버리고, 나머지는 놓친 H 코드가 있을 수 있어 남긴다.
    const derived = pictogramsFromH(codes);
    // 불꽃의 근거가 H221(인화성 가스 구분 2, 그림문자 없음)뿐이면 AI 가 붙인 불꽃도 버린다.
    const flameOnlyFromH221 = codes.has("H221") && !derived.includes("GHS02");
    // 폭탄의 근거가 H205(등급 1.5, 주황 바탕 숫자)뿐일 때도 같다.
    const bombOnlyFromH205 = codes.has("H205") && !derived.includes("GHS01");
    const extra = data.pictograms.map((p) => p.code)
      .filter((c) => c !== "GHS07" && !derived.includes(c)
        && !(c === "GHS02" && flameOnlyFromH221) && !(c === "GHS01" && bombOnlyFromH205));
    pictograms = [...new Set([...derived, ...extra])].sort().map((code) => ({ code, name: names[code] ?? code }));
  }
  const signalWord = danger && [...codes].some((c) => DANGER_H.has(c)) ? danger : data.signalWord;
  return {
    ...data,
    signalWord,
    pictograms,
    hazardStatements: hazards,
    precautionaryStatements: sortStatements(mergeContinuations(data.precautionaryStatements)),
    emergencyPhone: normalizePhone(data.emergencyPhone),
  };
}
