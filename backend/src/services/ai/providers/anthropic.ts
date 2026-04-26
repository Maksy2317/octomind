import { Anthropic } from '@anthropic-ai/sdk';
import fs from 'fs';
import { AIProvider, VideoAnalysis, VideoFormat } from '../../../types';
import { extractFrames } from '../../video/frameExtractor';

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic();
  }

  async analyzeVideo(videoPath: string, format: VideoFormat): Promise<VideoAnalysis> {
    const framePaths = await extractFrames(videoPath, 3);

    const imageBlocks = framePaths.map(framePath => {
      const imageData = fs.readFileSync(framePath);
      const base64 = imageData.toString('base64');
      return {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: 'image/jpeg' as const,
          data: base64,
        },
      };
    });

    const prompt = `You are an expert social media video marketing analyst.
Analyze these video frames for a ${format.toUpperCase()} format post.

Return a JSON object with:
- tags: string[] (5-8 content tags like "lifestyle", "food", "fitness", "travel", "beauty", "tech", "entertainment")
- mood: string (e.g. "energetic", "calm", "playful", "professional", "romantic")
- dominantColors: string[] (2-3 hex color codes)
- hasText: boolean
- hasFaces: boolean
- hasPeople: boolean
- energy: "low" | "medium" | "high"
- suggestedStyle: string (e.g. "minimal-clean", "bold-gradient", "neon-pop", "elegant-dark", "warm-vintage")
- duration: number (ideal duration in seconds for ${format})

Reply with ONLY valid JSON, no markdown.`;

    const response = await this.client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: [
            ...imageBlocks,
            { type: 'text', text: prompt },
          ],
        },
      ],
    });

    framePaths.forEach(f => {
      try { fs.unlinkSync(f); } catch {}
    });

    const content = response.content[0];
    if (content.type !== 'text') throw new Error('Unexpected response type from Anthropic');
    return JSON.parse(content.text) as VideoAnalysis;
  }
}
