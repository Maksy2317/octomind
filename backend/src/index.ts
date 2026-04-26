import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { videoRouter } from './routes/video';
import { errorHandler } from './middleware/errorHandler';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Ensure output directory exists
const outputDir = process.env.OUTPUT_DIR || './uploads/output';
fs.mkdirSync(outputDir, { recursive: true });

app.use(cors({
  origin: (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean),
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve processed videos
app.use('/output', express.static(path.resolve(outputDir)));

app.use('/api/video', videoRouter);

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
