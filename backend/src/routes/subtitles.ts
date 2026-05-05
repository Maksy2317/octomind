import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import ffmpeg from 'fluent-ffmpeg';
import OpenAI from 'openai';

export const subtitlesRouter = Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(process.cwd(), 'uploads');

function findVideoFile(videoId: string): string | null {
  const exts = ['.mp4', '.mov', '.avi', '.webm'];
  for (const ext of exts) {
    const p = path.join(UPLOAD_DIR, `${videoId}${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Extract audio track as mono 16kHz WAV for Whisper */
function extractAudio(videoPath: string, audioPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      // WAV/PCM is built into every FFmpeg build — no external codec needed
      .outputOptions(['-vn', '-ar 16000', '-ac 1', '-f wav'])
      .output(audioPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(new Error(`Audio extraction failed: ${err.message}`)))
      .run();
  });
}

// ── Font detection ──────────────────────────────────────────────────────────

const FONT_PATHS = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/ubuntu/Ubuntu-Bold.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  '/System/Library/Fonts/Arial.ttf',
  '/Library/Fonts/Arial Bold.ttf',
];

function findFont(): string | null {
  for (const p of FONT_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── Text helpers ─────────────────────────────────────────────────────────────

/**
 * Wrap text into at most 3 lines, each no longer than maxCharsPerLine.
 * Lines are joined with the FFmpeg drawtext newline escape: \n
 */
function wrapText(text: string, maxCharsPerLine: number): string {
  if (text.length <= maxCharsPerLine) return text;
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharsPerLine) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 3).join('\n');
}

/**
 * Escape a string for use inside FFmpeg drawtext filter.
 * Characters that need escaping: ' : \ newline
 */
function escapeFfmpegText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "’")   // replace apostrophe with right single quotation mark
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

// ── POST /api/subtitles/generate ────────────────────────────────────────────
subtitlesRouter.post('/generate', async (req: Request, res: Response, next: NextFunction) => {
  let audioPath: string | null = null;
  try {
    const { videoId, language } = req.body as { videoId: string; language?: string };
    if (!videoId) { res.status(400).json({ error: 'videoId required' }); return; }

    const videoPath = findVideoFile(videoId);
    if (!videoPath) { res.status(404).json({ error: 'Video file not found' }); return; }

    if (!process.env.OPENAI_API_KEY) {
      res.status(500).json({ error: 'OPENAI_API_KEY not configured' }); return;
    }

    // 1. Extract audio (WAV — no codec dependency)
    audioPath = path.join(os.tmpdir(), `octo_audio_${uuidv4()}.wav`);
    await extractAudio(videoPath, audioPath);

    // 2. Transcribe with Whisper
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const transcription = await (openai.audio.transcriptions.create as any)({
      file: fs.createReadStream(audioPath),
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
      ...(language && language !== 'auto' ? { language } : {}),
    });

    const segments = ((transcription as any).segments || []).map((seg: any, idx: number) => ({
      id: idx,
      start: Number(seg.start),
      end: Number(seg.end),
      text: String(seg.text).trim(),
    }));

    res.json({ segments, detectedLanguage: (transcription as any).language || null });
  } catch (err) {
    next(err);
  } finally {
    if (audioPath) { try { fs.unlinkSync(audioPath); } catch {} }
  }
});

// ── POST /api/subtitles/burn ─────────────────────────────────────────────────
// Uses drawtext filter (requires only libfreetype — available in Debian apt ffmpeg)
// instead of subtitles filter (requires libass — often missing).
subtitlesRouter.post('/burn', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { videoId, segments, style } = req.body as {
      videoId: string;
      segments: Array<{ start: number; end: number; text: string }>;
      style?: {
        fontSize?: number;
        fontColor?: string;       // 'white' | 'yellow' | 'black'
        position?: 'top' | 'bottom' | 'center';
        background?: boolean;
        outline?: boolean;
      };
    };

    if (!videoId || !segments?.length) {
      res.status(400).json({ error: 'videoId and segments required' }); return;
    }

    const videoPath = findVideoFile(videoId);
    if (!videoPath) { res.status(404).json({ error: 'Video file not found' }); return; }

    const outputDir = process.env.OUTPUT_DIR
      ? path.resolve(process.env.OUTPUT_DIR)
      : path.resolve(process.cwd(), 'uploads/output');
    fs.mkdirSync(outputDir, { recursive: true });

    const outputFilename = `${videoId}_subtitles.mp4`;
    const outputPath = path.join(outputDir, outputFilename);

    // Style params
    const fontSize   = style?.fontSize ?? 22;
    const position   = style?.position ?? 'bottom';
    const fontColor  = style?.fontColor ?? 'white';
    const withBg     = style?.background !== false;  // default true

    // Y-axis expression based on position
    let yExpr: string;
    if (position === 'top') {
      yExpr = '80';
    } else if (position === 'center') {
      yExpr = '(h-text_h)/2';
    } else {
      // bottom — account for multi-line height, keep above bottom edge
      yExpr = 'h-text_h-80';
    }

    const boxcolor  = withBg ? 'black@0.65' : 'black@0';
    const boxborderw = withBg ? 14 : 0;
    const fontPath  = findFont();
    const fontfilePrefix = fontPath ? `fontfile=${fontPath}:` : '';

    // Build one drawtext filter per segment
    const drawtextFilters: string[] = segments.map((seg) => {
      const wrapped = wrapText(seg.text, 36);
      const escaped = escapeFfmpegText(wrapped);
      const enableExpr = `enable='between(t,${seg.start},${seg.end})'`;

      return (
        `drawtext=${fontfilePrefix}` +
        `text='${escaped}':` +
        `fontsize=${fontSize}:` +
        `fontcolor=${fontColor}:` +
        `x=(w-text_w)/2:y=${yExpr}:` +
        `box=1:boxcolor=${boxcolor}:boxborderw=${boxborderw}:` +
        `line_spacing=6:` +
        `${enableExpr}`
      );
    });

    console.log(`[subtitles/burn] Rendering ${drawtextFilters.length} subtitle segments with drawtext`);

    await new Promise<void>((resolve, reject) => {
      ffmpeg(videoPath)
        .videoFilters(drawtextFilters)
        .outputOptions([
          '-c:v libx264', '-crf 23', '-preset fast',
          '-c:a aac', '-b:a 128k', '-movflags +faststart',
        ])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(new Error(`Subtitle burn failed: ${err.message}`)))
        .run();
    });

    res.json({ downloadUrl: `/output/${outputFilename}` });
  } catch (err) {
    next(err);
  }
});
