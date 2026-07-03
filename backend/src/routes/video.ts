import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { analyzeVideo, analyzeFrame, generateTextSuggestions } from '../services/ai';
import { applyTemplate, applyStructuredTemplate } from '../services/video/processor';
import { analyzeFrameForLayout } from '../services/video/smartLayout';
import {
  getTemplateById,
  getTemplatesForFormat,
  getAllStructuredTemplates,
  getStructuredTemplateById,
} from '../services/templates';
import { VideoFormat, TemplateConfig } from '../types';

export const videoRouter = Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(process.cwd(), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
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
  const exts = ['.mp4', '.mov', '.avi', '.webm'];
  for (const ext of exts) {
    const p = path.join(UPLOAD_DIR, `${videoId}${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── Input safety helpers ─────────────────────────────────────────────────────
// videoId is a UUID (see multer filename). Reject anything else so it can never
// be used for path traversal when building a file path.
const UUID_RE = /^[0-9a-fA-F-]{36}$/;
function isValidVideoId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}
// templateId ends up in an output filename — restrict to safe characters.
const TEMPLATE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
function isValidTemplateId(id: unknown): id is string {
  return typeof id === 'string' && TEMPLATE_ID_RE.test(id);
}

// Max size of base64 payloads (characters). ~10M chars ≈ ~7.5 MB decoded.
const MAX_FRAME_B64 = Number(process.env.MAX_FRAME_B64_CHARS) || 10 * 1024 * 1024;
const MAX_OVERLAY_B64 = Number(process.env.MAX_OVERLAY_B64_CHARS) || 10 * 1024 * 1024;

// POST /api/video/upload
videoRouter.post('/upload', upload.single('video'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'No video file provided' }); return; }
    const videoId = path.parse(req.file.filename).name;
    res.json({ videoId, filename: req.file.filename, size: req.file.size, mimetype: req.file.mimetype });
  } catch (err) { next(err); }
});

// POST /api/video/analyze-frame  ← client sends a base64 frame, no FFmpeg needed for analysis
videoRouter.post('/analyze-frame', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { frame, format, templateId } = req.body as { frame: string; format: VideoFormat; templateId?: string };
    if (!frame || !format) { res.status(400).json({ error: 'frame and format are required' }); return; }
    if (typeof frame !== 'string' || frame.length > MAX_FRAME_B64) {
      res.status(413).json({ error: 'Frame image is too large' }); return;
    }
    if (templateId !== undefined && !isValidTemplateId(templateId)) {
      res.status(400).json({ error: 'Invalid templateId' }); return;
    }

    const analysis = await analyzeFrame(frame, format);
    const templates = getTemplatesForFormat(format, analysis.tags);

    let textSuggestions: Record<string, string> | undefined;

    // If a structured templateId is provided, generate AI text suggestions
    if (templateId) {
      const structuredTemplate = getStructuredTemplateById(templateId);
      if (structuredTemplate) {
        try {
          textSuggestions = await generateTextSuggestions(frame, templateId, structuredTemplate.slots);
        } catch (aiErr) {
          console.warn('[analyze-frame] Could not generate text suggestions:', (aiErr as Error).message);
        }
      }
    }

    res.json({ analysis, templates, ...(textSuggestions ? { textSuggestions } : {}) });
  } catch (err) { next(err); }
});

// POST /api/video/analyze  (legacy — server-side frame extraction with FFmpeg)
videoRouter.post('/analyze', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { videoId, format } = req.body as { videoId: string; format: VideoFormat };
    if (!videoId || !format) { res.status(400).json({ error: 'videoId and format are required' }); return; }
    if (!isValidVideoId(videoId)) { res.status(400).json({ error: 'Invalid videoId' }); return; }

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
    const { videoId, templateId, format, customOverlay, textInputs, structured, slotStyleOverrides } =
      req.body as {
        videoId: string;
        templateId: string;
        format: VideoFormat;
        customOverlay?: string;
        textInputs?: Record<string, string>;
        structured?: boolean;
        slotStyleOverrides?: Record<string, { color?: string }>;
      };

    if (!videoId || !templateId || !format) {
      res.status(400).json({ error: 'videoId, templateId, and format are required' }); return;
    }
    if (!isValidVideoId(videoId)) { res.status(400).json({ error: 'Invalid videoId' }); return; }
    if (!isValidTemplateId(templateId)) { res.status(400).json({ error: 'Invalid templateId' }); return; }
    if (customOverlay !== undefined) {
      if (typeof customOverlay !== 'string' || customOverlay.length > MAX_OVERLAY_B64) {
        res.status(413).json({ error: 'Custom overlay image is too large' }); return;
      }
    }

    const inputPath = findVideoFile(videoId);
    if (!inputPath) { res.status(404).json({ error: 'Video file not found' }); return; }

    const outputDir = process.env.OUTPUT_DIR
      ? path.resolve(process.env.OUTPUT_DIR)
      : path.resolve(process.cwd(), 'uploads/output');
    fs.mkdirSync(outputDir, { recursive: true });
    const outputFilename = `${videoId}_${templateId}.mp4`;
    const outputPath = path.join(outputDir, outputFilename);

    // ── Structured template path ─────────────────────────────────────────────
    if (structured && textInputs) {
      const structuredTemplate = getStructuredTemplateById(templateId);
      if (!structuredTemplate) {
        res.status(404).json({ error: 'Structured template not found' }); return;
      }
      // Analyse frame brightness + (optionally) face position via Claude Vision
      const layoutHints = await analyzeFrameForLayout(inputPath);
      console.log(`[process] layoutHints — avoidZone:${layoutHints.avoidZone} needsDarkBox:${layoutHints.needsDarkBox} usedVision:${layoutHints.usedVision}`);

      await applyStructuredTemplate(inputPath, outputPath, structuredTemplate, textInputs, format, layoutHints, slotStyleOverrides);
      res.json({ downloadUrl: `/output/${outputFilename}` });
      return;
    }

    // ── Legacy template path ─────────────────────────────────────────────────

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

    await applyTemplate(inputPath, outputPath, template, format, overlayPath ?? undefined);

    res.json({ downloadUrl: `/output/${outputFilename}` });
  } catch (err) {
    next(err);
  } finally {
    if (overlayPath) { try { fs.unlinkSync(overlayPath); } catch {} }
  }
});

// GET /api/video/structured-templates
videoRouter.get('/structured-templates', (_req: Request, res: Response) => {
  res.json({ templates: getAllStructuredTemplates() });
});

// GET /api/video/templates/:format
videoRouter.get('/templates/:format', (req: Request, res: Response) => {
  const format = req.params.format as VideoFormat;
  res.json({ templates: getTemplatesForFormat(format, []) });
});
