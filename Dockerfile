FROM node:20-slim

# Puppeteer, ffmpeg 의존성 설치
RUN apt-get update && apt-get install -y \
    chromium \
    ffmpeg \
    fonts-noto-cjk \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Puppeteer 환경변수
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# 패키지 설치
COPY package*.json ./
RUN npm install --omit=dev

# 소스 복사
COPY . .

# 포트 설정
EXPOSE 5000

CMD ["node", "server.js"]
