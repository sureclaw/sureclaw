# AX agent container — trusted-side processes
#
# Used by host, agent-runtime, and pool-controller (different command entrypoints).
#
# Entry points:
#   - Host:            node dist/host/host-process.js
#   - Agent runtime:   node dist/host/agent-runtime-process.js
#   - Pool controller: node dist/pool-controller/main.js

FROM node:22-slim

WORKDIR /opt/ax
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY templates/ ./templates/
COPY skills/ ./skills/

RUN groupadd -r ax && useradd -r -g ax -m ax
USER ax

ENTRYPOINT ["node"]
CMD ["dist/host/host-process.js"]
