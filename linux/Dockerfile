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

# WineHQ stable is used instead of Debian Bookworm's Wine 8 package. The
# current WineHQ stable branch is Wine 11, which provides newer Windows APIs
# required by current MT5 builds.
RUN dpkg --add-architecture i386 \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gnupg wget \
  && mkdir -pm755 /etc/apt/keyrings \
  && wget -O - https://dl.winehq.org/wine-builds/winehq.key \
    | gpg --dearmor -o /etc/apt/keyrings/winehq-archive.key \
  && wget -NP /etc/apt/sources.list.d/ \
    https://dl.winehq.org/wine-builds/debian/dists/bookworm/winehq-bookworm.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    awscli \
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
    winehq-stable \
    winbind \
    x11vnc \
    xdg-utils \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /usr/local/bin/bun /usr/local/bin/bun
COPY --from=build /entrypoint.sh /entrypoint.sh
COPY --from=build /app/apps/server/dist /app/apps/server/dist
COPY --from=build /app/apps/web/dist /app/apps/web/dist

EXPOSE 3000 5900 6080

# Surfaces container health via the control API. Generous start period covers
# first-boot Wine prefix creation + unattended MT5 install.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD curl -fsS http://localhost:3000/api/status >/dev/null || exit 1

CMD ["/entrypoint.sh"]
