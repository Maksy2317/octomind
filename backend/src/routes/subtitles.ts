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
// Shared style type used by both builders
type SubStyle = {
  fontSize?: number;
  fontColor?: string;
  position?: 'top' | 'bottom' | 'center';
  background?: boolean;
  uppercase?: boolean;
  /** If set, the current (last-shown) word is rendered in this colour — karaoke highlight effect */
  highlightColor?: string;
  /**
   * accumulating (default): words build up left-to-right, MAX_GROUP resets
   * flash: only the current word is shown; previous words disappear instantly (MrBeast / Flash style)
   */
  mode?: 'accumulating' | 'flash';
};

// ASS colours: &HAABBGGRR  (alpha-blue-green-red)
const COLOR_MAP: Record<string, string> = {
  white:  '&H00FFFFFF',
  yellow: '&H0000FFFF',
  red:    '&H000000FF',   // pure red in BGR = 0x0000FF
  black:  '&H00000000',
};

function prepareText(raw: string, uppercase: boolean): string {
  let t = raw.trim()
    .replace(/\r?\n/g, '\\N')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}');
  if (uppercase) t = t.toUpperCase();
  return t;
}

function buildAssHeader(
  style: SubStyle,
  wrapStyle: 0 | 1 = 0,
): string {
  const fontSize    = style.fontSize   ?? 72;
  const position    = style.position   ?? 'bottom';
  const fontColor   = style.fontColor  ?? 'white';
  const withBg      = style.background !== false;

  const primaryColor = COLOR_MAP[fontColor] ?? '&H00FFFFFF';
  const backColor    = withBg ? '&HB4000000' : '&H00000000';
  const borderStyle  = withBg ? 4 : 1;
  // No-background: use thick outline (6px) to match the "white text + thick black stroke" TikTok look
  const outline      = withBg ? 0 : 6;
  const alignment    = position === 'top' ? 8 : position === 'center' ? 5 : 2;
  // top: 60px from edge keeps text tight to the top (was 200 — too low)
  // bottom: 120px from edge keeps it off the very bottom
  const marginV      = position === 'center' ? 0 : position === 'top' ? 60 : 120;

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `WrapStyle: ${wrapStyle}`,
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
}

function buildAss(
  segments: Array<{ start: number; end: number; text: string }>,
  style?: SubStyle,
): string {
  const header = buildAssHeader(style ?? {}, 0);
  const uc = style?.uppercase ?? false;

  const events = segments
    .filter(seg => seg.text.trim())
    .map(seg => {
      const text = prepareText(seg.text, uc);
      return `Dialogue: 0,${toAssTime(seg.start)},${toAssTime(seg.end)},Default,,0,0,0,,${text}`;
    })
    .join('\n');

  return header + '\n' + events + '\n';
}

/**
 * Accumulating word-by-word mode (TikTok karaoke style):
 * Words build up one-by-one within each sentence → whole line disappears → next sentence starts fresh.
 *
 * Example for segment "While everyone thought he was":
 *   0.0–0.3  → "While"
 *   0.3–0.6  → "While everyone"
 *   0.6–0.9  → "While everyone thought"
 *   0.9–1.1  → "While everyone thought he"
 *   1.1–end  → "While everyone thought he was"
 *   [gap] — line disappears
 *   Next segment starts fresh
 */
function buildAssAccumulating(
  segments: Array<{ start: number; end: number; text: string }>,
  words: Array<{ word: string; start: number; end: number }>,
  style?: SubStyle,
): string {
  const uc          = style?.uppercase ?? false;
  const highlightBgr = style?.highlightColor
    ? (COLOR_MAP[style.highlightColor] ?? null) : null;

  // ── Build ASS header ───────────────────────────────────────────────────────
  // When karaoke highlight is requested we add a second ASS style "Highlight"
  // with the highlight colour. Two parallel Dialogue layers are then used:
  //   Layer 0 (Default/white)     — all accumulated words
  //   Layer 1 (Highlight/red)     — current word opaque, previous words {\alpha&HFF&} transparent
  // This dual-layer technique is far more reliable than inline \c colour tags
  // across different libass versions bundled with static-ffmpeg.
  let header = buildAssHeader(style ?? { position: 'center' }, 1);
  if (highlightBgr) {
    const fontSize  = style?.fontSize ?? 72;
    const position  = style?.position ?? 'center';
    const alignment = position === 'top' ? 8 : position === 'center' ? 5 : 2;
    const marginV   = position === 'center' ? 0 : position === 'top' ? 60 : 120;
    // Highlight style: identical layout to Default but primary colour = highlight colour
    const hlStyleLine =
      `Style: Highlight,Arial,${fontSize},${highlightBgr},&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,6,0,${alignment},10,10,${marginV},1`;
    header = header.replace(/^(Style: Default,.+)$/m, `$1\n${hlStyleLine}`);
  }

  // ── Greedy word→segment assignment ─────────────────────────────────────────
  const sortedWords = [...words]
    .filter(w => w.word.trim())
    .sort((a, b) => a.start - b.start);

  const segWordMap = new Map<number, Array<{ word: string; start: number; end: number }>>();

  let si = 0;
  for (const w of sortedWords) {
    while (si < segments.length - 1 && w.start > segments[si].end + 0.4) si++;
    if (w.start >= segments[si].start - 0.4) {
      if (!segWordMap.has(si)) segWordMap.set(si, []);
      segWordMap.get(si)!.push(w);
    }
  }

  // Max words shown at once before text clears and restarts — keeps subtitles
  // from overflowing the screen. 5 words ≈ 1–2 lines at the current font size.
  const MAX_GROUP = 5;

  const events: string[] = [];

  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg      = segments[segIdx];
    const segWords = segWordMap.get(segIdx) ?? [];

    if (segWords.length === 0) {
      // No word-level data — show full segment at once (fallback)
      const text = prepareText(seg.text, uc);
      if (text) events.push(
        `Dialogue: 0,${toAssTime(seg.start)},${toAssTime(seg.end)},Default,,0,0,0,,${text}`,
      );
      continue;
    }

    // Split segment words into groups of MAX_GROUP to prevent long text build-up.
    // Each group accumulates independently; after MAX_GROUP words the screen
    // clears and the next group starts fresh — matching the TikTok style.
    for (let groupStart = 0; groupStart < segWords.length; groupStart += MAX_GROUP) {
      const groupEnd   = Math.min(groupStart + MAX_GROUP, segWords.length);
      const groupWords = segWords.slice(groupStart, groupEnd);

      for (let i = 0; i < groupWords.length; i++) {
        const tStart = groupWords[i].start;
        // End time: next word in the group, or first word of next group, or segment end
        const tEnd = i + 1 < groupWords.length
          ? groupWords[i + 1].start
          : (groupEnd < segWords.length ? segWords[groupEnd].start : seg.end);
        if (tEnd <= tStart) continue;

        // Processed words for this frame (only within current group)
        const processed = groupWords.slice(0, i + 1).map(w => prepareText(w.word, uc));

        // ── Layer 0: accumulated words OR current word only (flash mode) ──
        const isFlash = style?.mode === 'flash';
        const allText = isFlash ? processed[i] : processed.join(' ');
        if (allText) events.push(
          `Dialogue: 0,${toAssTime(tStart)},${toAssTime(tEnd)},Default,,0,0,0,,${allText}`,
        );

        // ── Layer 1: current word in Highlight style ─────────────────────
        // Skip in flash mode — the current word IS the only visible text already
        if (highlightBgr && allText && !isFlash) {
          const prevText = processed.slice(0, i).join(' ');
          const currText = processed[i];
          const hlText   = prevText
            ? `{\\alpha&HFF&}${prevText} {\\alpha&H00&}${currText}`
            : currText;
          events.push(
            `Dialogue: 1,${toAssTime(tStart)},${toAssTime(tEnd)},Highlight,,0,0,0,,${hlText}`,
          );
        }
      }
    }
  }

  return header + '\n' + events.join('\n') + '\n';
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
      style?: SubStyle;
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
      ? buildAssAccumulating(segments, words!, style)
      : buildAss(segments, style);
    fs.writeFileSync(assPath, assContent, 'utf8');
    console.log(`[subtitles/burn] ASS file written: ${assPath} mode=${useWordByWord ? 'accumulating-word-by-word' : 'segments'} (${useWordByWord ? words!.length + ' words / ' + segments.length + ' segments' : segments.length + ' segments'})`);

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
