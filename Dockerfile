FROM node:20-slim

# Static FFmpeg with ALL filters (drawtext, subtitles/libass, libx264, etc.)
COPY --from=mwader/static-ffmpeg:latest /ffmpeg /usr/local/bin/ffmpeg
COPY --from=mwader/static-ffmpeg:latest /ffprobe /usr/local/bin/ffprobe

# Install fonts for drawtext + shared libs needed at runtime
RUN apt-get update && \
    apt-get install -y --no-install-recommends fonts-dejavu-core && \
    rm -rf /var/lib/apt/lists/*

# Verify FFmpeg works and has required filters — fails build if broken
RUN ffmpeg -version 2>&1 | head -2 && \
    ffmpeg -filters 2>&1 | grep -E "subtitles|ass" | head -5 || \
    (echo "ERROR: subtitles/ass filter not found in FFmpeg!" && exit 1)

WORKDIR /app

COPY backend/package*.json ./backend/
RUN cd backend && npm ci

COPY . .
RUN npm run build

EXPOSE 3000
ENV NODE_ENV=production
CMD ["npm", "start"]
