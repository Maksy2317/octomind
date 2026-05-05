FROM node:20-slim

# Install ffmpeg from apt — Debian ffmpeg is compiled with libfreetype (drawtext),
# libass (subtitles filter), and all standard codecs (h264, aac, etc.)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
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
