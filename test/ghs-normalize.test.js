import test from "node:test";
import assert from "node:assert/strict";
import { pictogramsFromH, sortStatements, normalizePhone, mergeContinuations, normalizeGhsData, DANGER_H } from "../server/ghs-normalize.js";

// MSDS 목록에서 경고표지를 만들며(2026-11-05) 찾은 것들을 AI 추출 경로에도 고정한다.

test("느낌표: 해골이 있으면 급성독성4 의 느낌표는 빠진다", () => {
  assert.deepEqual(pictogramsFromH(new Set(["H301", "H302"])), ["GHS06"]);
  assert.deepEqual(pictogramsFromH(new Set(["H302"])), ["GHS07"]);
});

test("느낌표: 해골이 있으면 이유가 무엇이든 느낌표는 붙지 않는다(고시 제6조의2 ② 1호)", () => {
  assert.deepEqual(pictogramsFromH(new Set(["H301", "H315", "H335"])), ["GHS06"]);
  assert.deepEqual(pictogramsFromH(new Set(["H331", "H317"])), ["GHS06"]);
  assert.deepEqual(pictogramsFromH(new Set(["H311", "H336", "H420"])), ["GHS06"]);
});

test("느낌표: 호흡기 과민이 있으면 피부·눈 자극의 느낌표도 빠진다(3호), H335 는 남는다", () => {
  assert.deepEqual(pictogramsFromH(new Set(["H334", "H315", "H319"])), ["GHS08"]);
  assert.deepEqual(pictogramsFromH(new Set(["H334", "H315", "H335"])), ["GHS07", "GHS08"]);
});

test("느낌표: 부식성이 있으면 피부·눈 자극의 느낌표는 빠지지만 H335 는 남는다", () => {
  assert.deepEqual(pictogramsFromH(new Set(["H318", "H315"])), ["GHS05"]);
  assert.deepEqual(pictogramsFromH(new Set(["H318", "H315", "H335"])), ["GHS05", "GHS07"]);
});

test("느낌표: 호흡기 과민(H334)이 있으면 피부 과민 H317 의 느낌표는 빠진다(용접봉)", () => {
  assert.deepEqual(pictogramsFromH(new Set(["H317", "H334", "H373"])), ["GHS08"]);
});

test("문구는 코드 번호순, 복합 코드는 앞 번호부터", () => {
  const got = sortStatements(["P501 폐기", "P301+P310 삼켰다면", "P210 열", "P301 ?", "메모"]);
  assert.deepEqual(got, ["P210 열", "P301 ?", "P301+P310 삼켰다면", "P501 폐기", "메모"]);
});

test("전화번호: 국내 번호는 첫 번호만 하이픈 표기, 아니면 띄어쓰기만", () => {
  assert.equal(normalizePhone("(031) 499 - 0394"), "031-499-0394");
  assert.equal(normalizePhone("0553455200"), "055-345-5200");
  assert.equal(normalizePhone("0222713032"), "02-2271-3032");
  assert.equal(normalizePhone("02.721.0800"), "02-721-0800");
  assert.equal(normalizePhone("TEL : 043)536-0161, FAX : 043)536-0162"), "043-536-0161");
  assert.equal(normalizePhone("080-727-7777 야간 : 070-7754-8699"), "080-727-7777");
  assert.equal(normalizePhone("031-467-6114 건축기술1팀 서원평"), "031-467-6114");
  assert.equal(normalizePhone("1588 - 0369"), "1588-0369");
  assert.equal(normalizePhone("+82 43 645 8840"), "+82 43 645 8840");
  assert.equal(normalizePhone(null), null);
});

test("갈라진 문구: 코드 없는 뒷부분은 문장으로 끝나지 않은 앞 문구에 붙는다", () => {
  assert.deepEqual(
    mergeContinuations(["P377 가스 누출 화재", "누출을 안전하게 막을 수 없다면, 불을 끄려하지 마시오.", "P381 누출 시 모든 점화원을 제거하시오."]),
    ["P377 가스 누출 화재: 누출을 안전하게 막을 수 없다면, 불을 끄려하지 마시오.", "P381 누출 시 모든 점화원을 제거하시오."],
  );
  assert.deepEqual(mergeContinuations(["P210 열을 피하시오.", "보관 메모"]), ["P210 열을 피하시오.", "보관 메모"]);
  assert.deepEqual(mergeContinuations(["메모", "P210 열"]), ["메모", "P210 열"]);
});

test("normalizeGhsData: AI 가 붙인 우선순위 위반 느낌표를 버리고, 12개 넘는 P 를 자르지 않는다", () => {
  const names = { GHS02: "인화성", GHS05: "부식성", GHS07: "유해성", GHS08: "건강유해성" };
  const p = Array.from({ length: 20 }, (_, i) => `P${200 + i} 문구`).reverse();
  const out = normalizeGhsData({
    pictograms: [{ code: "GHS07", name: "유해성" }, { code: "GHS05", name: "부식성" }],
    hazardStatements: ["H318 눈에 심한 손상", "H225 고인화성", "H315 자극"],
    precautionaryStatements: p,
    emergencyPhone: "02 - 1234",
  }, names);
  assert.deepEqual(out.pictograms.map((x) => x.code), ["GHS02", "GHS05"]);
  assert.deepEqual(out.hazardStatements.map((h) => h.slice(0, 4)), ["H225", "H315", "H318"]);
  assert.equal(out.precautionaryStatements.length, 20);
  assert.equal(out.precautionaryStatements[0], "P200 문구");
  assert.equal(out.emergencyPhone, "02-1234");
});

// 별표 2(「화학물질의 분류·표시 및 물질안전보건자료에 관한 기준」, 2026-11-13 원문 대조).
test("그림문자: H221(인화성 가스 구분 2)은 그림문자 없음, H220 은 불꽃", () => {
  assert.deepEqual(pictogramsFromH(new Set(["H221", "H280"])), ["GHS04"]);
  assert.deepEqual(pictogramsFromH(new Set(["H220", "H280"])), ["GHS02", "GHS04"]);
});

test("그림문자: H305(흡인 유해성 구분 2)는 건강 유해성, H232(자연발화성 가스)는 불꽃", () => {
  assert.deepEqual(pictogramsFromH(new Set(["H305"])), ["GHS08"]);
  assert.deepEqual(pictogramsFromH(new Set(["H232"])), ["GHS02"]);
});

test("그림문자: H221 뿐인데 AI 가 불꽃을 붙였으면 버린다", () => {
  const out = normalizeGhsData(
    { signalWord: "경고", pictograms: [{ code: "GHS02" }, { code: "GHS04" }], hazardStatements: ["H221 인화성 가스", "H280 고압가스"], precautionaryStatements: [] },
    { GHS02: "인화성", GHS04: "고압가스" }, { danger: "위험" });
  assert.deepEqual(out.pictograms.map((p) => p.code), ["GHS04"]);
});

test("신호어: 위험이 확정되는 H 코드가 있으면 AI 가 «경고» 를 내도 «위험»(제6조의2 ③)", () => {
  const base = { pictograms: [], precautionaryStatements: [] };
  const ko = (h, s) => normalizeGhsData({ ...base, signalWord: s, hazardStatements: h }, {}, { danger: "위험" }).signalWord;
  assert.equal(ko(["H225 고인화성 액체 및 증기", "H319 눈 자극"], "경고"), "위험");
  assert.equal(ko(["H301 삼키면 유독함"], "경고"), "위험");
  assert.equal(ko(["H226 인화성 액체 및 증기", "H319 눈 자극"], "경고"), "경고");
  // 구분에 따라 갈리는 코드(H228)만 있으면 코드로 못 정한다 — AI 값을 둔다.
  assert.equal(ko(["H228 인화성 고체"], "경고"), "경고");
  // 영어 라벨은 그 언어의 단어로.
  assert.equal(normalizeGhsData({ ...base, signalWord: "Warning", hazardStatements: ["H314 Causes severe skin burns"] }, {}, { danger: "Danger" }).signalWord, "Danger");
});

// 고시 별표 2: 폭발성 물질 등급 1.5(H205)의 그림문자는 폭탄이 아니라 «주황색 바탕에 숫자 1.5», 신호어는 위험.
test("H205(등급 1.5)는 폭탄 그림문자를 부르지 않는다", () => {
  assert.deepEqual(pictogramsFromH(new Set(["H205"])), []);
  assert.deepEqual(pictogramsFromH(new Set(["H204"])), ["GHS01"]);
  assert.equal(DANGER_H.has("H205"), true);
});

test("normalizeGhsData: 해골이 AI 가 명시한 쪽에서만 와도 최종 집합에서 느낌표는 빠진다(제6조의2 ② 1호)", () => {
  const out = normalizeGhsData({
    pictograms: [{ code: "GHS06", name: "x" }, { code: "GHS07", name: "y" }],
    hazardStatements: ["H315 피부에 자극을 일으킴"], // H 코드로는 느낌표만 나온다
    precautionaryStatements: [], signalWord: "경고", emergencyPhone: "",
  }, {});
  assert.deepEqual(out.pictograms.map((p) => p.code), ["GHS06"]);
});

test("normalizeGhsData: 부식성이 AI 가 명시한 쪽에서만 와도 자극성의 느낌표는 흡수된다(제6조의2 ② 2호)", () => {
  const base = { signalWord: "Warning", precautionaryStatements: [] };
  const codesOf = (o) => o.pictograms.map((p) => p.code);
  // 자극성(H315·H319)뿐 → 부식성만 남는다
  assert.deepEqual(codesOf(normalizeGhsData({ ...base, pictograms: [{ code: "GHS05", name: "c" }], hazardStatements: ["H315 skin", "H319 eye"] }, {})), ["GHS05"]);
  // 느낌표의 근거가 자극성 말고 더 있으면(H302·H335·H317) 2호가 흡수하지 못한다 → 둘 다
  for (const h of ["H302 swallowed", "H335 respiratory irritation", "H317 allergic skin reaction"]) {
    assert.deepEqual(codesOf(normalizeGhsData({ ...base, pictograms: [{ code: "GHS05", name: "c" }], hazardStatements: ["H315 skin", h] }, {})), ["GHS05", "GHS07"]);
  }
  // 부식성이 없으면 자극성은 느낌표다
  assert.deepEqual(codesOf(normalizeGhsData({ ...base, pictograms: [], hazardStatements: ["H315 skin"] }, {})), ["GHS07"]);
});
