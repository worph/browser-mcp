# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

COPY tsconfig.json ./
COPY src/ ./src/

RUN pnpm build

# ── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99
ENV VNC_RESOLUTION=1280x720x24

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    fluxbox \
    supervisor \
    ca-certificates \
    curl \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libgtk-3-0 \
    libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Copy web UI, config, and the fluxbox window-manager rules
COPY web/ ./web/
COPY fluxbox/ /root/.fluxbox/
COPY config.example.json ./config.json
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Install Playwright Chromium with dependencies
RUN npx playwright-core install --with-deps chromium

# Patch noVNC: hide status bar, fix backgrounds and overflow
RUN sed -i 's|<div id="noVNC_status_bar">|<div id="noVNC_status_bar" style="display:none">|' /usr/share/novnc/vnc_lite.html \
    && sed -i 's|</head>|<style>html,body{margin:0;padding:0;overflow:hidden;width:100%;height:100%;background:#000;border-radius:0!important}</style></head>|' /usr/share/novnc/vnc_lite.html

EXPOSE 9746

# /api/health, not /api/status: status only proves this process answers, so a
# Chrome that fails every launch used to report healthy forever. A browser the
# idle reaper stopped on purpose stays healthy; one that cannot start does not.
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -sf -o /dev/null http://localhost:9746/api/health || exit 1

# No VOLUME for /data/chrome-profile, deliberately.
#
# The profile is worth keeping for an interactive browser and the compose file beside this
# Dockerfile names a volume for exactly that. Declaring it here instead did something
# different and unwanted: it gave an *anonymous* volume to every consumer that had decided
# not to have one. Touchstone is one — its sidecar must start cold, because a session cookie
# surviving between audits makes an unprotected app look protected on the one check that
# catches that — and its compose declares no volume, its store listing promises no stored
# profile, and it had a persistent profile anyway from 2026-08-23. A profile that outlives
# the container is also what leaves a `SingletonLock` pointing at a host that no longer
# exists, which `clearSessionState()` exists to clean up after.
#
# Persistence is a decision for whoever runs the image, so it is spelled in a compose file.

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
