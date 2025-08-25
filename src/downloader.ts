import { exec as execCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import pLimit from 'p-limit';

const exec = promisify(execCb);

async function ensureTools() {
  try { await exec('yt-dlp --version'); } catch { throw new Error('yt-dlp is not installed. On macOS: brew install yt-dlp'); }
  try { await exec('ffmpeg -version'); } catch { throw new Error('ffmpeg is not installed. On macOS: brew install ffmpeg'); }
}

function safeName(name: string): string {
  return name.replace(/[^\w\-\s().,]/g, '').replace(/\s+/g, ' ').trim();
}

export async function downloadTracksZip(tracks: string[]): Promise<{ zipPath: string; filename: string }> {
  await ensureTools();
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ytmp3-'));
  const outDir = path.join(workDir, 'out');
  await fs.mkdir(outDir);

  const limit = pLimit(2);
  const results = await Promise.allSettled(
    tracks.map((query, index) => limit(async () => {
      const base = safeName(`${String(index + 1).padStart(2, '0')} ${query}`);
      const outPath = path.join(outDir, `${base}.mp3`);
      const cmd = [
        'yt-dlp',
        `"ytsearch1:${query.replace(/"/g, '\\"')}"`,
        '-x', '--audio-format', 'mp3', '--audio-quality', '0',
        '-o', `"${outPath.replace(/\.mp3$/, '')}.%(ext)s"`,
        '--no-playlist', '--quiet', '--no-warnings'
      ].join(' ');
      await exec(cmd);
      // yt-dlp may output .mp3 already; ensure rename to .mp3
      if (!fss.existsSync(outPath)) {
        const files = await fs.readdir(outDir);
        const candidate = files.find((f) => f.startsWith(base) && /\.(mp3|m4a|opus|webm|mka)$/i.test(f));
        if (candidate) {
          const ext = path.extname(candidate);
          await fs.rename(path.join(outDir, candidate), outPath.replace(/\.mp3$/, ext));
        }
      }
    }))
  );

  const failures = results.filter((r) => r.status === 'rejected');
  if (failures.length === tracks.length) {
    throw new Error('Failed to download all tracks');
  }

  const zipPath = path.join(workDir, 'tracks.zip');
  // Use system zip for speed to avoid bundling archiver complexity
  await exec(`cd "${outDir}" && zip -r "${zipPath}" . >/dev/null`);
  return { zipPath, filename: 'tracks.zip' };
}


export type TrackPhase = 'queued' | 'searching' | 'downloading' | 'converting' | 'done' | 'failed';
export type ProgressUpdate = { trackIndex: number; phase: TrackPhase; percent?: number; message?: string };

function parseYtDlpProgressLine(line: string): { percent?: number; phase?: TrackPhase; destination?: string | undefined } {
  const downloadMatch = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i);
  if (downloadMatch) {
    return { percent: Number(downloadMatch[1]), phase: 'downloading' };
  }
  const destMatch = line.match(/Destination:\s(.+\.[a-z0-9]{2,4})/i);
  if (destMatch) {
    return { phase: 'converting', destination: destMatch[1] as string };
  }
  if (/\[(ExtractAudio|Merger|ffmpeg)\]/i.test(line)) {
    return { phase: 'converting' };
  }
  return {};
}

async function runSingleDownload(
  query: string,
  outDir: string,
  base: string,
  onUpdate: (line: string) => void,
  opts: { timeoutMs?: number; inactivityMs?: number; signal?: AbortSignal } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 120000; // 2 minutes
  const inactivityMs = opts.inactivityMs ?? 30000; // 30s without output
  const args = [
    `ytsearch1:${query}`,
    '-x', '--audio-format', 'mp3', '--audio-quality', '0',
    '-o', `${path.join(outDir, base)}.%(ext)s`,
    '--no-playlist', '--newline', '--no-warnings'
  ];
  await new Promise<void>((resolve, reject) => {
    if (opts.signal?.aborted) {
      return reject(new Error('Aborted'));
    }
    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (quietTimer) clearTimeout(quietTimer);
    };

    const startTimers = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!finished) {
          child.kill('SIGKILL');
          finished = true;
          clearTimers();
          reject(new Error('Timeout while downloading'));
        }
      }, timeoutMs);
      resetQuietTimer();
    };

    const resetQuietTimer = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        if (!finished) {
          child.kill('SIGKILL');
          finished = true;
          clearTimers();
          reject(new Error('No output from yt-dlp (network stalled)'));
        }
      }, inactivityMs);
    };

    startTimers();
    opts.signal?.addEventListener('abort', () => {
      if (!finished) {
        child.kill('SIGKILL');
        finished = true;
        clearTimers();
        reject(new Error('Aborted'));
      }
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      resetQuietTimer();
      chunk.split(/\r?\n/).forEach((line) => line && onUpdate(line));
    });
    child.stderr.on('data', (chunk: string) => {
      resetQuietTimer();
      chunk.split(/\r?\n/).forEach((line) => line && onUpdate(line));
    });
    child.on('error', (e) => { clearTimers(); reject(e); });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimers();
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp exited with code ${code}`));
    });
  });
}

export async function downloadTracksZipWithProgress(
  tracks: string[],
  onProgress: (u: ProgressUpdate) => void
): Promise<{ zipPath: string; filename: string }> {
  await ensureTools();
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ytmp3-'));
  const outDir = path.join(workDir, 'out');
  await fs.mkdir(outDir);

  for (let i = 0; i < tracks.length; i += 1) {
    const q = tracks[i];
    if (typeof q !== 'string' || q.trim().length === 0) {
      onProgress({ trackIndex: i, phase: 'failed', message: 'empty track' });
      continue;
    }
    const query = q;
    const base = safeName(`${String(i + 1).padStart(2, '0')} ${query}`);
    onProgress({ trackIndex: i, phase: 'searching', message: 'searching' });
    try {
      await runSingleDownload(query, outDir, base, (line) => {
        const info = parseYtDlpProgressLine(line);
        if (info.phase || info.percent !== undefined) {
          const payload: ProgressUpdate = { trackIndex: i, phase: (info.phase ?? 'downloading') as TrackPhase };
          if (info.percent !== undefined) payload.percent = info.percent;
          onProgress(payload);
        }
      });
      onProgress({ trackIndex: i, phase: 'done', percent: 100 });
    } catch (e) {
      onProgress({ trackIndex: i, phase: 'failed', message: (e as Error).message });
    }
  }

  const zipPath = path.join(workDir, 'tracks.zip');
  await exec(`cd "${outDir}" && zip -r "${zipPath}" . >/dev/null`);
  return { zipPath, filename: 'tracks.zip' };
}

export async function downloadSingleWithProgress(
  query: string,
  onProgress: (u: Omit<ProgressUpdate, 'trackIndex'> & { trackIndex?: number }) => void,
  signal?: AbortSignal
): Promise<{ filePath: string; filename: string }> {
  await ensureTools();
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ytmp3-'));
  const outDir = path.join(workDir, 'out');
  await fs.mkdir(outDir);

  let destinationPath: string | undefined;
  const baseTemplate = '%(artist,uploader,channel)s - %(track,title)s.%(ext)s';
  const output = path.join(outDir, baseTemplate);
  onProgress({ phase: 'searching' });
  try {
    await runSingleDownload(query, outDir, output.replace(/\.%(ext)s$/, ''), (line) => {
      const info = parseYtDlpProgressLine(line);
      if (info.destination) destinationPath = info.destination;
      if (info.phase || info.percent !== undefined) {
        const payload: any = { phase: (info.phase ?? 'downloading') };
        if (info.percent !== undefined) payload.percent = info.percent;
        onProgress(payload);
      }
    }, { signal: signal as AbortSignal });
  } catch (e) {
    // Fallback: try appending ' audio' to the query once
    onProgress({ phase: 'searching', message: 'retrying with audio' } as any);
    await runSingleDownload(`${query} audio`, outDir, output.replace(/\.%(ext)s$/, ''), (line) => {
      const info = parseYtDlpProgressLine(line);
      if (info.destination) destinationPath = info.destination;
      if (info.phase || info.percent !== undefined) {
        const payload: any = { phase: (info.phase ?? 'downloading') };
        if (info.percent !== undefined) payload.percent = info.percent;
        onProgress(payload);
      }
    }, { signal: signal as AbortSignal });
  }
  // Determine final file path
  let filePath: string;
  if (destinationPath) {
    filePath = destinationPath;
  } else {
    const files = await fs.readdir(outDir);
    const mp3 = files.find((f) => /\.(mp3|m4a|opus|webm|mka)$/i.test(f));
    if (!mp3) throw new Error('Output file not found');
    filePath = path.join(outDir, mp3);
  }
  const filename = path.basename(filePath);
  return { filePath, filename };
}

