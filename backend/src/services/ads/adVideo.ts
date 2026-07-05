// Ad video assembly — pure ffmpeg, NO AI video model (no per-second cost).
//
// Each scene is a pre-composited still (background + product cutout + baked-in
// text, made client-side via canvas). ffmpeg gives it motion (Ken Burns
// zoom/pan), cross-fades between scenes, optional music, and renders an mp4.
// Text is already in the frames, so we avoid drawtext/libass — this runs on
// ffmpeg-static (dev) AND system ffmpeg (Railway) identically.
//
// The expensive AI "make the product actually move" (Kling/Wan) is a later
// premium upgrade that would replace the still-with-zoom per scene.

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const FFMPEG: string = require('ffmpeg-static');

export type Motion = 'zoom_in' | 'zoom_out' | 'pan_left' | 'pan_right' | 'none';

export interface VideoScene {
  image: string;       // absolute path to the scene PNG/JPG
  duration: number;    // seconds on screen
  motion: Motion;
}

export interface AssembleOpts {
  scenes: VideoScene[];
  width: number;
  height: number;
  fps?: number;
  fade?: number;       // cross-fade seconds between scenes
  audio?: string | null;   // absolute path to a music file, or null
  out: string;         // absolute output .mp4 path
}

// zoompan expression per motion. `d` = frames the effect runs; we render each
// scene at fps*duration frames. Zoom eased from 1.0 → ~1.12 (or reverse).
function zoompanFilter(m: Motion, W: number, H: number, frames: number, fps: number): string {
  // Upscale ~1.4x (enough headroom for the zoom without zoompan jitter, but far
  // cheaper than 2x — zoompan renders frame-by-frame, pixels dominate cost).
  const SW = Math.round(W * 1.4), SH = Math.round(H * 1.4);
  const pre = `scale=${SW}:${SH}:force_original_aspect_ratio=increase,crop=${SW}:${SH}`;
  const zEnd = 1.12;
  let z: string, x: string, y: string;
  switch (m) {
    case 'zoom_out':
      z = `'if(eq(on,0),${zEnd},max(1.0,zoom-${(zEnd - 1) / frames}))'`;
      x = `'iw/2-(iw/zoom/2)'`; y = `'ih/2-(ih/zoom/2)'`;
      break;
    case 'pan_left':
      z = '1.1'; x = `'(iw-iw/zoom)*(1-on/${frames})'`; y = `'ih/2-(ih/zoom/2)'`;
      break;
    case 'pan_right':
      z = '1.1'; x = `'(iw-iw/zoom)*(on/${frames})'`; y = `'ih/2-(ih/zoom/2)'`;
      break;
    case 'none':
      z = '1.001'; x = `'iw/2-(iw/zoom/2)'`; y = `'ih/2-(ih/zoom/2)'`;
      break;
    case 'zoom_in':
    default:
      z = `'min(zoom+${(zEnd - 1) / frames},${zEnd})'`;
      x = `'iw/2-(iw/zoom/2)'`; y = `'ih/2-(ih/zoom/2)'`;
  }
  return `${pre},zoompan=z=${z}:x=${x}:y=${y}:d=${frames}:s=${W}x${H}:fps=${fps},setsar=1,format=yuv420p`;
}

export function assembleVideo(opts: AssembleOpts): Promise<void> {
  const fps = opts.fps || 25;
  const fade = opts.fade ?? 0.5;
  const W = opts.width - (opts.width % 2);
  const H = opts.height - (opts.height % 2);
  const scenes = opts.scenes.slice(0, 8);

  const args: string[] = ['-y'];
  // Feed ONE still frame per scene; zoompan's `d` (below) sets the clip length.
  // (Looping the input makes zoompan multiply d per frame → runaway duration.)
  scenes.forEach((s) => { args.push('-i', s.image); });
  if (opts.audio) args.push('-i', opts.audio);

  // Per-scene zoompan, then chain xfade transitions.
  const parts: string[] = [];
  scenes.forEach((s, i) => {
    const frames = Math.round((Math.max(1.2, s.duration) + (i < scenes.length - 1 ? fade : 0)) * fps);
    parts.push(`[${i}:v]${zoompanFilter(s.motion, W, H, frames, fps)}[v${i}]`);
  });
  let last = 'v0';
  let offset = Math.max(1.2, scenes[0].duration);
  for (let i = 1; i < scenes.length; i++) {
    const out = i === scenes.length - 1 ? 'vout' : `x${i}`;
    parts.push(`[${last}][v${i}]xfade=transition=fade:duration=${fade}:offset=${(offset - fade).toFixed(2)}[${out}]`);
    last = out;
    offset += Math.max(1.2, scenes[i].duration);
  }
  const vLabel = scenes.length === 1 ? 'v0' : 'vout';

  const filter = parts.join(';');
  args.push('-filter_complex', filter, '-map', `[${vLabel}]`);

  if (opts.audio) {
    const total = scenes.reduce((t, s) => t + Math.max(1.2, s.duration), 0);
    args.push('-map', `${scenes.length}:a`, '-shortest',
      '-af', `afade=t=out:st=${(total - 1).toFixed(2)}:d=1`, '-c:a', 'aac', '-b:a', '128k');
  }
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-movflags', '+faststart', '-r', String(fps), opts.out);

  return new Promise((resolve, reject) => {
    execFile(FFMPEG, args, { maxBuffer: 1 << 24 }, (err, _stdout, stderr) => {
      if (err) { reject(new Error(`ffmpeg failed: ${String(stderr).slice(-500)}`)); return; }
      if (!fs.existsSync(opts.out)) { reject(new Error('ffmpeg produced no output')); return; }
      resolve();
    });
  });
}

export function isFfmpegReady(): boolean {
  try { return Boolean(FFMPEG && fs.existsSync(FFMPEG)); } catch { return false; }
}
