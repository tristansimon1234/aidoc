FROM node:20-slim

# ffmpeg for the existing video pipelines + the system libs Chromium needs
# (Remotion downloads Chromium itself via ensureBrowser, but the binary
# links against these). Keep the apt list trimmed — the image is already
# heavy because of node + chrome.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
      fonts-liberation \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcairo2 \
      libcups2 \
      libdrm2 \
      libgbm1 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .

# Pre-download Chromium during the image build so the first /render-marketing-video
# request doesn't pay the ~150 MB download cost cold. Falls back gracefully on
# build failures so the image still ships if the network is flaky.
RUN node -e "import('@remotion/renderer').then(m => m.ensureBrowser()).catch(e => { console.warn('Browser pre-download failed:', e.message); process.exit(0) })"

EXPOSE 3001
CMD ["node", "server.js"]
