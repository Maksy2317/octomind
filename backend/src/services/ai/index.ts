import { VideoAnalysis, VideoFormat, AIProvider, TextSlot } from '../../types';
import { MockAIProvider } from './providers/mock';
import { OpenAIProvider } from './providers/openai';
import { AnthropicProvider } from './providers/anthropic';
import { generateTextSuggestions as anthropicGenerateTextSuggestions } from './providers/anthropic';

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
  return getProvider().analyzeVideo(videoPath, format);
}

export async function analyzeFrame(frameBase64: string, format: VideoFormat): Promise<VideoAnalysis> {
  return getProvider().analyzeFrame(frameBase64, format);
}

/**
 * Generate AI text suggestions for structured template slots.
 * Only works when AI_PROVIDER=anthropic; other providers return empty suggestions.
 */
export async function generateTextSuggestions(
  frameBase64: string,
  templateId: string,
  slots: TextSlot[],
): Promise<Record<string, string>> {
  const provider = process.env.AI_PROVIDER || 'mock';
  if (provider !== 'anthropic') {
    // Non-Anthropic providers: return empty object (caller will use defaults)
    return {};
  }
  return anthropicGenerateTextSuggestions(frameBase64, templateId, slots);
}
