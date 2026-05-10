FROM oven/bun:1.3.10-debian

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY_ID=:99
ENV DESKTOP_WIDTH=1920
ENV DESKTOP_HEIGHT=1080
ENV MT5_DATA_DIR=/data
ENV HOME=/data/home

RUN dpkg --add-architecture i386 \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    cabextract \
    curl \
    fonts-dejavu-core \
    fonts-liberation \
    gnupg \
    libnss3 \
    novnc \
    openbox \
    p7zip-full \
    procps \
    pulseaudio \
    unzip \
    websockify \
    wget \
    winbind \
    x11vnc \
    xdg-utils \
    xvfb \
  && mkdir -pm755 /etc/apt/keyrings \
  && wget -O - https://dl.winehq.org/wine-builds/winehq.key | gpg --dearmor -o /etc/apt/keyrings/winehq-archive.key - \
  && . /etc/os-release \
  && case "$VERSION_CODENAME" in \
    trixie) winehq_dist="trixie" ;; \
    bookworm) winehq_dist="bookworm" ;; \
    *) winehq_dist="bookworm" ;; \
  esac \
  && wget -NP /etc/apt/sources.list.d/ "https://dl.winehq.org/wine-builds/debian/dists/${winehq_dist}/winehq-${winehq_dist}.sources" \
  && apt-get update \
  && apt-get install -y --install-recommends winehq-staging \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock tsconfig.json eslint.config.js ./
COPY packages ./packages
COPY apps ./apps
COPY docker/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh \
  && bun install --frozen-lockfile \
  && bun run build

EXPOSE 3000 6080

CMD ["/entrypoint.sh"]
