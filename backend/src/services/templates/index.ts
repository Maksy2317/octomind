import { TemplateConfig, VideoFormat, StructuredTemplate, TextSlot } from '../../types';

// ── LEGACY COLOR-FILTER TEMPLATES (kept for backward compatibility) ────────────

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

// ── STRUCTURED TEMPLATES with timed text overlays ─────────────────────────────

const STRUCTURED_TEMPLATES: StructuredTemplate[] = [
  // T1 — Hook Explainer
  {
    id: 'hook-explainer',
    name: 'Hook Explainer',
    description: 'Хук + 3 тезиси + CTA. Ідеально для освітнього контенту.',
    emoji: '🎯',
    category: 'education',
    platforms: ['tiktok', 'reels'],
    tags: ['educational', 'tutorial', 'professional', 'trending'],
    colorAdjust: { brightness: 0.0, contrast: 1.1, saturation: 1.0 },
    structured: true,
    slots: [
      {
        id: 'hook',
        label: 'Хук (перші 3 сек)',
        description: 'Перше речення, що зупиняє скрол',
        startSec: 0,
        endSec: 4,
        position: 'top',
        style: 'hook',
        defaultText: 'Ти робиш ЦЕ щодня і навіть не знаєш 👀',
        maxChars: 60,
      },
      {
        id: 'point1',
        label: 'Тезис #1',
        description: 'Перший ключовий пункт',
        startSec: 4,
        endSec: 12,
        position: 'center',
        style: 'point',
        defaultText: '1. Помилка, яку роблять 90%',
        maxChars: 60,
      },
      {
        id: 'point2',
        label: 'Тезис #2',
        description: 'Другий ключовий пункт',
        startSec: 12,
        endSec: 20,
        position: 'center',
        style: 'point',
        defaultText: '2. Що робити замість цього',
        maxChars: 60,
      },
      {
        id: 'point3',
        label: 'Тезис #3',
        description: 'Третій ключовий пункт',
        startSec: 20,
        endSec: 28,
        position: 'center',
        style: 'point',
        defaultText: '3. Результат після змін',
        maxChars: 60,
      },
      {
        id: 'cta',
        label: 'CTA',
        description: 'Заклик до дії наприкінці',
        startSec: 28,
        endSec: 9999,
        position: 'bottom',
        style: 'cta',
        defaultText: 'Зберігай щоб не загубити 💾',
        maxChars: 60,
      },
    ],
  },

  // T2 — Before → After
  {
    id: 'before-after',
    name: 'Before → After',
    description: 'Трансформація: покажи стан до і після.',
    emoji: '✨',
    category: 'transformation',
    platforms: ['tiktok', 'reels', 'stories'],
    tags: ['lifestyle', 'fitness', 'beauty', 'trending'],
    colorAdjust: { brightness: 0.02, contrast: 1.05, saturation: 1.1 },
    structured: true,
    slots: [
      {
        id: 'before_label',
        label: 'До (Before)',
        description: 'Лейбл першої частини',
        startSec: 0,
        endSec: 15,
        position: 'top',
        style: 'label',
        defaultText: 'BEFORE',
        maxChars: 20,
      },
      {
        id: 'before_desc',
        label: 'Опис ситуації До',
        description: 'Що було раніше',
        startSec: 0,
        endSec: 15,
        position: 'bottom',
        style: 'point',
        defaultText: 'Так виглядало раніше...',
        maxChars: 60,
      },
      {
        id: 'after_label',
        label: 'Після (After)',
        description: 'Лейбл другої частини',
        startSec: 15,
        endSec: 9999,
        position: 'top',
        style: 'label',
        defaultText: 'AFTER ✨',
        maxChars: 20,
      },
      {
        id: 'after_desc',
        label: 'Опис результату',
        description: 'Що змінилося',
        startSec: 15,
        endSec: 9999,
        position: 'bottom',
        style: 'point',
        defaultText: 'Ось що змінилося!',
        maxChars: 60,
      },
    ],
  },

  // T3 — Problem → Solution
  {
    id: 'problem-solution',
    name: 'Problem → Solution',
    description: 'Проблема + перехід + рішення + CTA.',
    emoji: '💡',
    category: 'promotion',
    platforms: ['tiktok', 'reels'],
    tags: ['business', 'educational', 'trending', 'professional'],
    colorAdjust: { brightness: -0.02, contrast: 1.15, saturation: 1.0 },
    structured: true,
    slots: [
      {
        id: 'problem',
        label: 'Проблема (хук)',
        description: 'Болюча проблема аудиторії',
        startSec: 0,
        endSec: 5,
        position: 'top',
        style: 'hook',
        defaultText: 'Втомився витрачати гроші даремно? 😤',
        maxChars: 60,
      },
      {
        id: 'solution_intro',
        label: 'Перехід',
        description: 'Місток між проблемою і рішенням',
        startSec: 5,
        endSec: 9,
        position: 'center',
        style: 'label',
        defaultText: 'Є простий спосіб...',
        maxChars: 40,
      },
      {
        id: 'solution',
        label: 'Рішення',
        description: 'Основний меседж / рішення',
        startSec: 9,
        endSec: 26,
        position: 'center',
        style: 'point',
        defaultText: 'Ось що реально допомагає',
        maxChars: 60,
      },
      {
        id: 'cta',
        label: 'CTA',
        description: 'Заклик до дії',
        startSec: 26,
        endSec: 9999,
        position: 'bottom',
        style: 'cta',
        defaultText: 'Посилання в біо 👆',
        maxChars: 60,
      },
    ],
  },

  // T4 — 3 Tips / Mistakes
  {
    id: 'three-tips',
    name: '3 Tips / Mistakes',
    description: 'Хук + 3 поради або помилки + CTA.',
    emoji: '🚫',
    category: 'education',
    platforms: ['tiktok', 'reels', 'stories'],
    tags: ['educational', 'trending', 'professional', 'viral'],
    colorAdjust: { brightness: 0.0, contrast: 1.2, saturation: 1.0 },
    structured: true,
    slots: [
      {
        id: 'hook',
        label: 'Хук',
        description: 'Зупиняючий перший кадр',
        startSec: 0,
        endSec: 3,
        position: 'top',
        style: 'hook',
        defaultText: '3 помилки, які руйнують твій контент 🚫',
        maxChars: 60,
      },
      {
        id: 'tip1',
        label: 'Порада / Помилка #1',
        description: 'Перший пункт',
        startSec: 3,
        endSec: 11,
        position: 'center',
        style: 'point',
        defaultText: '❌ Немає чіткого хука',
        maxChars: 60,
      },
      {
        id: 'tip2',
        label: 'Порада / Помилка #2',
        description: 'Другий пункт',
        startSec: 11,
        endSec: 19,
        position: 'center',
        style: 'point',
        defaultText: '❌ Надто довге вступ',
        maxChars: 60,
      },
      {
        id: 'tip3',
        label: 'Порада / Помилка #3',
        description: 'Третій пункт',
        startSec: 19,
        endSec: 27,
        position: 'center',
        style: 'point',
        defaultText: '❌ Немає CTA',
        maxChars: 60,
      },
      {
        id: 'cta',
        label: 'CTA',
        description: 'Заклик підписатися або зберегти',
        startSec: 27,
        endSec: 9999,
        position: 'bottom',
        style: 'cta',
        defaultText: 'Підписуйся щоб не пропустити 🔔',
        maxChars: 60,
      },
    ],
  },

  // T5 — FAQ / Search
  {
    id: 'faq-search',
    name: 'FAQ / Search',
    description: 'Питання яке шукають + відповідь + CTA.',
    emoji: '🔍',
    category: 'education',
    platforms: ['tiktok', 'reels'],
    tags: ['educational', 'tech', 'trending', 'professional'],
    colorAdjust: { brightness: 0.03, contrast: 1.1, saturation: 1.0 },
    structured: true,
    slots: [
      {
        id: 'question',
        label: 'Питання (люди шукають)',
        description: 'Питання з пошуку TikTok/Google',
        startSec: 0,
        endSec: 4,
        position: 'top',
        style: 'hook',
        defaultText: 'Як збільшити охоплення в TikTok? 🤔',
        maxChars: 60,
      },
      {
        id: 'answer',
        label: 'Відповідь',
        description: 'Корисна інформація / відповідь',
        startSec: 4,
        endSec: 25,
        position: 'center',
        style: 'point',
        defaultText: 'Ось що реально працює у 2024',
        maxChars: 80,
      },
      {
        id: 'cta',
        label: 'CTA',
        description: 'Де дізнатись більше',
        startSec: 25,
        endSec: 9999,
        position: 'bottom',
        style: 'cta',
        defaultText: 'Більше порад у профілі ➡️',
        maxChars: 60,
      },
    ],
  },
];

// ── Exports ───────────────────────────────────────────────────────────────────

export function getAllStructuredTemplates(): StructuredTemplate[] {
  return STRUCTURED_TEMPLATES;
}

export function getStructuredTemplateById(id: string): StructuredTemplate | undefined {
  return STRUCTURED_TEMPLATES.find(t => t.id === id);
}

/** Convert a StructuredTemplate into a legacy TemplateConfig shape for backward compat */
function structuredToLegacy(t: StructuredTemplate): TemplateConfig {
  return {
    id: t.id,
    name: t.name,
    format: 'tiktok' as VideoFormat,  // structured templates work for any format
    tags: t.tags,
    description: t.description,
    thumbnail: `https://placehold.co/200x356/1a1a2e/ffffff?text=${encodeURIComponent(t.name)}`,
    ffmpegFilters: {
      colorAdjust: {
        brightness: t.colorAdjust.brightness,
        contrast: t.colorAdjust.contrast,
        saturation: t.colorAdjust.saturation,
      },
    },
    structured: true,
  };
}

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
  // Check legacy templates first
  const legacy = TEMPLATES.find(t => t.id === id);
  if (legacy) return legacy;

  // Fall back to structured templates converted to legacy shape
  const structured = STRUCTURED_TEMPLATES.find(t => t.id === id);
  if (structured) return structuredToLegacy(structured);

  return undefined;
}

export function getAllTemplates(): TemplateConfig[] {
  return TEMPLATES;
}
