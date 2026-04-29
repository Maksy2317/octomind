import { AIProvider, VideoAnalysis, VideoFormat } from '../../../types';

// Realistic mock — replace with real provider in production
export class MockAIProvider implements AIProvider {
  private async _mockAnalysis(format: VideoFormat): Promise<VideoAnalysis> {
    await new Promise(resolve => setTimeout(resolve, 800));
    const mockResults: Record<VideoFormat, Partial<VideoAnalysis>> = {
      stories: { tags: ['lifestyle', 'bright', 'personal', 'casual'], mood: 'warm', energy: 'medium', suggestedStyle: 'minimal-clean' },
      reels:   { tags: ['trending', 'dynamic', 'engaging', 'music'],  mood: 'energetic', energy: 'high', suggestedStyle: 'bold-gradient' },
      tiktok:  { tags: ['fun', 'youth', 'trending', 'viral', 'playful'], mood: 'playful', energy: 'high', suggestedStyle: 'neon-pop' },
    };
    const base = mockResults[format];
    return {
      tags: base.tags!,
      mood: base.mood!,
      dominantColors: ['#FF6B6B', '#4ECDC4', '#45B7D1'],
      hasText: false, hasFaces: true, hasPeople: true,
      energy: base.energy!,
      suggestedStyle: base.suggestedStyle!,
      duration: format === 'stories' ? 15 : 30,
    };
  }

  async analyzeFrame(_frameBase64: string, format: VideoFormat): Promise<VideoAnalysis> {
    return this._mockAnalysis(format);
  }

  async analyzeVideo(_videoPath: string, format: VideoFormat): Promise<VideoAnalysis> {
    return this._mockAnalysis(format);
  }
}
