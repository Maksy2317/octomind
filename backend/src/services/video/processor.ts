import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import { TemplateConfig, VideoFormat, StructuredTemplate } from '../../types';

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

// ── New: applyStructuredTemplate ─────────────────────────────────────────────

export function applyStructuredTemplate(
  inputPath: string,
  outputPath: string,
  template: StructuredTemplate,
  textInputs: Record<string, string>,
  format: VideoFormat,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const { width, height } = FORMAT_DIMENSIONS[format];
    const fontPath = findFont();

    // 1. Base filters: scale + crop + color adjustment
    const baseFilters: string[] = [
      `scale=${width}:${height}:force_original_aspect_ratio=increase`,
      `crop=${width}:${height}`,
    ];

    const { brightness, contrast, saturation } = template.colorAdjust;
    baseFilters.push(`eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}`);

    // 2. Build one drawtext filter per slot
    const drawtextFilters: string[] = [];

    for (const slot of template.slots) {
      const rawText = (textInputs[slot.id] || slot.defaultText).trim();
      const wrapped = wrapText(rawText, 28);
      const escaped = escapeFfmpegText(wrapped);

      // Position expressions
      let xExpr: string;
      let yExpr: string;
      switch (slot.position) {
        case 'top':
          xExpr = '(w-text_w)/2';
          yExpr = '120';
          break;
        case 'bottom':
          xExpr = '(w-text_w)/2';
          yExpr = 'h-180';
          break;
        case 'center':
        default:
          xExpr = '(w-text_w)/2';
          yExpr = '(h-text_h)/2';
          break;
      }

      // Style-based appearance
      let fontsize: number;
      let fontcolor: string;
      let boxcolor: string;
      let boxborderw: number;

      switch (slot.style) {
        case 'hook':
          fontsize = 52;
          fontcolor = 'white';
          boxcolor = 'black@0.6';
          boxborderw = 16;
          break;
        case 'label':
          fontsize = 64;
          fontcolor = 'white';
          boxcolor = 'black@0.7';
          boxborderw = 20;
          break;
        case 'cta':
          fontsize = 38;
          fontcolor = 'yellow';
          boxcolor = 'black@0.5';
          boxborderw = 12;
          break;
        case 'point':
        default:
          fontsize = 42;
          fontcolor = 'white';
          boxcolor = 'black@0.5';
          boxborderw = 12;
          break;
      }

      const endSec = Math.min(slot.endSec, 300);
      const enableExpr = `enable='between(t,${slot.startSec},${endSec})'`;

      const fontfilePrefix = fontPath ? `fontfile=${fontPath}:` : '';

      const filter =
        `drawtext=${fontfilePrefix}` +
        `text='${escaped}':` +
        `fontsize=${fontsize}:` +
        `fontcolor=${fontcolor}:` +
        `x=${xExpr}:y=${yExpr}:` +
        `box=1:boxcolor=${boxcolor}:boxborderw=${boxborderw}:` +
        `line_spacing=8:` +
        `${enableExpr}`;

      drawtextFilters.push(filter);
    }

    const allFilters = [...baseFilters, ...drawtextFilters];

    const command = ffmpeg(inputPath)
      .videoFilters(allFilters)
      .outputOptions([
        '-c:v libx264', '-crf 23', '-preset fast',
        '-c:a aac', '-b:a 128k', '-movflags +faststart',
      ])
      .output(outputPath);

    command
      .on('progress', (progress) => {
        process.stdout.write(`\rProcessing (structured): ${Math.round(progress.percent || 0)}%`);
      })
      .on('end', () => {
        process.stdout.write('\n');
        resolve();
      })
      .on('error', (err) => {
        console.error('[applyStructuredTemplate] FFmpeg error:', err.message);
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
