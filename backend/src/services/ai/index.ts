import { VideoAnalysis, VideoFormat, AIProvider } from '../../types';
import { MockAIProvider } from './providers/mock';
import { OpenAIProvider } from './providers/openai';
import { AnthropicProvider } from './providers/anthropic';

function getProvider(): AIProvider {
  const provider = process.env.AI_PROVIDER || 'mock';

  switch (provider) {
    case 'openai':
      return new OpenAIProvider();
    case 'anthropic':
      return new AnthropicProvider();
    case 'mock':
    default:
      return new MockAIProvider();
  }
}

export async function analyzeVideo(videoPath: string, format: VideoFormat): Promise<VideoAnalysis> {
  const provider = getProvider();
  return provider.analyzeVideo(videoPath, format);
}
