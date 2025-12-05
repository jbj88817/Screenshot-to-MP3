import { app, BrowserWindow } from 'electron';
import path from 'node:path';

const SERVER_URL = process.env.APP_URL || 'http://localhost:3000';
let mainWindow;
let serverStarted = false;

function startServer() {
  if (serverStarted) return;
  serverStarted = true;
  // Importing spins up the Express server defined in dist/server.js
  import(path.join(process.cwd(), 'dist', 'server.js')).catch((err) => {
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

