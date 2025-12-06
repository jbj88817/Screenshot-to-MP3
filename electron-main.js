import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function ensureToolPath() {
  const extras = ['/opt/homebrew/bin', '/usr/local/bin'];
  const current = process.env.PATH || '';
  const parts = current.split(':').filter(Boolean);
  const merged = [...extras, ...parts.filter((p) => !extras.includes(p))];
  process.env.PATH = merged.join(':');
}

const SERVER_URL = process.env.APP_URL || 'http://localhost:3000';
let mainWindow;
let serverStarted = false;

ensureToolPath();

function ensureUploadDir() {
  // Use userData so the packaged app has a writable location
  const dir = process.env.APP_UPLOAD_DIR || path.join(app.getPath('userData'), 'uploads');
  if (!process.env.APP_UPLOAD_DIR) process.env.APP_UPLOAD_DIR = dir;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function startServer() {
  if (serverStarted) return;
  serverStarted = true;
  ensureUploadDir();
  const appRoot = app.getAppPath();
  if (!process.env.APP_ROOT) process.env.APP_ROOT = appRoot;
  const serverEntry = path.join(appRoot, 'dist', 'server.js');
  // Importing spins up the Express server defined in dist/server.js
  import(pathToFileURL(serverEntry).toString()).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start internal server', err);
  });
}

async function waitForServer(url, attempts = 30, delayMs = 250) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) return true;
    } catch {
      // ignore and retry
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function createWindow() {
  startServer();
  await waitForServer(SERVER_URL);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Shot to MP3',
    webPreferences: {
      nodeIntegration: false,
    },
  });

  await mainWindow.loadURL(SERVER_URL);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) mainWindow.focus();
  });

  app.whenReady().then(createWindow);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
}

