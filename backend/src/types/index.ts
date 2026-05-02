export type VideoFormat = 'stories' | 'reels' | 'tiktok';

export interface TextSlot {
  id: string;
  label: string;
  description: string;
  startSec: number;       // seconds from start
  endSec: number;         // seconds (use 9999 for "until end")
  position: 'top' | 'center' | 'bottom';
  style: 'hook' | 'point' | 'label' | 'cta';
  defaultText: string;
  maxChars: number;
}

export interface StructuredTemplate {
  id: string;
  name: string;
  description: string;
  emoji: string;
  category: 'education' | 'transformation' | 'promotion' | 'storytelling';
  platforms: string[];
  slots: TextSlot[];
  colorAdjust: { brightness: number; contrast: number; saturation: number };
  tags: string[];
  structured?: boolean;
}

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

export interface TemplateConfig {
  id: string;
  name: string;
  format: VideoFormat;
  tags: string[];           // Matched against analysis tags
  description: string;
  thumbnail: string;        // URL or local path
  ffmpegFilters: FFmpegFilterConfig;
  textOverlay?: TextOverlayConfig;
  borderConfig?: BorderConfig;
  structured?: boolean;
}

export interface FFmpegFilterConfig {
  scale?: string;           // e.g. "1080:1920"
  pad?: string;             // e.g. "1080:1920:(ow-iw)/2:(oh-ih)/2:black"
  colorAdjust?: {
    brightness?: number;
    contrast?: number;
    saturation?: number;
  };
  vignette?: boolean;
  blur?: string;
  overlay?: string;
}

export interface TextOverlayConfig {
  text: string;
  fontsize: number;
  fontcolor: string;
  x: string;
  y: string;
  box?: boolean;
  boxcolor?: string;
}

export interface BorderConfig {
  color: string;
  width: number;
}

export interface ProcessingJob {
  jobId: string;
  status: 'queued' | 'processing' | 'done' | 'error';
  progress: number;
  outputUrl?: string;
  error?: string;
}

export interface AIProvider {
  analyzeVideo(videoPath: string, format: VideoFormat): Promise<VideoAnalysis>;
  analyzeFrame(frameBase64: string, format: VideoFormat): Promise<VideoAnalysis>;
}
