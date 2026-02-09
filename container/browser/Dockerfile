# AX browser container — Playwright + Chromium in isolation
#
# Runs Playwright's Chromium with restricted network egress.
# Host controls domain allowlist via AX_BROWSER_ALLOWED_DOMAINS.
#
# Build:  docker build -t ax/browser -f container/browser/Dockerfile .
# Run:    docker run --rm -it ax/browser

FROM mcr.microsoft.com/playwright:v1.50.0-noble

# Non-root user (playwright image includes pwuser)
USER pwuser

WORKDIR /opt/ax

# Copy only what the browser needs
COPY --chown=pwuser:pwuser package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=pwuser:pwuser dist/ ./dist/
COPY --chown=pwuser:pwuser src/ ./src/

ENTRYPOINT ["node"]
CMD ["dist/providers/browser/container.js"]
