import test from "node:test";
import assert from "node:assert/strict";
import { pictogramsFromH, sortStatements, normalizePhone, mergeContinuations, normalizeGhsData } from "../server/ghs-normalize.js";

// MSDS 목록에서 경고표지를 만들며(2026-11-05) 찾은 것들을 AI 추출 경로에도 고정한다.

test("느낌표: 해골이 있으면 급성독성4 의 느낌표는 빠진다", () => {
  assert.deepEqual(pictogramsFromH(new Set(["H301", "H302"])), ["GHS06"]);
  assert.deepEqual(pictogramsFromH(new Set(["H302"])), ["GHS07"]);
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
