ARG BUN_VERSION=1.3.10

FROM oven/bun:${BUN_VERSION}-debian AS build

WORKDIR /app

COPY package.json bun.lock tsconfig.json eslint.config.js ./
COPY packages ./packages
COPY apps ./apps
COPY docker/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh \
  && bun install --frozen-lockfile \
  && bun run build

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY_ID=:99
ENV DESKTOP_WIDTH=1920
ENV DESKTOP_HEIGHT=1080
ENV MT5_DATA_DIR=/data
ENV HOME=/data/home
ENV WINEARCH=win64

RUN dpkg --add-architecture i386 \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    cabextract \
    curl \
    fonts-dejavu-core \
    fonts-liberation \
    libegl1 \
    libgl1 \
    libgl1-mesa-dri \
    libglx-mesa0 \
    libnss3 \
    novnc \
    openbox \
    p7zip-full \
    procps \
    pulseaudio \
    pulseaudio-utils \
    unzip \
    websockify \
    wget \
    wine \
    wine32:i386 \
    wine64 \
    winbind \
    x11vnc \
    xdg-utils \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /usr/local/bin/bun /usr/local/bin/bun
COPY --from=build /entrypoint.sh /entrypoint.sh
COPY --from=build /app /app

EXPOSE 3000 5900 6080

CMD ["/entrypoint.sh"]
