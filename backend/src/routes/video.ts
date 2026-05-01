import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { analyzeVideo, analyzeFrame } from '../services/ai';
import { applyTemplate } from '../services/video/processor';
import { getTemplateById, getTemplatesForFormat } from '../services/templates';
import { VideoFormat, TemplateConfig } from '../types';

export const videoRouter = Router();

const storage = multer.diskStorage({
  destination: process.env.UPLOAD_DIR || './uploads',
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB || '200') * 1024 * 1024) },
  fileFilter: (_req, file, cb) => {
    const allowed = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Only video files allowed (mp4, mov, avi, webm)'));
  },
});

/** Find uploaded file by videoId regardless of extension */
function findVideoFile(videoId: string): string | null {
  const uploadDir = process.env.UPLOAD_DIR || './uploads';
  const exts = ['.mp4', '.mov', '.avi', '.webm'];
  for (const ext of exts) {
    const p = path.join(uploadDir, `${videoId}${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// POST /api/video/upload
videoRouter.post('/upload', upload.single('video'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'No video file provided' }); return; }
    const videoId = path.parse(req.file.filename).name;
    res.json({ videoId, filename: req.file.filename, size: req.file.size, mimetype: req.file.mimetype });
  } catch (err) { next(err); }
});

// POST /api/video/analyze-frame  ← new: client sends a base64 frame, no FFmpeg needed for analysis
videoRouter.post('/analyze-frame', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { frame, format } = req.body as { frame: string; format: VideoFormat };
    if (!frame || !format) { res.status(400).json({ error: 'frame and format are required' }); return; }

    const analysis = await analyzeFrame(frame, format);
    const templates = getTemplatesForFormat(format, analysis.tags);
    res.json({ analysis, templates });
  } catch (err) { next(err); }
});

// POST /api/video/analyze  (legacy — server-side frame extraction with FFmpeg)
videoRouter.post('/analyze', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { videoId, format } = req.body as { videoId: string; format: VideoFormat };
    if (!videoId || !format) { res.status(400).json({ error: 'videoId and format are required' }); return; }

    const videoPath = findVideoFile(videoId);
    if (!videoPath) { res.status(404).json({ error: 'Video file not found' }); return; }

    const analysis = await analyzeVideo(videoPath, format);
    const templates = getTemplatesForFormat(format, analysis.tags);
    res.json({ analysis, templates });
  } catch (err) { next(err); }
});

// POST /api/video/process  ← applies FFmpeg template + optional custom overlay
videoRouter.post('/process', async (req: Request, res: Response, next: NextFunction) => {
  let overlayPath: string | null = null;
  try {
    const { videoId, templateId, format, customOverlay } =
      req.body as { videoId: string; templateId: string; format: VideoFormat; customOverlay?: string };

    if (!videoId || !templateId || !format) {
      res.status(400).json({ error: 'videoId, templateId, and format are required' }); return;
    }

    const inputPath = findVideoFile(videoId);
    if (!inputPath) { res.status(404).json({ error: 'Video file not found' }); return; }

    // Resolve template — for 'custom', use a neutral base template
    let template: TemplateConfig | undefined;
    if (templateId === 'custom') {
      template = {
        id: 'custom',
        name: 'Custom Template',
        format: format,
        tags: [],
        description: 'User-provided overlay template',
        thumbnail: '',
        ffmpegFilters: { colorAdjust: { brightness: 0, contrast: 1, saturation: 1 } },
      };
    } else {
      const found = getTemplateById(templateId);
      if (!found) { res.status(404).json({ error: 'Template not found' }); return; }
      template = found;
    }

    // Save custom overlay image if provided
    if (customOverlay) {
      overlayPath = path.join(os.tmpdir(), `overlay_${uuidv4()}.png`);
      const buffer = Buffer.from(customOverlay, 'base64');
      fs.writeFileSync(overlayPath, buffer);
    }

    const outputDir = process.env.OUTPUT_DIR || './uploads/output';
    fs.mkdirSync(outputDir, { recursive: true });
    const outputFilename = `${videoId}_${templateId}.mp4`;
    const outputPath = path.join(outputDir, outputFilename);

    await applyTemplate(inputPath, outputPath, template, format, overlayPath ?? undefined);

    res.json({ downloadUrl: `/output/${outputFilename}` });
  } catch (err) {
    next(err);
  } finally {
    if (overlayPath) { try { fs.unlinkSync(overlayPath); } catch {} }
  }
});

// GET /api/video/templates/:format
videoRouter.get('/templates/:format', (req: Request, res: Response) => {
  const format = req.params.format as VideoFormat;
  res.json({ templates: getTemplatesForFormat(format, []) });
});
