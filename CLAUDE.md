# GHS Label Maker

## Language
- Respond in Korean (한국어로 응답)

## Description
GHS (Globally Harmonized System) hazard label generator. Full-stack app with a React frontend and Express + SQLite backend. Uses Claude API for AI-assisted label generation from SDS/PDF documents.

## Tech Stack
- **Frontend**: React 19, TypeScript, Vite 7, Tailwind CSS 4, Radix UI, Framer Motion
- **Backend**: Express 5, better-sqlite3, Multer (file upload), pdf-parse
- **AI**: Anthropic Claude SDK for SDS analysis
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
- `ANTHROPIC_API_KEY` -- Required for AI-powered SDS analysis

## Status
- Development complete, local use
