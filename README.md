# Shot to MP3 (desktop wrapper)

## Prerequisites
- Node.js 18+ on macOS (`brew install node`)
- npm install: `npm install`

## Run the desktop app
```bash
npm run desktop
```
This builds the TypeScript backend, starts the internal Express server, and opens an Electron window pointing at the local UI.

## Run just the web server
```bash
npm run build
npm start
```

## Development notes
- Electron entry: `electron-main.js` (starts `dist/server.js` and loads `http://localhost:3000`).
- UI/HTTP server: `src/server.ts` serves `src/public/`.
- OCR/download logic: see `src/ocr.ts` and `src/downloader.ts`.

