# Wayselect preview server image (TOG-5738).
#
# Runbook only: building and running this image does NOT activate
# production. See docs/deployment-runbook.md. The preview server is
# fixture-only, dry-run only, with no backend writes.

FROM node:20-slim

ENV NODE_ENV=production

WORKDIR /app

# Install production dependencies first for layer caching, then hand the
# whole tree to the non-root user (root-owned node_modules is readable,
# but chown -R is bulletproof against EACCES on restrictive umasks).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && chown -R node:node /app

# Copy the app (respects .dockerignore) and drop root.
COPY --chown=node:node . .

USER node

EXPOSE 3000

# HOST must be 0.0.0.0 inside the container (the upstream default is
# loopback, which is unreachable from outside the container netns).
ENV PORT=3000 \
    HOST=0.0.0.0

# Flag-independent liveness: unknown paths always answer
# 404 {"error":"not_found"} JSON, preview flag on or off.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'3000')+'/wayselect-healthz').then(r=>{if(r.status!==404)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "web/server.js"]
