import ffmpeg from 'fluent-ffmpeg';
import { TemplateConfig, VideoFormat } from '../../types';

const FORMAT_DIMENSIONS: Record<VideoFormat, { width: number; height: number }> = {
  stories: { width: 1080, height: 1920 },
  reels: { width: 1080, height: 1920 },
  tiktok: { width: 1080, height: 1920 },
};

export function applyTemplate(
  inputPath: string,
  outputPath: string,
  template: TemplateConfig,
  format: VideoFormat,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const { width, height } = FORMAT_DIMENSIONS[format];
    const { ffmpegFilters, colorAdjust } = buildFilters(template, width, height);

    let command = ffmpeg(inputPath)
      .videoFilters(ffmpegFilters)
      .outputOptions([
        '-c:v libx264',
        '-crf 23',
        '-preset fast',
        '-c:a aac',
        '-b:a 128k',
        '-movflags +faststart',
      ])
      .output(outputPath);

    if (template.textOverlay) {
      const { text, fontsize, fontcolor, x, y, box, boxcolor } = template.textOverlay;
      const boxOption = box ? `:box=1:boxcolor=${boxcolor || 'black@0.5'}:boxborderw=5` : '';
      command = command.videoFilters(
        `drawtext=text='${text}':fontsize=${fontsize}:fontcolor=${fontcolor}:x=${x}:y=${y}${boxOption}`,
      );
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

  // 4. Border / padding overlay
  if (template.borderConfig) {
    const { color, width: bw } = template.borderConfig;
    filters.push(
      `pad=${width}:${height}:${bw}:${bw}:${color}`,
    );
  }

  return { ffmpegFilters: filters, colorAdjust: '' };
}
