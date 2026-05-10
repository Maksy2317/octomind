import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { videoRouter } from './routes/video';
import { chatRouter } from './routes/chat';
import { subtitlesRouter } from './routes/subtitles';
import { carouselRouter } from './routes/carousel';
import { errorHandler } from './middleware/errorHandler';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Ensure output directory exists
const outputDir = process.env.OUTPUT_DIR
  ? path.resolve(process.env.OUTPUT_DIR)
  : path.resolve(process.cwd(), 'uploads/output');
fs.mkdirSync(outputDir, { recursive: true });

app.use(cors({
  origin: (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean),
  credentials: true,
}));

// Raise body-size limit to 20 MB so base64-encoded photos fit in JSON payloads
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Serve processed videos
app.use('/output', express.static(path.resolve(outputDir)));

// Serve original uploads so the frontend can use the un-rendered video as a clean
// preview canvas (no baked-in ASS text). Files are UUID-named so enumeration is hard.
const uploadDir = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(process.cwd(), 'uploads');
app.use('/uploads', express.static(uploadDir));

app.use('/api/video', videoRouter);
app.use('/api/chat', chatRouter);
app.use('/api/subtitles', subtitlesRouter);
app.use('/api/carousel', carouselRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve frontend (mobile folder)
const frontendDir = path.resolve(__dirname, '../../mobile');
app.use(express.static(frontendDir));
app.get('*', (_req, res) => {
  res.sendFile(path.join(frontendDir, 'web-demo.html'));
});

app.use(errorHandler);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Marketer Backend running on http://0.0.0.0:${PORT}`);
  console.log(`AI Provider: ${process.env.AI_PROVIDER || 'mock'}`);
});

export default app;
