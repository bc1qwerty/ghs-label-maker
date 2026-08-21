import test from "node:test";
import assert from "node:assert/strict";
import { extractJson } from "../server/llm.js";

// 로컬 MLX(Qwen3.6)로 옮기면서 파싱이 바뀐 이유:
// Claude 는 프롬프트대로 JSON 만 뱉었지만 로컬 모델은 ```json 펜스로 감싸고
// 앞뒤에 문장을 붙이는 일이 잦다. 아래 케이스들은 실제 출력에서 온 것이다.

test("extractJson: ```json 펜스로 감싼 출력", () => {
  const raw = '```json\n{"productName":"아세톤","signalWord":"위험"}\n```';
  assert.deepEqual(extractJson(raw), { productName: "아세톤", signalWord: "위험" });
});

test("extractJson: 펜스에 언어 태그가 없는 경우", () => {
  assert.deepEqual(extractJson('```\n{"a":1}\n```'), { a: 1 });
});

test("extractJson: JSON 앞뒤에 설명 문장이 붙은 경우", () => {
  const raw = 'Here is the extracted data:\n{"a":1}\nLet me know if you need more.';
  assert.deepEqual(extractJson(raw), { a: 1 });
});

test("extractJson: 뒤에 중괄호가 더 있어도 첫 객체만 가져온다", () => {
  // 기존 /\{[\s\S]*\}/ 는 탐욕적이라 여기서 끝 중괄호까지 삼켜 파싱이 깨졌다.
  const raw = '{"a":1}\n\nNote: the schema is {key: value}.';
  assert.deepEqual(extractJson(raw), { a: 1 });
});

test("extractJson: 중첩 객체와 배열", () => {
  const raw = '{"pictograms":[{"code":"GHS02","name":"인화성"}],"cas":null}';
  assert.deepEqual(extractJson(raw), {
    pictograms: [{ code: "GHS02", name: "인화성" }],
    cas: null,
  });
});

test("extractJson: 문자열 안의 중괄호를 깊이로 세지 않는다", () => {
  // H/P 문구에 실제로 중괄호가 들어오는 일이 있다.
  const raw = '{"h":"경고 {주의} 문구","n":2}';
  assert.deepEqual(extractJson(raw), { h: "경고 {주의} 문구", n: 2 });
});

test("extractJson: 이스케이프된 따옴표가 문자열을 끝내지 않는다", () => {
  const raw = '{"s":"그는 \\"위험\\"이라고 했다","n":1}';
  assert.deepEqual(extractJson(raw), { s: '그는 "위험"이라고 했다', n: 1 });
});

test("extractJson: 잘린 JSON 은 null (호출부가 사용자 에러로 바꾼다)", () => {
  assert.equal(extractJson('{"a":1,"b":'), null);
});

test("extractJson: JSON 이 아예 없으면 null", () => {
  assert.equal(extractJson("I could not find any hazard data."), null);
  assert.equal(extractJson(""), null);
  assert.equal(extractJson(null), null);
});
