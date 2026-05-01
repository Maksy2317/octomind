import { TemplateConfig, VideoFormat } from '../../types';

const TEMPLATES: TemplateConfig[] = [
  // ── STORIES ──────────────────────────────────────────────────────────────
  {
    id: 'stories-minimal',
    name: 'Minimal White',
    format: 'stories',
    tags: ['lifestyle', 'personal', 'casual', 'bright'],
    description: 'Clean minimal look with subtle vignette. Perfect for everyday content.',
    thumbnail: 'https://placehold.co/200x356/ffffff/333333?text=Minimal',
    ffmpegFilters: {
      colorAdjust: { brightness: 0.05, contrast: 1.1, saturation: 1.0 },
      vignette: true,
    },
  },
  {
    id: 'stories-warm',
    name: 'Warm Glow',
    format: 'stories',
    tags: ['lifestyle', 'food', 'travel', 'romantic', 'warm'],
    description: 'Warm golden tones that evoke emotion and nostalgia.',
    thumbnail: 'https://placehold.co/200x356/f7c59f/333333?text=Warm',
    ffmpegFilters: {
      colorAdjust: { brightness: 0.02, contrast: 1.05, saturation: 1.3 },
      vignette: true,
    },
  },
  {
    id: 'stories-bold',
    name: 'Bold Frame',
    format: 'stories',
    tags: ['fashion', 'beauty', 'product', 'bold'],
    description: 'Black border frame for editorial and fashion content.',
    thumbnail: 'https://placehold.co/200x356/000000/ffffff?text=Bold',
    ffmpegFilters: {
      colorAdjust: { brightness: -0.02, contrast: 1.2, saturation: 0.9 },
    },
    borderConfig: { color: 'black', width: 20 },
  },

  // ── REELS ─────────────────────────────────────────────────────────────────
  {
    id: 'reels-gradient',
    name: 'Neon Gradient',
    format: 'reels',
    tags: ['trending', 'dynamic', 'music', 'entertainment', 'energetic'],
    description: 'High-contrast vibrant look that pops in the feed.',
    thumbnail: 'https://placehold.co/200x356/6c63ff/ffffff?text=Neon',
    ffmpegFilters: {
      colorAdjust: { brightness: 0.0, contrast: 1.3, saturation: 1.5 },
      vignette: false,
    },
  },
  {
    id: 'reels-cinematic',
    name: 'Cinematic Dark',
    format: 'reels',
    tags: ['travel', 'cinematic', 'professional', 'storytelling'],
    description: 'Dark cinematic grade for travel and premium content.',
    thumbnail: 'https://placehold.co/200x356/1a1a2e/ffffff?text=Cinema',
    ffmpegFilters: {
      colorAdjust: { brightness: -0.05, contrast: 1.15, saturation: 0.85 },
      vignette: true,
    },
  },
  {
    id: 'reels-vibrant',
    name: 'Vibrant Pop',
    format: 'reels',
    tags: ['fitness', 'sports', 'fun', 'youth', 'engaging'],
    description: 'Saturated and punchy. Great for fitness and action content.',
    thumbnail: 'https://placehold.co/200x356/ff4757/ffffff?text=Vibrant',
    ffmpegFilters: {
      colorAdjust: { brightness: 0.05, contrast: 1.2, saturation: 1.6 },
    },
  },

  // ── TIKTOK ────────────────────────────────────────────────────────────────
  {
    id: 'tiktok-neon',
    name: 'Neon Pop',
    format: 'tiktok',
    tags: ['fun', 'youth', 'trending', 'viral', 'playful'],
    description: 'Super saturated neon style — made for virality.',
    thumbnail: 'https://placehold.co/200x356/0be881/1a1a2e?text=Neon+Pop',
    ffmpegFilters: {
      colorAdjust: { brightness: 0.03, contrast: 1.25, saturation: 1.8 },
      vignette: false,
    },
  },
  {
    id: 'tiktok-clean',
    name: 'Clean TikTok',
    format: 'tiktok',
    tags: ['educational', 'tech', 'tutorial', 'professional'],
    description: 'Clean and clear. Perfect for tutorials and educational content.',
    thumbnail: 'https://placehold.co/200x356/f0f0f0/333333?text=Clean',
    ffmpegFilters: {
      colorAdjust: { brightness: 0.05, contrast: 1.1, saturation: 1.0 },
    },
  },
  {
    id: 'tiktok-vintage',
    name: 'Retro Vintage',
    format: 'tiktok',
    tags: ['lifestyle', 'retro', 'nostalgic', 'aesthetic'],
    description: 'Retro film look — trending aesthetic on TikTok.',
    thumbnail: 'https://placehold.co/200x356/c9a96e/1a1a2e?text=Retro',
    ffmpegFilters: {
      colorAdjust: { brightness: -0.02, contrast: 0.95, saturation: 0.75 },
      vignette: true,
    },
  },
  {
    id: 'tiktok-capcut',
    name: 'CapCut Cinematic',
    format: 'tiktok',
    tags: ['cinematic', 'professional', 'storytelling', 'travel', 'premium'],
    description: 'Dark cinematic grade loved by CapCut creators. Deep shadows, cool tones.',
    thumbnail: 'https://placehold.co/200x356/141414/a0cfff?text=CapCut',
    ffmpegFilters: {
      colorAdjust: { brightness: -0.06, contrast: 1.2, saturation: 0.88 },
      vignette: true,
    },
  },
  {
    id: 'tiktok-trending',
    name: 'Trending Hot',
    format: 'tiktok',
    tags: ['trending', 'viral', 'energetic', 'music', 'dance', 'fun'],
    description: 'Max energy — high saturation & contrast. Designed to stop the scroll.',
    thumbnail: 'https://placehold.co/200x356/ff0080/ffcc00?text=Trending',
    ffmpegFilters: {
      colorAdjust: { brightness: 0.05, contrast: 1.35, saturation: 2.0 },
      vignette: false,
    },
  },
  {
    id: 'tiktok-moody',
    name: 'Moody Dark',
    format: 'tiktok',
    tags: ['aesthetic', 'moody', 'dark', 'artistic', 'fashion', 'beauty'],
    description: 'Deep purple-dark aesthetic — popular in fashion and beauty niches.',
    thumbnail: 'https://placehold.co/200x356/0a0a0f/c084fc?text=Moody',
    ffmpegFilters: {
      colorAdjust: { brightness: -0.1, contrast: 1.15, saturation: 0.95 },
      vignette: true,
    },
  },
];

export function getTemplatesForFormat(format: VideoFormat, tags: string[]): TemplateConfig[] {
  const formatTemplates = TEMPLATES.filter(t => t.format === format);

  if (tags.length === 0) return formatTemplates;

  // Score templates by how many tags match
  const scored = formatTemplates.map(template => ({
    template,
    score: tags.filter(tag => template.tags.includes(tag)).length,
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.template);
}

export function getTemplateById(id: string): TemplateConfig | undefined {
  return TEMPLATES.find(t => t.id === id);
}

export function getAllTemplates(): TemplateConfig[] {
  return TEMPLATES;
}
