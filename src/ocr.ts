import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import fs from 'node:fs/promises';

function hasCJK(text: string): boolean {
  return /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7A3]/.test(text);
}

function normalizeLine(line: string): string | null {
  const cleaned = line
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  // Remove trailing durations like 3:45 or 1:02:33
  const noDuration = cleaned.replace(/\b\d{1,2}:(?:\d{2})(?::\d{2})?\b/g, '').trim();
  // Remove bullets or numbering
  const noBullet = noDuration.replace(/^[-•\d.\)\]]+\s*/, '').trim();
  // Basic filter: avoid lines that look like UI labels
  if (/^(shuffle|share|subscribe|more|views|likes|playlist|album|artist)$/i.test(noBullet)) {
    return null;
  }
  // Heuristic: Keep lines that contain a dash or by/– which often separates title and artist
  return noBullet;
}

export async function extractTracksFromImage(imagePath: string): Promise<string[]> {
  // Preprocess image for better OCR: grayscale, increase contrast
  const preprocessed = await sharp(imagePath)
    .grayscale()
    .normalise()
    .toBuffer();

  // Enable English + Simplified/Traditional Chinese
  const worker = await createWorker('eng+chi_sim+chi_tra');
  try {
    const { data } = await worker.recognize(preprocessed);
    const lines = data.text.split(/\r?\n/)
      .map(normalizeLine)
      .filter((l): l is string => !!l && l.length >= 2);

    // Pair logic: [Title] followed by [Artist · Album] → keep only Title
    const results: string[] = [];
    const isArtistAlbum = (s: string) => /[•·・«»]/.test(s) || /^by\s+/i.test(s);

    for (let i = 0; i < lines.length; i += 1) {
      const title = lines[i] ?? '';
      if (!title) continue;
      // If current line itself looks like artist/album metadata, skip it
      if (isArtistAlbum(title)) continue;
      const next = lines[i + 1];
      if (typeof next === 'string' && isArtistAlbum(next)) {
        results.push(title);
        i += 1; // skip the artist line we consumed
      } else {
        // If a single CJK line (often titles), keep as-is
        if (hasCJK(title) || /\w/.test(title)) {
          results.push(title);
        }
      }
    }

    // Deduplicate while preserving order
    const seen = new Set<string>();
    const compact = results.filter((r) => {
      const key = r.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      // Drop very short latin noise like "Wik"
      if (!hasCJK(r) && !/\w+\s+\w+/.test(r) && r.replace(/[^a-z0-9]/ig, '').length < 4) {
        return false;
      }
      return true;
    });

    return compact.slice(0, 200);
  } finally {
    await worker.terminate();
    await fs.unlink(imagePath).catch(() => {});
  }
}


