# AI Marketer MVP

AI-powered video marketing app. Upload a video → AI analyzes content → picks the best template → applies it → exports for Stories, Reels, or TikTok.

## Architecture

```
ai-marketer-mvp/
├── mobile/          Expo React Native app (iOS + Android)
│   ├── app/         Expo Router screens
│   │   ├── index.tsx              Welcome screen
│   │   └── (screens)/
│   │       ├── upload.tsx         Step 1 — Pick video
│   │       ├── format.tsx         Step 2 — Stories / Reels / TikTok
│   │       ├── analyzing.tsx      Step 3 — AI analysis (animated)
│   │       ├── templates.tsx      Step 4 — Choose template
│   │       ├── preview.tsx        Step 5 — Preview & apply
│   │       └── export.tsx         Step 6 — Save & share
│   ├── services/api.ts            HTTP client → backend
│   ├── store/useAppStore.ts       Zustand global state
│   └── types/index.ts             Shared TypeScript types
│
└── backend/         Node.js + Express API
    └── src/
        ├── index.ts               Express app entry
        ├── routes/video.ts        REST endpoints
        ├── types/index.ts         TypeScript types
        ├── middleware/
        │   └── errorHandler.ts
        └── services/
            ├── ai/                AI abstraction layer
            │   ├── index.ts       Picks provider from .env
            │   └── providers/
            │       ├── mock.ts    Default (no API key needed)
            │       ├── openai.ts  GPT-4o Vision
            │       └── anthropic.ts  Claude claude-opus-4-7 Vision
            ├── video/
            │   ├── processor.ts   FFmpeg template application
            │   └── frameExtractor.ts  Extract frames for AI
            └── templates/
                └── index.ts       9 built-in templates
```

## Quick Start

### Prerequisites
- Node.js 18+
- [ffmpeg](https://ffmpeg.org/download.html) installed on your system
- Expo Go app on your phone (for mobile dev)

### 1. Backend

```bash
cd backend
npm install

# Copy env file and configure
cp .env.example .env

# Start in dev mode (uses mock AI — no API key needed)
npm run dev
```

Backend runs at `http://localhost:3000`.

### 2. Mobile

```bash
cd mobile
npm install

# Set your backend URL (use your machine's local IP, not localhost)
echo 'EXPO_PUBLIC_API_URL=http://YOUR_LOCAL_IP:3000' > .env

# Start Expo
npx expo start
```

Scan the QR code with **Expo Go** on your phone.

---

## Switching AI Provider

Edit `backend/.env`:

```env
# Use mock AI (default, no key needed)
AI_PROVIDER=mock

# Use OpenAI GPT-4o Vision
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...

# Use Anthropic Claude
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

No code changes needed — the provider is swapped at runtime.

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/video/upload` | Upload video file (multipart/form-data, field: `video`) |
| POST | `/api/video/analyze` | Analyze video `{videoId, format}` |
| POST | `/api/video/process` | Apply template `{videoId, templateId, format}` |
| GET | `/api/video/templates/:format` | List templates for a format |
| GET | `/output/:filename` | Download processed video |
| GET | `/health` | Health check |

---

## Templates

9 built-in templates (3 per format). AI ranks them by content match:

| Format | Templates |
|--------|-----------|
| Stories | Minimal White, Warm Glow, Bold Frame |
| Reels | Neon Gradient, Cinematic Dark, Vibrant Pop |
| TikTok | Neon Pop, Clean TikTok, Retro Vintage |

---

## App Store / Google Play Deployment

### EAS Build (Expo Application Services)

```bash
npm install -g eas-cli
eas login

# iOS (requires Apple Developer account)
eas build --platform ios

# Android
eas build --platform android
```

### Backend Deployment

Deploy to any Node.js host (Railway, Render, Fly.io, etc.):

```bash
# Build TypeScript
npm run build

# Set env vars on your host platform, then:
npm start
```

Update `EXPO_PUBLIC_API_URL` in mobile to your deployed backend URL.

---

## Roadmap (Post-MVP)

- [ ] Real-time processing progress via WebSocket
- [ ] More templates (animated, with music, text overlays)
- [ ] In-app template editor
- [ ] Batch processing
- [ ] User accounts & saved templates
- [ ] Auto-caption generation
- [ ] Background music matching
