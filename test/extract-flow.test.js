import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

// 추출 경로를 가짜 LLM 으로 끝까지 돌린다: 작은 PDF(공용 버퍼 풀), 무료 한도 경합, 운송 라벨의 문자열 불리언,
// 모양이 어긋난 문서 응답. 서버는 import 만으로 listen 하므로 자식 프로세스로 띄운다.

const ORIGIN = "https://ghs.txid.uk";

function tinyPdf(text) {
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    null,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  objs[3] = `<</Length ${stream.length}>>stream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj${o}endobj\n`; });
  const xref = out.length;
  out += `xref\n0 6\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer<</Size 6/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

test("추출 흐름: 작은 PDF·무료 한도 경합·운송 불리언·문서 모양", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghs-flow-"));
  const auth = new Database(path.join(tmp, "auth.db"));
  auth.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, pubkey TEXT); CREATE TABLE sessions(token TEXT PRIMARY KEY, user_id INTEGER, expires_at INTEGER);"
    + "INSERT INTO users VALUES(1,'pkbuyer'); INSERT INTO sessions VALUES('tokbuyer',1,unixepoch()+9999);"
    + ["mix", "nocred", "part", "short", "full", "race", "racetwo"].map((n, i) => `INSERT INTO users VALUES(${i + 2},'pk${n}'); INSERT INTO sessions VALUES('tok${n}',${i + 2},unixepoch()+9999);`).join(""));
  auth.close();
  // 크레딧을 먼저 산 새 계정 — 무료 3건을 아직 안 썼다.
  {
    const { db: seed } = (await import("../server/db.js")).createDb(path.join(tmp, "ghs.db"));
    seed.prepare("INSERT INTO credits (pubkey, amount, plan, plan_expires_at) VALUES ('pkbuyer', 5, 'credits', 0)").run();
    // 묶음 정산용 계정들: mix·nocred 는 무료 2건을 이미 썼다.
    for (const [pk, amount] of [["pkmix", 5], ["pkpart", 5], ["pkshort", 1], ["pkfull", 5], ["pkrace", 2], ["pkracetwo", 5]]) {
      seed.prepare("INSERT INTO credits (pubkey, amount, plan, plan_expires_at) VALUES (?, ?, 'credits', 0)").run(pk, amount);
    }
    for (const pk of ["pkmix", "pkmix", "pknocred", "pknocred"]) seed.prepare("INSERT INTO usage (pubkey, ip) VALUES (?, '10.9.9.9')").run(pk);
    seed.close();
  }

  // 프롬프트 안의 표식(MARK-xxxx)을 제품명으로 되돌려 준다 — 어느 PDF 의 본문이 LLM 에 갔는지 보인다.
  const llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const prompt = JSON.parse(body).messages.map((m) => m.content).join("\n");
      const mark = (prompt.match(/MARK-\w+/) || ["none"])[0];
      let out;
      if (prompt.includes("transport regulations")) {
        out = mark === "MARK-empty" ? {} : { productName: mark, unNumber: "UN1230", hazardClass: "3", notRegulated: "false", marinePollutant: "false" };
      } else if (prompt.includes("16-section")) {
        out = mark === "MARK-array" ? [1, 2] : { productName: mark, sections: { 1: null, 2: { title: 3, content: ["x"] } } };
      } else if (mark.startsWith("MARK-bad") || mark.endsWith("bad")) {
        out = {}; // 불완전한 응답 → 그 파일은 실패
      } else {
        out = { productName: mark, supplier: "s", signalWord: "DANGER", pictograms: [null, { code: "GHS02" }], hazardStatements: ["H225 x"], precautionaryStatements: [] };
      }
      setTimeout(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }));
      }, mark.startsWith("MARK-slow") ? 1500 : 300);
    });
  });
  llm.listen(0, "127.0.0.1");
  await once(llm, "listening");
  const probe = http.createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  probe.close();
  await once(probe, "close");

  const child = spawn(process.execPath, [fileURLToPath(new URL("../server/index.js", import.meta.url))], {
    env: { ...process.env, PORT: String(port), GHS_DB_PATH: path.join(tmp, "ghs.db"), AUTH_DB_PATH: path.join(tmp, "auth.db"), PHOENIXD_PASSWORD: "", LLM_FALLBACK: "off", LLM_LOCAL_URL: `http://127.0.0.1:${llm.address().port}/v1/chat/completions` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { child.kill(); llm.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 100 && !log.includes("Server running"); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(log, /Server running/, log);

  const filler = "safety data sheet section two hazard identification flammable liquid";
  const send = async (route, field, marks, ip, language = "en") => {
    const fd = new FormData();
    fd.append("language", language);
    for (const m of marks) fd.append(field, new Blob([tinyPdf(`MARK-${m} ${filler}`)], { type: "application/pdf" }), `${m}.pdf`);
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", body: fd, headers: { "x-forwarded-for": ip, origin: ORIGIN } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // 기동 직후의 작은 PDF 12건: 전부 파싱되고, 저마다 자기 본문이 LLM 에 간다(풀의 남의 바이트가 아니다).
  const first = await Promise.all(Array.from({ length: 12 }, (_, i) => send("/api/ghs/extract", "file", [`a${i}`], `10.1.0.${i}`)));
  first.forEach((r, i) => {
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.productName, `MARK-a${i}`);
  });
  // 신호어는 라벨 언어의 단어로, null 그림문자는 버린다.
  assert.equal(first[0].body.signalWord, "Danger");
  assert.deepEqual(first[0].body.pictograms.map((p) => p.code), ["GHS02"]);
  assert.equal((await send("/api/ghs/extract", "file", ["ko1"], "10.1.1.1", "ko")).body.signalWord, "위험");

  // 무료 한도 경합: 새 IP 가 3파일 요청 4개를 동시에 보내도 통과는 하나다.
  const burst = await Promise.all(Array.from({ length: 4 }, (_, i) => send("/api/ghs/extract-batch", "files", [`b${i}x`, `b${i}y`, `b${i}z`], "10.2.0.1")));
  assert.deepEqual(burst.map((r) => r.status).sort(), [200, 402, 402, 402]);

  // 크레딧을 먼저 산 계정도 무료 3건을 먼저 쓴다 — 예전엔 유료 사용이 usage 를 채워 무료분이 사라졌다.
  const asBuyer = async (mark) => {
    const fd = new FormData();
    fd.append("language", "en");
    fd.append("file", new Blob([tinyPdf(`MARK-${mark} ${filler}`)], { type: "application/pdf" }), `${mark}.pdf`);
    const r = await fetch(`http://127.0.0.1:${port}/api/ghs/extract`, { method: "POST", body: fd, headers: { "x-forwarded-for": "10.5.0.1", origin: ORIGIN, cookie: "txid_session=tokbuyer" } });
    return r.status;
  };
  const credits = () => {
    const d = new Database(path.join(tmp, "ghs.db"), { readonly: true });
    try { return d.prepare("SELECT amount FROM credits WHERE pubkey = 'pkbuyer'").get().amount; } finally { d.close(); }
  };
  for (const m of ["f1", "f2", "f3"]) assert.equal(await asBuyer(m), 200);
  assert.equal(credits(), 5, "무료 3건 동안 크레딧은 줄지 않는다");
  assert.equal(await asBuyer("p1"), 200);
  assert.equal(credits(), 4, "네 번째부터 크레딧을 쓴다");

  // 묶음: 남은 무료분을 먼저 쓰고 나머지만 크레딧으로 낸다(통째로 유료 처리하면 무료분이 사라졌다).
  const batchAs = async (who, marks) => {
    const fd = new FormData();
    fd.append("language", "en");
    for (const m of marks) fd.append("files", new Blob([tinyPdf(`MARK-${m} ${filler}`)], { type: "application/pdf" }), `${m}.pdf`);
    const r = await fetch(`http://127.0.0.1:${port}/api/ghs/extract-batch`, { method: "POST", body: fd, headers: { "x-forwarded-for": "10.6.0.1", origin: ORIGIN, cookie: `txid_session=tok${who}` } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const state = (who) => {
    const d = new Database(path.join(tmp, "ghs.db"), { readonly: true });
    try {
      return {
        credits: d.prepare("SELECT amount FROM credits WHERE pubkey = ?").get(`pk${who}`)?.amount ?? 0,
        used: d.prepare("SELECT COUNT(*) AS n FROM usage WHERE pubkey = ?").get(`pk${who}`).n,
        reserved: d.prepare("SELECT COUNT(*) AS n FROM reservations WHERE pubkey = ?").get(`pk${who}`).n,
      };
    } finally { d.close(); }
  };
  // 무료 1건 남음 + 크레딧 5, 2개 묶음 → 무료 1 + 유료 1
  assert.equal((await batchAs("mix", ["m1", "m2"])).status, 200);
  assert.deepEqual(state("mix"), { credits: 4, used: 4, reserved: 0 });
  // 무료분을 다 쓴 뒤의 2개 묶음 → 유료 2
  assert.equal((await batchAs("mix", ["m3", "m4"])).status, 200);
  assert.deepEqual(state("mix"), { credits: 2, used: 6, reserved: 0 });
  // 무료 1건 남음 + 크레딧 없음, 2개 묶음 → 402 이고 «소진» 이 아니라 남은 것을 알린다. 1개는 통과한다.
  const noCred = await batchAs("nocred", ["n1", "n2"]);
  assert.equal(noCred.status, 402);
  assert.match(noCred.body.message, /1 free extraction\(s\) left/);
  assert.equal(noCred.body.freeRemaining, 1);
  assert.deepEqual(state("nocred"), { credits: 0, used: 2, reserved: 0 });
  assert.equal((await batchAs("nocred", ["n3"])).status, 200);
  assert.equal(state("nocred").used, 3);
  // 새 계정 + 크레딧 5, 5개 묶음 중 2개 실패 → 성공 3건은 무료분이 메우고 예약한 2크레딧은 전액 환급
  assert.equal((await batchAs("part", ["q1", "bad1", "q2", "bad2", "q3"])).status, 200);
  assert.deepEqual(state("part"), { credits: 5, used: 3, reserved: 0 });
  // 새 계정 + 크레딧 1, 5개 묶음 → 무료 3 + 크레딧 1 로는 모자라 402, 아무것도 차감·기록하지 않는다
  const short = await batchAs("short", ["h1", "h2", "h3", "h4", "h5"]);
  assert.equal(short.status, 402);
  assert.match(short.body.message, /3 free extraction\(s\) and 1 credit\(s\) left/);
  assert.deepEqual(state("short"), { credits: 1, used: 0, reserved: 0 });
  // 새 계정 + 크레딧 5, 5개 묶음 전부 성공 → 무료 3 + 유료 2
  assert.equal((await batchAs("full", ["u1", "u2", "u3", "u4", "u5"])).status, 200);
  assert.deepEqual(state("full"), { credits: 3, used: 5, reserved: 0 });
  // 전부 실패 → 차감 0
  assert.equal((await batchAs("full", ["bad3", "bad4"])).status, 200);
  assert.deepEqual(state("full"), { credits: 3, used: 5, reserved: 0 });

  // 동시 요청: 무료분을 잡아 둔 요청이 실패해 무료분이 돌아오면, 그 사이 유료로 들어온 요청은 정산 때 무료로 돌린다.
  // 크레딧 2 인 새 계정 — A(2파일, 느림)·B(1파일, 실패)·C(1파일) 순으로 거의 동시에. 성공 3건 = 무료 3건이라 차감 0.
  const raceA = batchAs("race", ["slow1", "slow2"]);
  await new Promise((r) => setTimeout(r, 60));
  const raceB = batchAs("race", ["bad5"]);
  await new Promise((r) => setTimeout(r, 60));
  const raceC = batchAs("race", ["r1"]);
  const raced = await Promise.all([raceA, raceB, raceC]);
  assert.deepEqual(raced.map((r) => r.status), [200, 200, 200]);
  assert.deepEqual(state("race"), { credits: 2, used: 3, reserved: 0 });
  // 무료분을 다 쓴 뒤에는 정상으로 차감한다.
  assert.equal((await batchAs("race", ["r2"])).status, 200);
  assert.deepEqual(state("race"), { credits: 1, used: 4, reserved: 0 });

  // 반대 순서: 유료로 먼저 정산된 뒤에 무료분을 잡고 있던 요청이 실패해 돌려주면 그만큼 환급한다.
  // 크레딧 5 인 새 계정 — A(2파일, 느림, 1개 실패)·B(3파일). 성공 4건 = 무료 3 + 유료 1.
  const twoA = batchAs("racetwo", ["slowa", "slowbad"]);
  await new Promise((r) => setTimeout(r, 60));
  const twoB = batchAs("racetwo", ["t1", "t2", "t3"]);
  assert.deepEqual((await Promise.all([twoA, twoB])).map((r) => r.status), [200, 200]);
  assert.deepEqual(state("racetwo"), { credits: 4, used: 4, reserved: 0 });

  // 운송: "false" 문자열은 거짓이다. 빈 응답은 실패다.
  const tr = await send("/api/transport/extract", "file", ["t1"], "10.3.0.1");
  assert.equal(tr.status, 200);
  assert.equal(tr.body.notRegulated, false);
  assert.equal(tr.body.marinePollutant, false);
  assert.equal((await send("/api/transport/extract", "file", ["empty"], "10.3.0.2")).status, 400);

  // 문서: 섹션은 문자열로 맞추고, 배열 응답은 실패로 돌린다(성공으로 과금·저장하지 않는다).
  const sds = await send("/api/sds/convert-batch", "files", ["s1", "array"], "10.4.0.1");
  assert.equal(sds.status, 200);
  assert.deepEqual(sds.body[0].data.sections, { 1: { title: "", content: "" }, 2: { title: "3", content: '["x"]' } });
  assert.equal(sds.body[1].status, "error");
});
