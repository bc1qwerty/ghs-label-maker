# GHS Label Maker

## Language
- Respond in Korean (한국어로 응답)

## Description
GHS (Globally Harmonized System) hazard label generator. Full-stack app with a React frontend and Express + SQLite backend. Uses Claude API for AI-assisted label generation from SDS/PDF documents.

## Tech Stack
- **Frontend**: React 19, TypeScript, Vite 7, Tailwind CSS 4, Radix UI, Framer Motion
- **Backend**: Express 5, better-sqlite3, Multer (file upload), pdf-parse
- **AI**: 로컬 MLX(mac, Qwen3.6-35B-A3B) 우선 + Claude Haiku 폴백 (`server/llm.js`)
- **Export**: jsPDF, html-to-image for label generation
- **Routing**: Wouter

## Key Files
- `src/` -- React frontend (App.tsx, components/, hooks/, pages/)
- `server/index.js` -- Express API server (port 3100)
- `server/ghs.ts` -- GHS data logic
- `server/ghs.db` -- SQLite database
- `vite.config.ts` -- Vite config with proxy to backend
- `public/` -- Static assets (GHS pictograms)

## Build & Run
```bash
npm run dev       # Vite dev server (port 5173, proxies /api to :3100)
npm run server    # Express backend (port 3100)
npm run build     # Production build
npm run start     # Build + start server
```

## Environment Variables
- `ANTHROPIC_API_KEY` -- 폴백 전용. 평소 추출은 로컬 MLX 로 돌아 호출되지 않는다
- `LLM_LOCAL_URL` -- 기본 `http://127.0.0.1:8080/v1/chat/completions`
- `LLM_LOCAL_TIMEOUT_MS` -- 기본 180000 (로컬은 생성이 직렬이라 넉넉히)
- `LLM_FALLBACK=off` -- 폴백을 끄고 로컬 전용으로 (기본은 켜짐)

## AI 경로 (2026-08-21)
추출은 **mac 의 로컬 MLX 서버**에서 돈다. 앱은 VPS 에 있으므로 mac 이 여는 SSH
역터널(`~/bin/mlx-tunnel.sh`, launchd `uk.txid.mlx-tunnel`)을 통해 VPS 의
`127.0.0.1:8080` 으로 보인다. 실패하면 Claude Haiku 로 폴백한다 — 결제한
사용자가 mac 상태에 인질로 잡히지 않게 하려는 것이다.

⚠**폴백은 조용하다.** 로컬이든 Claude 든 정상 JSON 을 돌려주므로 응답만 봐서는
구분이 안 된다. `/api/health` 의 `llm` 카운터(`local`/`fallback`/`failed`)를 볼 것.
`fallback` 이 계속 오르고 있으면 터널이 끊긴 것이고, 그동안 과금되고 있다.

⚠**`deploy.sh` 는 서버 파일을 이름으로 하나씩 올린다.** `server/` 에 모듈을
추가하면 그 목록에 넣어야 한다. 안 그러면 VPS 가 import 실패로 못 뜬다.

## Status
- ghs.txid.uk 라이브 운영 (VPS pm2 ghs-label, port 3100, Lightning 결제 활성). 배포는 ./deploy.sh 단일 경로 (VPS는 non-git)
- **크레딧은 만료되지 않는다** (2026-08-21). 횟수제 팩을 사서 다 쓸 때까지 보유한다.
