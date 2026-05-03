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

/** Extract audio track as mono 16kHz MP3 for Whisper */
function extractAudio(videoPath: string, audioPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .outputOptions(['-vn', '-ar 16000', '-ac 1', '-f mp3'])
      .output(audioPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(new Error(`Audio extraction failed: ${err.message}`)))
      .run();
  });
}

/** Format seconds → SRT timestamp  00:00:00,000 */
function toSrtTime(s: number): string {
  const h = Math.floor(s / 3600).toString().padStart(2, '0');
  const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  const ms = Math.round((s % 1) * 1000).toString().padStart(3, '0');
  return `${h}:${m}:${sec},${ms}`;
}

/** Build SRT string from segments */
function buildSrt(segments: Array<{ start: number; end: number; text: string }>): string {
  return segments
    .map((seg, i) => `${i + 1}\n${toSrtTime(seg.start)} --> ${toSrtTime(seg.end)}\n${seg.text.trim()}\n`)
    .join('\n');
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

    // 1. Extract audio
    audioPath = path.join(os.tmpdir(), `octo_audio_${uuidv4()}.mp3`);
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
subtitlesRouter.post('/burn', async (req: Request, res: Response, next: NextFunction) => {
  let srtPath: string | null = null;
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

    // Build SRT file
    srtPath = path.join(os.tmpdir(), `octo_subs_${uuidv4()}.srt`);
    fs.writeFileSync(srtPath, buildSrt(segments), 'utf8');

    const outputFilename = `${videoId}_subtitles.mp4`;
    const outputPath = path.join(outputDir, outputFilename);

    // ASS style parameters
    const fontSize   = style?.fontSize ?? 22;
    const position   = style?.position ?? 'bottom';
    const colorMap: Record<string, string> = {
      white:  '&H00FFFFFF',
      yellow: '&H0000FFFF',
      black:  '&H00000000',
    };
    const primaryColor = colorMap[style?.fontColor ?? 'white'] ?? '&H00FFFFFF';
    const alignment  = position === 'top' ? 8 : position === 'center' ? 5 : 2;
    const marginV    = position === 'center' ? 0 : 80;
    const borderStyle = (style?.background !== false) ? 4 : 1; // 4 = opaque box, 1 = outline
    const outline    = (style?.outline !== false) ? 2 : 0;

    const forceStyle = [
      'FontName=Arial',
      `FontSize=${fontSize}`,
      `PrimaryColour=${primaryColor}`,
      'OutlineColour=&H00000000',
      'BackColour=&HB4000000',
      `BorderStyle=${borderStyle}`,
      `Outline=${outline}`,
      'Shadow=0',
      `Alignment=${alignment}`,
      `MarginV=${marginV}`,
      'Bold=1',
    ].join(',');

    // Escape srtPath for FFmpeg filter string (no single quotes in path thanks to UUID)
    const escapedSrt = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');

    await new Promise<void>((resolve, reject) => {
      ffmpeg(videoPath)
        .videoFilter(`subtitles='${escapedSrt}':force_style='${forceStyle}'`)
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
  } finally {
    if (srtPath) { try { fs.unlinkSync(srtPath); } catch {} }
  }
});
