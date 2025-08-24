import express, { type Request, type Response } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { extractTracksFromImage } from './ocr.js';
import { downloadTracksZip, downloadTracksZipWithProgress, downloadSingleWithProgress, type ProgressUpdate } from './downloader.js';
import crypto from 'node:crypto';

const app = express();
const upload = multer({ dest: path.join(process.cwd(), 'uploads') });

app.use(express.json({ limit: '2mb' }));
app.use('/static', express.static(path.join(process.cwd(), 'src/public')));

app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), 'src/public/index.html'));
});

app.post('/api/ocr', upload.single('image'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }
    const imagePath = req.file.path;
    const tracks = await extractTracksFromImage(imagePath);
    // cleanup upload
    fs.unlink(imagePath, () => {});
    res.json({ tracks });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'OCR failed' });
  }
});

app.post('/api/download', async (req: Request, res: Response) => {
  try {
    const { tracks } = req.body as { tracks: string[] };
    if (!Array.isArray(tracks) || tracks.length === 0) {
      return res.status(400).json({ error: 'tracks[] required' });
    }
    const { zipPath, filename } = await downloadTracksZip(tracks);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const stream = fs.createReadStream(zipPath);
    stream.on('close', () => fs.unlink(zipPath, () => {}));
    stream.pipe(res);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Download failed' });
  }
});

type JobState = {
  id: string;
  tracks: string[];
  updates: ProgressUpdate[];
  done: boolean;
  zipPath?: string;
  filename?: string;
  error?: string;
};

const jobs = new Map<string, JobState>();

app.post('/api/jobs', async (req: Request, res: Response) => {
  const { tracks } = req.body as { tracks: string[] };
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return res.status(400).json({ error: 'tracks[] required' });
  }
  const id = crypto.randomUUID();
  const job: JobState = { id, tracks, updates: [], done: false };
  jobs.set(id, job);
  // fire and forget
  void (async () => {
    try {
      const result = await downloadTracksZipWithProgress(tracks, (u) => {
        job.updates.push(u);
      });
      job.zipPath = result.zipPath;
      job.filename = result.filename;
      job.done = true;
    } catch (e: any) {
      job.error = e?.message || 'Job failed';
      job.done = true;
    }
  })();
  res.json({ id });
});

app.get('/api/jobs/:id', (req: Request, res: Response) => {
  const id: string = req.params.id as string;
  const job = jobs.get(id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json({ id: job.id, updates: job.updates, done: job.done, error: job.error });
});

app.get('/api/jobs/:id/download', (req: Request, res: Response) => {
  const id: string = req.params.id as string;
  const job = jobs.get(id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (!job.done || !job.zipPath || !job.filename) return res.status(400).json({ error: 'Not ready' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${job.filename}"`);
  const stream = fs.createReadStream(job.zipPath as string);
  stream.on('close', () => fs.unlink(job.zipPath as string, () => {}));
  stream.pipe(res);
});

// Single-track endpoints
type TrackJob = {
  id: string;
  query: string;
  updates: Omit<ProgressUpdate, 'trackIndex'>[];
  done: boolean;
  filePath?: string;
  filename?: string;
  error?: string;
};

const trackJobs = new Map<string, TrackJob>();

app.post('/api/track-jobs', async (req: Request, res: Response) => {
  const { query } = req.body as { query: string };
  if (!query || typeof query !== 'string') return res.status(400).json({ error: 'query required' });
  const id = crypto.randomUUID();
  const job: TrackJob = { id, query, updates: [], done: false };
  trackJobs.set(id, job);
  void (async () => {
    try {
      const result = await downloadSingleWithProgress(query, (u) => job.updates.push(u));
      job.filePath = result.filePath;
      job.filename = result.filename;
      job.done = true;
    } catch (e: any) {
      job.error = e?.message || 'Job failed';
      job.done = true;
    }
  })();
  res.json({ id });
});

app.get('/api/track-jobs/:id', (req: Request, res: Response) => {
  const id = req.params.id as string;
  const job = trackJobs.get(id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json({ id: job.id, updates: job.updates, done: job.done, error: job.error });
});

app.get('/api/track-jobs/:id/download', (req: Request, res: Response) => {
  const id = req.params.id as string;
  const job = trackJobs.get(id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (!job.done || !job.filePath || !job.filename) return res.status(400).json({ error: 'Not ready' });
  const safeFilename = job.filename!.replace(/[\r\n]/g, '').replace(/[\x00-\x1F\x7F]/g, '').replace(/"/g, "'");
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeFilename)}`);
  const stream = fs.createReadStream(job.filePath as string);
  stream.on('close', () => fs.unlink(job.filePath as string, () => {}));
  stream.pipe(res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${PORT}`);
});


