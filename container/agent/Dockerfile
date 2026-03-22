# AX unified agent container — host, agent-runtime, and pool-controller
#
# Single container image replaces the previous 3-image architecture.
# Agents execute tools locally inside the container with a host-side
# audit gate for pre-execution approval.
#
# Entry points:
#   - Host:            node dist/host/server-k8s.js
#   - Agent runtime:   node dist/host/agent-runtime-process.js
#   - Pool controller: node dist/pool-controller/main.js

FROM node:22-slim

# git needed for workspace provisioning (GCS restore, git clone)
RUN apt-get update && apt-get install -y --no-install-recommends git curl jq ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /opt/ax
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY templates/ ./templates/
COPY skills/ ./skills/

RUN groupadd -r ax && useradd -r -g ax -m ax
USER ax

ENTRYPOINT ["node"]
CMD ["dist/host/server-k8s.js"]
