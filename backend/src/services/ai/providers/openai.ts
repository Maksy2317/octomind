import { OpenAI } from 'openai';
import fs from 'fs';
import path from 'path';
import { AIProvider, VideoAnalysis, VideoFormat } from '../../../types';
import { extractFrames } from '../../video/frameExtractor';

export class OpenAIProvider implements AIProvider {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI();
  }

  async analyzeVideo(videoPath: string, format: VideoFormat): Promise<VideoAnalysis> {
    // Extract key frames from the video for vision analysis
    const framePaths = await extractFrames(videoPath, 3);

    const imageContent = framePaths.map(framePath => {
      const imageData = fs.readFileSync(framePath);
      const base64 = imageData.toString('base64');
      return {
        type: 'image_url' as const,
        image_url: {
          url: `data:image/jpeg;base64,${base64}`,
          detail: 'low' as const,
        },
      };
    });

    const prompt = `You are an expert social media video marketing analyst.
Analyze these video frames for a ${format.toUpperCase()} format post.

Return a JSON object with:
- tags: string[] (5-8 content tags like "lifestyle", "food", "fitness", "travel", "beauty", "tech", "entertainment")
- mood: string (e.g. "energetic", "calm", "playful", "professional", "romantic")
- dominantColors: string[] (2-3 hex color codes that represent the visual palette)
- hasText: boolean
- hasFaces: boolean
- hasPeople: boolean
- energy: "low" | "medium" | "high"
- suggestedStyle: string (e.g. "minimal-clean", "bold-gradient", "neon-pop", "elegant-dark", "warm-vintage")
- duration: number (estimated ideal duration in seconds for ${format})

Reply with ONLY valid JSON, no markdown.`;

    const response = await this.client.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: prompt }, ...imageContent],
        },
      ],
      max_tokens: 500,
    });

    // Cleanup temp frames
    framePaths.forEach(f => {
      try { fs.unlinkSync(f); } catch {}
    });

    const content = response.choices[0]?.message?.content || '{}';
    return JSON.parse(content) as VideoAnalysis;
  }
}
