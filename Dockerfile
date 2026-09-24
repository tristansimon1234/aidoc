# Service vidéo (Railway) : ffmpeg + Gemini + voix off. L'interface et l'API sont sur Vercel.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY server ./server
COPY api ./api
COPY worker ./worker
RUN npx tsc -p tsconfig.json && npm prune --omit=dev
ENV NODE_ENV=production
CMD ["node", "dist/worker/index.js"]
