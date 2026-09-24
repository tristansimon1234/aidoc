# Service vidéo (Railway) : ffmpeg + Gemini + voix off + rendu Remotion (vidéos marketing).
# L'interface et l'API sont sur Vercel.
FROM node:22-bookworm-slim
# ffmpeg, et les bibliothèques du navigateur headless utilisé par Remotion.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates fonts-noto-color-emoji \
    libnss3 libdbus-1-3 libatk1.0-0 libgbm1 libasound2 libxrandr2 libxkbcommon0 libxfixes3 \
    libxcomposite1 libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY server ./server
COPY api ./api
COPY worker ./worker
COPY remotion ./remotion
COPY scripts ./scripts
RUN npx tsc -p tsconfig.json && npm prune --omit=dev
# Bundle Remotion + navigateur headless, une fois pour toutes au build.
RUN node scripts/bundle-remotion.mjs
ENV NODE_ENV=production
CMD ["node", "dist/worker/index.js"]
