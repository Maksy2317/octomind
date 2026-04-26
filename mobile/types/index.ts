export type VideoFormat = 'stories' | 'reels' | 'tiktok';

export interface VideoAnalysis {
  tags: string[];
  mood: string;
  dominantColors: string[];
  hasText: boolean;
  hasFaces: boolean;
  hasPeople: boolean;
  energy: 'low' | 'medium' | 'high';
  suggestedStyle: string;
  duration: number;
}

export interface Template {
  id: string;
  name: string;
  format: VideoFormat;
  tags: string[];
  description: string;
  thumbnail: string;
}

export interface AppState {
  // Upload
  videoUri: string | null;
  videoId: string | null;
  videoSize: number | null;

  // Format
  selectedFormat: VideoFormat | null;

  // Analysis
  analysis: VideoAnalysis | null;
  isAnalyzing: boolean;

  // Templates
  templates: Template[];
  selectedTemplate: Template | null;

  // Processing
  isProcessing: boolean;
  processedVideoUrl: string | null;

  // Actions
  setVideo: (uri: string, id: string, size: number) => void;
  setFormat: (format: VideoFormat) => void;
  setAnalysis: (analysis: VideoAnalysis, templates: Template[]) => void;
  setSelectedTemplate: (template: Template) => void;
  setProcessing: (processing: boolean) => void;
  setProcessedVideo: (url: string) => void;
  reset: () => void;
}
