import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ffmpegStatic = require('ffmpeg-static');
  if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic);
} catch { /* rely on system FFmpeg */ }

export function extractFrames(videoPath: string, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const tmpDir = os.tmpdir();
    const frameId = uuidv4();
    const outputPattern = path.join(tmpDir, `frame_${frameId}_%d.jpg`);
    const frames: string[] = [];

    ffmpeg(videoPath)
      .outputOptions([
        `-vf fps=1/${Math.floor(15 / count)},scale=512:-1`,
        `-frames:v ${count}`,
      ])
      .output(outputPattern)
      .on('end', () => {
        for (let i = 1; i <= count; i++) {
          const framePath = path.join(tmpDir, `frame_${frameId}_${i}.jpg`);
          frames.push(framePath);
        }
        resolve(frames);
      })
      .on('error', reject)
      .run();
  });
}
