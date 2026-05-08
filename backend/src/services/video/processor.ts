import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import ffmpeg from 'fluent-ffmpeg';
import { TemplateConfig, VideoFormat, StructuredTemplate } from '../../types';
import { LayoutHints } from './smartLayout';

// Always use system FFmpeg — Dockerfile installs Debian apt ffmpeg which includes
// libfreetype (drawtext), libass (subtitles), libx264, libfdk-aac, etc.
// Never fall back to ffmpeg-static (it lacks drawtext and libass).
import { execSync } from 'child_process';

try {
  const ffmpegVersion = execSync('ffmpeg -version 2>&1 | head -1', { stdio: 'pipe' }).toString().trim();
  console.log(`[ffmpeg] ${ffmpegVersion}`);
} catch {
  console.warn('[ffmpeg] Could not detect system FFmpeg version — using PATH default');
}

const FORMAT_DIMENSIONS: Record<VideoFormat, { width: number; height: number }> = {
  stories: { width: 1080, height: 1920 },
  reels: { width: 1080, height: 1920 },
  tiktok: { width: 1080, height: 1920 },
};

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
  // Order matters: escape backslash first, then others
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "’")     // replace smart apostrophe to avoid escaping issues
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

// ── Existing applyTemplate (legacy) ─────────────────────────────────────────

export function applyTemplate(
  inputPath: string,
  outputPath: string,
  template: TemplateConfig,
  format: VideoFormat,
  overlayPath?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const { width, height } = FORMAT_DIMENSIONS[format];
    const { ffmpegFilters } = buildFilters(template, width, height);

    let command = ffmpeg(inputPath);

    if (overlayPath) {
      // Custom overlay: composite user's image on top of processed video
      // Step 1: build the base video filter chain (scale+crop+color)
      const baseFilters = ffmpegFilters.map((f, i) =>
        i === 0 ? `[0:v]${f}` : f
      ).join(',') + '[base]';

      command = command
        .input(overlayPath)
        .complexFilter(
          `${baseFilters};[1:v]scale=${width}:${height}[ovr];[base][ovr]overlay=0:0[out]`,
          'out',
        )
        .outputOptions([
          '-c:v libx264', '-crf 23', '-preset fast',
          '-c:a aac', '-b:a 128k', '-movflags +faststart',
        ])
        .output(outputPath);
    } else {
      // Standard template: simple video filter chain
      command = command
        .videoFilters(ffmpegFilters)
        .outputOptions([
          '-c:v libx264', '-crf 23', '-preset fast',
          '-c:a aac', '-b:a 128k', '-movflags +faststart',
        ])
        .output(outputPath);

      if (template.textOverlay) {
        const { text, fontsize, fontcolor, x, y, box, boxcolor } = template.textOverlay;
        const boxOption = box ? `:box=1:boxcolor=${boxcolor || 'black@0.5'}:boxborderw=5` : '';
        command = command.videoFilters(
          `drawtext=text='${text}':fontsize=${fontsize}:fontcolor=${fontcolor}:x=${x}:y=${y}${boxOption}`,
        );
      }
    }

    command
      .on('progress', (progress) => {
        process.stdout.write(`\rProcessing: ${Math.round(progress.percent || 0)}%`);
      })
      .on('end', () => {
        process.stdout.write('\n');
        resolve();
      })
      .on('error', (err) => {
        reject(new Error(`FFmpeg error: ${err.message}`));
      })
      .run();
  });
}

// ── ASS helpers for structured template text overlays ────────────────────────

/** Format seconds → ASS timestamp H:MM:SS.CC */
function toAssTimeProc(s: number): string {
  const h  = Math.floor(s / 3600);
  const m  = Math.floor((s % 3600) / 60);
  const sc = Math.floor(s % 60);
  const cs = Math.min(99, Math.round((s % 1) * 100));
  return `${h}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

/**
 * Build an ASS file from structured-template slot definitions.
 * Uses the `subtitles` filter (always available in mwader/static-ffmpeg)
 * instead of `drawtext` (which requires libfreetype and can be missing).
 *
 * ASS colour format: &HAABBGGRR  (alpha-blue-green-red)
 *   white  = &H00FFFFFF
 *   yellow = &H0000FFFF   (BGR: 00 FF FF)
 *   black  = &H00000000
 * Box backgrounds use BackColour with alpha:
 *   60% opaque black = &H99000000
 *   70% opaque black = &H80000000
 */
function buildAssForSlots(
  slots: StructuredTemplate['slots'],
  textInputs: Record<string, string>,
  hints?: LayoutHints,
): string {
  // ── Dynamic TikTok-style layout ──────────────────────────────────────────
  // Every slot type gets its own position + slide-in animation:
  //   Hook  → drops from just above into the top zone (slides down)
  //   Point → cycles through 4 screen zones, each sliding in from a different direction
  //   Label → fades in at exact center
  //   CTA   → rises from near-bottom (slides up)
  //
  // ASS coordinate system: PlayResX=1080, PlayResY=1920
  // \an4 = mid-left anchor  \an5 = mid-center  \an6 = mid-right  \an8 = top-center  \an2 = bottom-center
  // \move(x1,y1,x2,y2,t1ms,t2ms)  \fad(fade_in_ms, fade_out_ms)  \pos(x,y)

  const lines: string[] = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 1',
    'ScaledBorderAndShadow: yes',
    'PlayResX: 1080',
    'PlayResY: 1920',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Hook — 70px YELLOW; outline on dark bg, dark box on bright bg
    hints?.needsDarkBox
      ? 'Style: Hook,Arial,70,&H0000FFFF,&H000000FF,&H00000000,&H99000000,-1,0,0,0,100,100,0,0,4,14,0,8,60,60,0,1'
      : 'Style: Hook,Arial,70,&H0000FFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,8,3,8,60,60,0,1',
    // Point — 56px WHITE; outline on dark bg, dark box on bright bg
    hints?.needsDarkBox
      ? 'Style: Point,Arial,56,&H00FFFFFF,&H000000FF,&H00000000,&HCC000000,-1,0,0,0,100,100,0,0,4,18,0,5,60,60,0,1'
      : 'Style: Point,Arial,56,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,6,2,5,60,60,0,1',
    // Label — 80px WHITE, dark box 18px padding; centered, position overridden per-event
    'Style: Label,Arial,80,&H00FFFFFF,&H000000FF,&H00000000,&HCC000000,-1,0,0,0,100,100,0,0,4,18,0,5,60,60,0,1',
    // CTA — 56px YELLOW, dark box 14px padding; position overridden per-event
    'Style: CTA,Arial,56,&H0000FFFF,&H000000FF,&H00000000,&HCC000000,-1,0,0,0,100,100,0,0,4,14,0,2,60,60,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const styleMap: Record<string, string> = { hook: 'Hook', point: 'Point', label: 'Label', cta: 'CTA' };

  // Four Point zones — cycle through them so consecutive points land in different spots.
  // Each entry: { x, y, an } = final position + anchor; { fromX, fromY } = start of slide animation.
  const pointLayouts = [
    // Zone A: LEFT side, upper-middle — slides in from the LEFT edge
    { x: 65,   y: 680,  an: 4, fromX: -200, fromY: 680  },
    // Zone B: CENTER, true middle — slides UP into place
    { x: 540,  y: 960,  an: 5, fromX: 540,  fromY: 1030 },
    // Zone C: RIGHT side, lower-middle — slides in from the RIGHT edge
    { x: 1015, y: 1260, an: 6, fromX: 1250, fromY: 1260 },
    // Zone D: CENTER, upper-third — slides DOWN into place
    { x: 540,  y: 540,  an: 5, fromX: 540,  fromY: 490  },
  ];

  // ── Zone avoidance: put the busiest zone (likely face) at the end of the cycle
  // so the first N points land in safe screen areas.
  // Layout y-ranges mapped to zones: top 0-639, center 640-1279, bottom 1280-1919
  const layoutZone = (y: number): 'top' | 'center' | 'bottom' =>
    y < 640 ? 'top' : y < 1280 ? 'center' : 'bottom';

  const orderedLayouts = hints?.avoidZone
    ? [
        ...pointLayouts.filter(p => layoutZone(p.y) !== hints.avoidZone),
        ...pointLayouts.filter(p => layoutZone(p.y) === hints.avoidZone),
      ]
    : pointLayouts;

  let pointCount = 0;

  for (const slot of slots) {
    const raw = (textInputs[slot.id] || (slot as any).defaultText || '').trim();
    if (!raw) continue;

    // Sanitise: strip existing ASS tags, newlines → \N, safe apostrophe
    const text = raw
      .replace(/\{[^}]*\}/g, '')
      .replace(/\r?\n/g, '\\N')
      .replace(/'/g, '’');

    const assStyle  = styleMap[slot.style] || 'Point';
    const startTime = toAssTimeProc(slot.startSec);
    const endTime   = toAssTimeProc(Math.min(slot.endSec, 300));

    // Per-slot animation override tags ─────────────────────────────────────
    let tags = '';

    if (slot.style === 'hook') {
      // Drops from y=55 → y=90 in 320 ms while fading in; brief fade-out at end
      tags = '{\\move(540,55,540,90,0,320)\\fad(250,150)\\an8}';

    } else if (slot.style === 'point') {
      const p = orderedLayouts[pointCount % orderedLayouts.length];
      // Slides from off-screen (or adjacent zone) into its final position
      tags = `{\\move(${p.fromX},${p.fromY},${p.x},${p.y},0,280)\\fad(200,120)\\an${p.an}}`;
      pointCount++;

    } else if (slot.style === 'label') {
      // Fades in at exact screen center — no movement, maximum readability
      tags = '{\\pos(540,960)\\fad(350,200)\\an5}';

    } else if (slot.style === 'cta') {
      // Rises from y=1880 → y=1820 in 400 ms — classic "slide up" CTA entrance
      tags = '{\\move(540,1880,540,1820,0,400)\\fad(350,250)\\an2}';
    }

    lines.push(`Dialogue: 0,${startTime},${endTime},${assStyle},,0,0,0,,${tags}${text}`);
  }

  return lines.join('\n') + '\n';
}

// ── New: applyStructuredTemplate ─────────────────────────────────────────────

export function applyStructuredTemplate(
  inputPath: string,
  outputPath: string,
  template: StructuredTemplate,
  textInputs: Record<string, string>,
  format: VideoFormat,
  hints?: LayoutHints,
): Promise<void> {
  let assPath: string | null = null;

  return new Promise((resolve, reject) => {
    const { width, height } = FORMAT_DIMENSIONS[format];

    // 1. Base filters: scale → crop → colour adjustment
    const baseFilters: string[] = [
      `scale=${width}:${height}:force_original_aspect_ratio=increase`,
      `crop=${width}:${height}`,
    ];
    const { brightness, contrast, saturation } = template.colorAdjust;
    baseFilters.push(`eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}`);

    // 2. Build ASS overlay file from template slots.
    //    Using the `subtitles` filter (libass) instead of `drawtext` (libfreetype)
    //    because mwader/static-ffmpeg guarantees libass but drawtext can be absent.
    assPath = path.join(os.tmpdir(), `octo_tmpl_${uuidv4()}.ass`);
    fs.writeFileSync(assPath, buildAssForSlots(template.slots, textInputs, hints), 'utf8');
    console.log(`[applyStructuredTemplate] ASS overlay → ${assPath}`);

    // Escape the ASS path for FFmpeg filter syntax (colon is an option separator)
    const escapedAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    const allFilters = [...baseFilters, `subtitles='${escapedAss}'`];

    const command = ffmpeg(inputPath)
      .videoFilters(allFilters)
      .outputOptions([
        '-c:v libx264', '-crf 23', '-preset fast',
        '-c:a aac', '-b:a 128k', '-movflags +faststart',
      ])
      .output(outputPath);

    command
      .on('start', (cmd: string) => {
        console.log('[applyStructuredTemplate] FFmpeg cmd:', cmd);
      })
      .on('progress', (progress: { percent?: number }) => {
        process.stdout.write(`\rProcessing (structured): ${Math.round(progress.percent || 0)}%`);
      })
      .on('end', () => {
        process.stdout.write('\n');
        if (assPath) { try { fs.unlinkSync(assPath); } catch {} }
        resolve();
      })
      .on('error', (err: Error) => {
        console.error('[applyStructuredTemplate] FFmpeg error:', err.message);
        if (assPath) { try { fs.unlinkSync(assPath); } catch {} }
        reject(new Error(`FFmpeg error: ${err.message}`));
      })
      .run();
  });
}

// ── Internal helper ───────────────────────────────────────────────────────────

function buildFilters(template: TemplateConfig, width: number, height: number): {
  ffmpegFilters: string[];
  colorAdjust: string;
} {
  const filters: string[] = [];

  // 1. Scale and crop to target format (cover, not stretch)
  filters.push(
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
  );

  // 2. Color adjustments
  const adj = template.ffmpegFilters.colorAdjust;
  if (adj) {
    const brightness = adj.brightness ?? 0;
    const contrast = adj.contrast ?? 1;
    const saturation = adj.saturation ?? 1;
    filters.push(`eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}`);
  }

  // 3. Vignette effect
  if (template.ffmpegFilters.vignette) {
    filters.push('vignette=PI/4');
  }

  // 4. Border / padding
  if (template.borderConfig) {
    const { color, width: bw } = template.borderConfig;
    filters.push(`pad=${width}:${height}:${bw}:${bw}:${color}`);
  }

  return { ffmpegFilters: filters, colorAdjust: '' };
}
