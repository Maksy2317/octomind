import { AIProvider, VideoAnalysis, VideoFormat } from '../../../types';

// Realistic mock — replace with real provider in production
export class MockAIProvider implements AIProvider {
  async analyzeVideo(videoPath: string, format: VideoFormat): Promise<VideoAnalysis> {
    // Simulate analysis delay
    await new Promise(resolve => setTimeout(resolve, 1500));

    const mockResults: Record<VideoFormat, Partial<VideoAnalysis>> = {
      stories: {
        tags: ['lifestyle', 'bright', 'personal', 'casual'],
        mood: 'warm',
        energy: 'medium',
        suggestedStyle: 'minimal-clean',
      },
      reels: {
        tags: ['trending', 'dynamic', 'engaging', 'music'],
        mood: 'energetic',
        energy: 'high',
        suggestedStyle: 'bold-gradient',
      },
      tiktok: {
        tags: ['fun', 'fast', 'youth', 'trending', 'viral'],
        mood: 'playful',
        energy: 'high',
        suggestedStyle: 'neon-pop',
      },
    };

    const base = mockResults[format];

    return {
      tags: base.tags!,
      mood: base.mood!,
      dominantColors: ['#FF6B6B', '#4ECDC4', '#45B7D1'],
      hasText: Math.random() > 0.5,
      hasFaces: Math.random() > 0.3,
      hasPeople: Math.random() > 0.4,
      energy: base.energy!,
      suggestedStyle: base.suggestedStyle!,
      duration: 15 + Math.floor(Math.random() * 45),
    };
  }
}
