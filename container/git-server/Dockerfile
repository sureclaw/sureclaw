FROM alpine:3.21

# Install git, git-lfs, node.js, and the runtime deps needed by the
# post-receive skills-reconcile hook (openssl for HMAC, curl for the POST,
# busybox's `od` is already present in base).
RUN apk add --no-cache git git-lfs nodejs openssl curl

# Create git user and repo directory
RUN adduser -D -h /home/git -s /bin/sh git && \
    mkdir -p /var/git/repos /var/git/lfs-objects && \
    chown -R git:git /var/git

# Copy entrypoint and HTTP server (+ installer module it requires)
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY http-server.js /usr/local/bin/http-server.js
COPY install-hook.js /usr/local/bin/install-hook.js
RUN chmod +x /usr/local/bin/entrypoint.sh

USER git

EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
