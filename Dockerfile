FROM node:20-slim

# ── Static FFmpeg with ALL filters built-in (drawtext, subtitles, libx264, etc.)
# mwader/static-ffmpeg is compiled with --enable-libfreetype, --enable-libass,
# --enable-libx264, --enable-libfdk-aac, and ~100 other codecs/filters.
COPY --from=mwader/static-ffmpeg:latest /ffmpeg /usr/local/bin/ffmpeg
COPY --from=mwader/static-ffmpeg:latest /ffprobe /usr/local/bin/ffprobe

# Install fonts so drawtext can render text (fontfile= path we pass in code)
RUN apt-get update && \
    apt-get install -y --no-install-recommends fonts-dejavu-core && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install backend deps first (layer cache)
COPY backend/package*.json ./backend/
RUN cd backend && npm ci

# Copy everything
COPY . .

# Build TypeScript
RUN npm run build

EXPOSE 3000
ENV NODE_ENV=production

CMD ["npm", "start"]
