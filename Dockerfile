FROM node:22-bookworm-slim

# ffmpeg convierte a WebP; yt-dlp es el respaldo para descargar videos.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages yt-dlp \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

ENV NODE_ENV=production \
    AUTH_DIR=/app/auth_info
VOLUME ["/app/auth_info"]

CMD ["node", "src/index.js"]
