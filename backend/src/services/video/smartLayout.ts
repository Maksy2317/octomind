/**
 * Smart layout analysis for structured video templates.
 *
 * Phase 1 (free): Extract one frame with FFmpeg, measure average luma in three
 * horizontal zones (top / center / bottom) using the `signalstats` filter.
 *   • Brightest zone → likely the subject / face → put it last in the point cycle.
 *   • Average brightness → whether text needs a dark opaque box.
 *
 * Phase 2 (Claude Haiku, ~$0.001): Only called when all zones are similarly
 * bright AND average brightness is high (ambiguous for placement).  We send a
 * single 540-px-wide JPEG to claude-3-haiku and get back a one-line JSON with
 * faceZone + textColor.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface LayoutHints {
  /** Zone that is visually busiest (likely face/subject) — prefer NOT to place text here */
  avoidZone: 'top' | 'center' | 'bottom' | null;
  /** Average luma 0-255 per zone */
  zoneBrightness: { top: number; center: number; bottom: number };
  /**
   * Whether overall background is bright → Point/Hook text should get a dark box
   * (otherwise we keep the leaner outline-only style).
   */
  needsDarkBox: boolean;
  /** Whether Claude Vision was used (for logging / billing awareness) */
  usedVision: boolean;
}

const DEFAULT_HINTS: LayoutHints = {
  avoidZone: null,
  zoneBrightness: { top: 128, center: 128, bottom: 128 },
  needsDarkBox: false,
  usedVision: false,
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Parse the "YAVG: <value>" line that ffmpeg signalstats prints to stderr. */
function parseYavg(output: string): number {
  const m = output.match(/YAVG:\s*([0-9.]+)/);
  return m ? parseFloat(m[1]) : 128;
}

/**
 * Get average luma for a 540×320 crop of the video.
 * We scale the frame to 540×960 first so the offsets are constant regardless
 * of the original resolution.
 */
function getZoneLuma(videoPath: string, seekSec: number, yOffset: number): number {
  const r = spawnSync(
    'ffmpeg',
    [
      '-ss', String(seekSec),
      '-i', videoPath,
      '-vf',
      `scale=540:960:force_original_aspect_ratio=increase,crop=540:960,` +
      `crop=540:320:0:${yOffset},signalstats`,
      '-frames:v', '1',
      '-f', 'null', '-',
    ],
    { encoding: 'utf8', timeout: 12_000 },
  );
  return parseYavg(r.stderr ?? '');
}

function getVideoDuration(videoPath: string): number {
  const r = spawnSync(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ],
    { encoding: 'utf8', timeout: 8_000 },
  );
  const d = parseFloat(r.stdout?.trim() ?? '');
  return isNaN(d) || d <= 0 ? 5 : d;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function analyzeFrameForLayout(videoPath: string): Promise<LayoutHints> {
  try {
    const duration  = getVideoDuration(videoPath);
    const seekSec   = Math.max(0.5, duration * 0.15);

    // Measure brightness in three 540×320 slices (top=0, center=320, bottom=640)
    const top    = getZoneLuma(videoPath, seekSec, 0);
    const center = getZoneLuma(videoPath, seekSec, 320);
    const bottom = getZoneLuma(videoPath, seekSec, 640);

    console.log(`[smartLayout] luma — top:${top.toFixed(1)} center:${center.toFixed(1)} bottom:${bottom.toFixed(1)}`);

    const zones = [
      { name: 'top'    as const, val: top    },
      { name: 'center' as const, val: center },
      { name: 'bottom' as const, val: bottom },
    ].sort((a, b) => b.val - a.val); // brightest first

    const brightestDiff = zones[0].val - zones[2].val;
    const avgBrightness = (top + center + bottom) / 3;

    // Avoid the brightest zone only if it stands out meaningfully
    let avoidZone: LayoutHints['avoidZone'] = brightestDiff > 25 ? zones[0].name : null;
    const needsDarkBox = avgBrightness > 145;

    // ── Phase 2: Claude Vision when zones are ambiguous AND all bright ─────
    const allSimilar = brightestDiff < 20;
    let usedVision = false;

    if (allSimilar && avgBrightness > 110 && process.env.ANTHROPIC_API_KEY) {
      const framePath = path.join(os.tmpdir(), `sl_frame_${uuidv4()}.jpg`);
      try {
        const ext = spawnSync(
          'ffmpeg',
          [
            '-ss', String(seekSec),
            '-i', videoPath,
            '-vf', 'scale=540:-1',
            '-frames:v', '1',
            '-q:v', '4',
            framePath,
          ],
          { encoding: 'utf8', timeout: 10_000 },
        );

        if (ext.status === 0 && fs.existsSync(framePath)) {
          const b64 = fs.readFileSync(framePath).toString('base64');

          // Dynamic import keeps startup lean when Vision is never needed
          const { default: Anthropic } = await import('@anthropic-ai/sdk');
          const client = new Anthropic();

          const resp = await client.messages.create({
            model: 'claude-3-haiku-20240307',
            max_tokens: 120,
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/jpeg', data: b64 },
                },
                {
                  type: 'text',
                  text:
                    'Video frame for text-overlay placement. ' +
                    'Return ONLY valid JSON (no markdown):\n' +
                    '{"faceZone":"top"|"center"|"bottom"|"none"}',
                },
              ],
            }],
          });

          const raw = ((resp.content[0] as { text?: string }).text ?? '').trim();
          // Strip possible markdown code fence
          const jsonStr = raw.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
          const parsed = JSON.parse(jsonStr) as { faceZone?: string };

          if (parsed.faceZone && parsed.faceZone !== 'none') {
            avoidZone = parsed.faceZone as LayoutHints['avoidZone'];
          }
          usedVision = true;
          console.log(`[smartLayout] Claude Vision → faceZone:${parsed.faceZone}`);
        }
      } catch (e) {
        console.warn('[smartLayout] Claude Vision failed, using brightness only:', (e as Error).message);
      } finally {
        try { if (fs.existsSync(framePath)) fs.unlinkSync(framePath); } catch { /* ignore */ }
      }
    }

    return {
      avoidZone,
      zoneBrightness: { top, center, bottom },
      needsDarkBox,
      usedVision,
    };
  } catch (err) {
    console.warn('[smartLayout] Analysis failed, using defaults:', (err as Error).message);
    return { ...DEFAULT_HINTS };
  }
}
