FROM node:22-bookworm-slim
ENV AGY_CLI_DISABLE_AUTO_UPDATE=true
RUN apt-get update && apt-get install -y --no-install-recommends dbus gnome-keyring libsecret-tools ca-certificates libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcups2 libdrm2 libx11-6 libxext6 libxcb1 libgtk-3-0 libasound2 libnss3 libdbus-glib-1-2 libxtst6 libxrandr2 libgbm1 libxkbcommon0 libpango-1.0-0 libcairo2 libxcomposite1 libxdamage1 libxfixes3 libx11-xcb1 && rm -rf /var/lib/apt/lists/*
COPY scripts/install-cli.mjs /tmp/install-cli.mjs
RUN CLI_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt node /tmp/install-cli.mjs && tar -xzf /tmp/agy.tar.gz -C /tmp antigravity && \
    install -m 0755 /tmp/antigravity /usr/local/bin/agy && \
    rm /tmp/agy.tar.gz /tmp/antigravity /tmp/install-cli.mjs && agy --version
RUN apt-get update && apt-get install -y --no-install-recommends fontconfig fonts-noto-cjk fonts-noto-core fonts-liberation && fc-cache -f && rm -rf /var/lib/apt/lists/*
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
LABEL org.opencontainers.image.title="AI Bridge" \
      org.opencontainers.image.source="https://github.com/318182456/ai-bridge" \
      org.opencontainers.image.version="0.4.0-alpha.22"
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts

RUN chmod 0755 scripts/login-pty.sh && mkdir /data && chown node:node /data
USER node
RUN node scripts/check-keyring-parallel.mjs
ENV DATA_DIR=/data NODE_ENV=production
EXPOSE 18861
HEALTHCHECK --interval=30s --timeout=4s --start-period=15s CMD node -e "fetch('http://127.0.0.1:18861/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","src/server.mjs"]

