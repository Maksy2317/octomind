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
      .outputOptions(['-vn', '-ar 16000', '-ac 1', '-f wav'])
      .output(audioPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(new Error(`Audio extraction failed: ${err.message}`)))
      .run();
  });
}

// ── ASS subtitle builder ─────────────────────────────────────────────────────

/** Format seconds → ASS timestamp  H:MM:SS.CC */
function toAssTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.min(99, Math.round((s % 1) * 100));
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** Build an ASS subtitle file from segments + style */
function buildAss(
  segments: Array<{ start: number; end: number; text: string }>,
  style?: {
    fontSize?: number;
    fontColor?: string;
    position?: 'top' | 'bottom' | 'center';
    background?: boolean;
  },
): string {
  const fontSize   = style?.fontSize   ?? 22;
  const position   = style?.position   ?? 'bottom';
  const fontColor  = style?.fontColor  ?? 'white';
  const withBg     = style?.background !== false;

  // ASS colours: &HAABBGGRR  (alpha-blue-green-red)
  const colorMap: Record<string, string> = {
    white:  '&H00FFFFFF',
    yellow: '&H0000FFFF',
    black:  '&H00000000',
  };
  const primaryColor = colorMap[fontColor] ?? '&H00FFFFFF';
  const backColor    = withBg ? '&HB4000000' : '&H00000000';
  const borderStyle  = withBg ? 4 : 1;   // 4 = opaque box, 1 = outline
  const outline      = withBg ? 0 : 2;
  const alignment    = position === 'top' ? 8 : position === 'center' ? 5 : 2;
  const marginV      = position === 'center' ? 0 : 200; // ~10% from edge at PlayResY=1920

  // PlayRes matches vertical 9:16 social video (stories/reels/tiktok 1080×1920).
  // Font sizes are in real pixels at this resolution (no unexpected libass scaling).
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'PlayResX: 1080',
    'PlayResY: 1920',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Arial,${fontSize},${primaryColor},&H000000FF,&H00000000,${backColor},-1,0,0,0,100,100,0,0,${borderStyle},${outline},0,${alignment},10,10,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  const events = segments
    .filter(seg => seg.text.trim())
    .map(seg => {
      const text = seg.text
        .trim()
        .replace(/\r?\n/g, '\\N')   // ASS hard line-break
        .replace(/\{/g, '\\{')      // escape ASS override tags
        .replace(/\}/g, '\\}');
      return `Dialogue: 0,${toAssTime(seg.start)},${toAssTime(seg.end)},Default,,0,0,0,,${text}`;
    })
    .join('\n');

  return header + '\n' + events + '\n';
}

/** Word-by-word mode: one Dialogue event per spoken word (TikTok style) */
function buildAssWordByWord(
  words: Array<{ word: string; start: number; end: number }>,
  style?: {
    fontSize?: number;
    fontColor?: string;
    position?: 'top' | 'bottom' | 'center';
    background?: boolean;
  },
): string {
  const fontSize   = style?.fontSize   ?? 72;
  const position   = style?.position   ?? 'bottom';
  const fontColor  = style?.fontColor  ?? 'white';
  const withBg     = style?.background !== false;

  const colorMap: Record<string, string> = {
    white:  '&H00FFFFFF',
    yellow: '&H0000FFFF',
    black:  '&H00000000',
  };
  const primaryColor = colorMap[fontColor] ?? '&H00FFFFFF';
  const backColor    = withBg ? '&HB4000000' : '&H00000000';
  const borderStyle  = withBg ? 4 : 1;
  const outline      = withBg ? 0 : 2;
  const alignment    = position === 'top' ? 8 : position === 'center' ? 5 : 2;
  const marginV      = position === 'center' ? 0 : 200; // ~10% from edge at PlayResY=1920

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'PlayResX: 1080',
    'PlayResY: 1920',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Arial,${fontSize},${primaryColor},&H000000FF,&H00000000,${backColor},-1,0,0,0,100,100,0,0,${borderStyle},${outline},0,${alignment},10,10,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  const events = words
    .filter(w => w.word.trim())
    .map(w => {
      const text = w.word.trim()
        .replace(/\{/g, '\\{').replace(/\}/g, '\\}');
      return `Dialogue: 0,${toAssTime(w.start)},${toAssTime(w.end)},Default,,0,0,0,,${text}`;
    })
    .join('\n');

  return header + '\n' + events + '\n';
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

    audioPath = path.join(os.tmpdir(), `octo_audio_${uuidv4()}.wav`);
    await extractAudio(videoPath, audioPath);

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const transcription = await (openai.audio.transcriptions.create as any)({
      file: fs.createReadStream(audioPath),
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment', 'word'],
      ...(language && language !== 'auto' ? { language } : {}),
    });

    const segments = ((transcription as any).segments || []).map((seg: any, idx: number) => ({
      id: idx,
      start: Number(seg.start),
      end: Number(seg.end),
      text: String(seg.text).trim(),
    }));

    const words = ((transcription as any).words || []).map((w: any, idx: number) => ({
      id: idx,
      word: String(w.word).trim(),
      start: Number(w.start),
      end: Number(w.end),
    }));

    res.json({ segments, words, detectedLanguage: (transcription as any).language || null });
  } catch (err) {
    next(err);
  } finally {
    if (audioPath) { try { fs.unlinkSync(audioPath); } catch {} }
  }
});

// ── POST /api/subtitles/burn ─────────────────────────────────────────────────
// Uses ASS subtitle format + `subtitles` filter (requires libass, built into
// mwader/static-ffmpeg). This avoids drawtext (libfreetype dependency issues).
subtitlesRouter.post('/burn', async (req: Request, res: Response, next: NextFunction) => {
  let assPath: string | null = null;
  try {
    const { videoId, segments, words, wordByWord, style } = req.body as {
      videoId: string;
      segments: Array<{ start: number; end: number; text: string }>;
      words?: Array<{ word: string; start: number; end: number }>;
      wordByWord?: boolean;
      style?: {
        fontSize?: number;
        fontColor?: string;
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

    // Build and write ASS file
    assPath = path.join(os.tmpdir(), `octo_subs_${uuidv4()}.ass`);
    const useWordByWord = wordByWord && words && words.length > 0;
    const assContent = useWordByWord
      ? buildAssWordByWord(words!, style)
      : buildAss(segments, style);
    fs.writeFileSync(assPath, assContent, 'utf8');
    console.log(`[subtitles/burn] ASS file written: ${assPath} mode=${useWordByWord ? 'word-by-word' : 'segments'} (${useWordByWord ? words!.length + ' words' : segments.length + ' segments'})`);

    // Escape path for FFmpeg filter syntax (colon is option separator)
    // UUID-based paths never contain single quotes or spaces
    const escapedAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

    await new Promise<void>((resolve, reject) => {
      const cmd = ffmpeg(videoPath)
        .videoFilter(`subtitles='${escapedAss}'`)
        .outputOptions([
          '-c:v libx264', '-crf 23', '-preset fast',
          '-c:a aac', '-b:a 128k', '-movflags +faststart',
        ])
        .output(outputPath);

      cmd.on('start', (command: string) => {
        console.log('[subtitles/burn] FFmpeg command:', command);
      });
      cmd.on('end', () => {
        console.log('[subtitles/burn] Done →', outputPath);
        resolve();
      });
      cmd.on('error', (err: Error) => {
        console.error('[subtitles/burn] FFmpeg error:', err.message);
        reject(new Error(`Subtitle burn failed: ${err.message}`));
      });
      cmd.run();
    });

    res.json({ downloadUrl: `/output/${outputFilename}` });
  } catch (err) {
    next(err);
  } finally {
    if (assPath) { try { fs.unlinkSync(assPath); } catch {} }
  }
});
