import { Anthropic } from '@anthropic-ai/sdk';
import fs from 'fs';
import { AIProvider, VideoAnalysis, VideoFormat } from '../../../types';
import { extractFrames } from '../../video/frameExtractor';

const ANALYSIS_PROMPT = (format: string) => `You are an expert social media video marketing analyst.
Analyze this video frame for a ${format.toUpperCase()} format post.

Return a JSON object with ONLY these fields:
- tags: string[] (5-8 tags from: lifestyle, food, fitness, travel, beauty, tech, entertainment, fashion, business, comedy, education, music, sports, nature, art, trending, dynamic, calm, bright, dark, energetic, romantic, professional, youth, casual)
- mood: string (one word: energetic/calm/playful/professional/romantic/bold/minimal)
- dominantColors: string[] (2-3 hex color codes you see in the image)
- hasText: boolean
- hasFaces: boolean
- hasPeople: boolean
- energy: "low" | "medium" | "high"
- suggestedStyle: string (one of: minimal-clean, bold-gradient, neon-pop, elegant-dark, warm-vintage, vibrant-pop, cinematic)
- duration: number (ideal seconds for ${format}: stories=15, reels=30, tiktok=30)

Reply with ONLY valid JSON, no markdown, no explanation.`;

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic();
  }

  async analyzeFrame(frameBase64: string, format: VideoFormat): Promise<VideoAnalysis> {
    const response = await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: frameBase64 },
            },
            { type: 'text', text: ANALYSIS_PROMPT(format) },
          ],
        },
      ],
    });

    const content = response.content[0];
    if (content.type !== 'text') throw new Error('Unexpected response type from Anthropic');
    // Strip any accidental markdown fences
    const cleaned = content.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned) as VideoAnalysis;
  }

  async analyzeVideo(videoPath: string, format: VideoFormat): Promise<VideoAnalysis> {
    const framePaths = await extractFrames(videoPath, 1);
    const imageData = fs.readFileSync(framePaths[0]);
    const base64 = imageData.toString('base64');
    framePaths.forEach(f => { try { fs.unlinkSync(f); } catch {} });
    return this.analyzeFrame(base64, format);
  }
}
