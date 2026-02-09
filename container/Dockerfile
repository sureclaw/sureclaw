# Sureclaw agent container image
#
# Runs the agent inside Docker with no network access.
# Host spawns this with --network=none and volume mounts
# for workspace, skills, and IPC socket.

FROM node:22-slim

# Install tsx for running TypeScript directly
RUN npm install -g tsx

# Create non-root user for the agent
RUN groupadd -r agent && useradd -r -g agent -m agent

# Copy project files (node_modules + compiled source)
WORKDIR /opt/sureclaw
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY src/ ./src/

# Run as non-root
USER agent

# Default entrypoint — host overrides command via docker run
ENTRYPOINT ["tsx"]
CMD ["src/container/agent-runner.ts"]
