import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { analyzeVideo } from '../services/ai';
import { applyTemplate } from '../services/video/processor';
import { getTemplateById, getTemplatesForFormat } from '../services/templates';
import { VideoFormat } from '../types';

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
  limits: {
    fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB || '200') * 1024 * 1024),
  },
  fileFilter: (_req, file, cb) => {
    const allowed = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed (mp4, mov, avi, webm)'));
    }
  },
});

// POST /api/video/upload
videoRouter.post('/upload', upload.single('video'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No video file provided' });
      return;
    }

    const videoId = path.parse(req.file.filename).name;
    res.json({
      videoId,
      filename: req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/video/analyze
videoRouter.post('/analyze', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { videoId, format } = req.body as { videoId: string; format: VideoFormat };

    if (!videoId || !format) {
      res.status(400).json({ error: 'videoId and format are required' });
      return;
    }

    const uploadDir = process.env.UPLOAD_DIR || './uploads';
    const videoPath = path.join(uploadDir, `${videoId}.mp4`);

    const analysis = await analyzeVideo(videoPath, format);
    const templates = getTemplatesForFormat(format, analysis.tags);

    res.json({ analysis, templates });
  } catch (err) {
    next(err);
  }
});

// POST /api/video/process
videoRouter.post('/process', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { videoId, templateId, format } = req.body as {
      videoId: string;
      templateId: string;
      format: VideoFormat;
    };

    if (!videoId || !templateId || !format) {
      res.status(400).json({ error: 'videoId, templateId, and format are required' });
      return;
    }

    const template = getTemplateById(templateId);
    if (!template) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    const uploadDir = process.env.UPLOAD_DIR || './uploads';
    const outputDir = process.env.OUTPUT_DIR || './uploads/output';
    const inputPath = path.join(uploadDir, `${videoId}.mp4`);
    const outputFilename = `${videoId}_processed_${templateId}.mp4`;
    const outputPath = path.join(outputDir, outputFilename);

    await applyTemplate(inputPath, outputPath, template, format);

    res.json({
      outputVideoId: outputFilename,
      downloadUrl: `/output/${outputFilename}`,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/video/templates/:format
videoRouter.get('/templates/:format', (req: Request, res: Response) => {
  const format = req.params.format as VideoFormat;
  const templates = getTemplatesForFormat(format, []);
  res.json({ templates });
});
