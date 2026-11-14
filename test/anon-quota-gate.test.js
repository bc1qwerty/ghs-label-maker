import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createDb } from "../server/db.js";

// anonQuotaGate 는 미들웨어 «순서» 가 전부다(multer 보다 앞). 그래서 실제 서버를 임시 DB 로 띄워 본다.
// LLM 까지 가는 요청은 보내지 않는다 — 파일 없는 요청(400)으로 «게이트를 지났다» 를 본다.

const ROUTES = [
  ["/api/ghs/extract", "file"], ["/api/ghs/extract-batch", "files"],
  ["/api/transport/extract", "file"], ["/api/transport/extract-batch", "files"],
  ["/api/dgd/extract-batch", "files"], ["/api/sds/convert-batch", "files"], ["/api/un383/extract-batch", "files"],
];
const ORIGIN = "https://ghs.txid.uk";

async function freePort() {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const { port } = srv.address();
  srv.close();
  await once(srv, "close");
  return port;
}

test("anonQuotaGate: 무료 한도를 다 쓴 익명 IP 는 업로드 7개 라우트 모두 본문을 읽기 전에 402", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghs-gate-"));
  const dbPath = path.join(tmp, "ghs.db");
  const authPath = path.join(tmp, "auth.db");
  const auth = new Database(authPath);
  auth.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, pubkey TEXT);
    CREATE TABLE sessions(token TEXT PRIMARY KEY, user_id INTEGER, expires_at INTEGER);
    INSERT INTO users VALUES(1,'pkfree');
    INSERT INTO sessions VALUES('tokfree',1,unixepoch()+9999),('tokexp',1,unixepoch()-10);`);
  auth.close();
  const { db, stmts } = createDb(dbPath);
  const SPENT = "10.9.9.9";
  for (let i = 0; i < 3; i++) stmts.recordUsage.run(null, SPENT);
  for (let i = 0; i < 2; i++) stmts.recordUsage.run(null, "10.8.8.8");
  db.close();

  const port = await freePort();
  const child = spawn(process.execPath, [fileURLToPath(new URL("../server/index.js", import.meta.url))], {
    env: { ...process.env, PORT: String(port), GHS_DB_PATH: dbPath, AUTH_DB_PATH: authPath, PHOENIXD_PASSWORD: "", LLM_FALLBACK: "off", LLM_LOCAL_URL: "http://127.0.0.1:9/none" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { child.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 100 && !log.includes("Server running"); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(log, /Server running/, log);

  const post = async (route, field, { ip, cookie, big = 0 } = {}) => {
    const fd = new FormData();
    fd.append("language", "en");
    if (big) fd.append(field, new Blob([Buffer.alloc(big)], { type: "application/pdf" }), "big.pdf");
    const headers = { "x-forwarded-for": ip, origin: ORIGIN };
    if (cookie) headers.cookie = `txid_session=${cookie}`;
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", body: fd, headers });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  for (const [route, field] of ROUTES) {
    const spent = await post(route, field, { ip: SPENT });
    assert.equal(spent.status, 402, route);
    assert.equal(spent.body.needsLogin, true, route);
    // 한도가 남은 IP·새 IP 는 게이트를 지나 파일 검사(400)까지 간다.
    assert.equal((await post(route, field, { ip: "10.8.8.8" })).status, 400, route);
    assert.equal((await post(route, field, { ip: "10.0.0.1" })).status, 400, route);
    // 같은(소진된) IP 여도 로그인한 사람은 막지 않는다. 만료 세션은 익명이다.
    assert.equal((await post(route, field, { ip: SPENT, cookie: "tokfree" })).status, 400, route);
    assert.equal((await post(route, field, { ip: SPENT, cookie: "tokexp" })).status, 402, route);
  }
  // 순서 확인: multer 한도(10MB)를 넘는 파일이어도 402 다 — 게이트가 multer 뒤라면 업로드 오류가 먼저 난다.
  const big = await post("/api/ghs/extract-batch", "files", { ip: SPENT, big: 11 * 1024 * 1024 });
  assert.equal(big.status, 402);
  assert.notEqual((await post("/api/ghs/extract-batch", "files", { ip: "10.0.0.2", big: 11 * 1024 * 1024 })).status, 402);
});
